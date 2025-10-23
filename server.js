require('dotenv').config();       // Load .env variables
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const socketio = require('socket.io');
const helmet = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { Schema, Types } = require('mongoose');
const bodyParser = require('body-parser'); // moved up so the webhook can use it before express.json()

const app = express();
const server = http.createServer(app);
const io = socketio(server);
app.set('io', io);
app.use((req, _res, next) => { req.io = io; next(); });
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ---- Stripe ----
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

function absoluteUrl(req, path = '/upgrade') {
  const base = `${req.protocol}://${req.get('host')}`;
  return new URL(path, base).href;
}

app.use((req, res, next) => {
  const start = Date.now();
  const url = req.originalUrl;
  let flagged = false;
  const timer = setTimeout(() => { flagged = true; console.warn('[slow] >5s', req.method, url); }, 5000);
  res.on('finish', () => {
    clearTimeout(timer);
    const ms = Date.now() - start;
    console.log(`${req.method} ${url} -> ${res.statusCode} in ${ms}ms${flagged?' [SLOW]':''}`);
  });
  next();
});


const BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:3000';

// ----- Plan helpers (normalize names & fields) -----
const STRIPE_PRICE_ID_ELITE   = process.env.STRIPE_PRICE_ID_ELITE   || process.env.STRIPE_PRICE_ID_EMERALD || '';
const STRIPE_PRICE_ID_PREMIUM = process.env.STRIPE_PRICE_ID_PREMIUM || process.env.STRIPE_PRICE_ID_SILVER  || '';

function planOf(u = {}) {
  const price = String(u.stripePriceId || u.subscriptionPriceId || '');
  if (price && STRIPE_PRICE_ID_ELITE && price === STRIPE_PRICE_ID_ELITE)   return 'elite';
  if (price && STRIPE_PRICE_ID_PREMIUM && price === STRIPE_PRICE_ID_PREMIUM) return 'premium';
  if (u.isPremium) return 'premium'; // legacy boolean
  return 'free';
}
function isElite(u)              { return planOf(u) === 'elite'; }
function isPremiumOrBetter(u)    { const p = planOf(u); return p === 'elite' || p === 'premium'; }

const RTC_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    ...(process.env.TURN_URL ? [{
      urls: [process.env.TURN_URL],
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || ''
    }] : [])
  ]
};

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'no-reply@example.com';

const EMAIL_OTP_TTL_MIN = Number(process.env.EMAIL_OTP_TTL_MIN || 10);
const EMAIL_OTP_LEN = Number(process.env.EMAIL_OTP_LEN || 6);
const EMAIL_OTP_MAX_ATTEMPTS = Number(process.env.EMAIL_OTP_MAX_ATTEMPTS || 5);
const EMAIL_OTP_RESEND_COOLDOWN_SEC = Number(process.env.EMAIL_OTP_RESEND_COOLDOWN_SEC || 60);

// use same secret as phone or a separate one
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'change-me';

let mailer = null;
if (SMTP_HOST) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465, false for 587/25
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

function makeOtp(len = EMAIL_OTP_LEN) {
  let code = '';
  while (code.length < len) code += Math.floor(Math.random() * 10);
  return code.slice(0, len);
}
function hashOtp(otp) {
  return crypto.createHmac('sha256', OTP_HASH_SECRET).update(String(otp)).digest('hex');
}

async function sendEmail(to, subject, html) {
  if (!mailer) {
    console.log(`[DEV EMAIL] to=${to}\nSubject: ${subject}\n${html}`);
    return true;
  }
  try {
    await mailer.sendMail({ from: SMTP_FROM, to, subject, html });
    return true;
  } catch (e) {
    console.error('email send err', e);
    return false;
  }
}

function toInt(v, def = null) {
  if (v == null || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}


// --- tiny helpers used in filters and paging
const toTrimmed = (v) => {
  if (typeof v === 'string') return v.trim();
  if (v == null) return '';
  return String(v).trim();
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => (d * Math.PI) / 180;
  if (
    typeof lat1 !== 'number' || typeof lon1 !== 'number' ||
    typeof lat2 !== 'number' || typeof lon2 !== 'number'
  ) return null;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2)**2;
  return Math.round(R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))) * 10) / 10;
}

// Show a lightning badge if boost has time left (adjust field names to yours)
function computeBoostActive(u, nowMs = Date.now()) {
  if (!u?.boostExpiresAt) return false;
  return new Date(u.boostExpiresAt).getTime() > nowMs;
}


// Fast mutual check for the /matches page using in-memory sets
function buildLikeSets(currentUser) {
  return {
    likedSet:   new Set((currentUser.likes   || []).map(String)),
    likedBySet: new Set((currentUser.likedBy || []).map(String)),
  };
}

function isMutualBySets(userIdStr, likedSet, likedBySet) {
  // Mutual if I liked them AND they liked me (as recorded on me.likedBy)
  return likedSet.has(userIdStr) && likedBySet.has(userIdStr);
}

function isNewBadge({ lastMessage, userCreatedAt }) {
  const now = Date.now();
  const lastTs = lastMessage ? new Date(lastMessage.createdAt).getTime() : 0;
  const newByMsg = lastTs && (now - lastTs) < 48 * 3600e3;   // last message < 48h
  const newByJoin = userCreatedAt && (now - new Date(userCreatedAt).getTime()) < 7 * 24 * 3600e3; // joined < 7d
  return Boolean(newByMsg || newByJoin);
}

async function getLastMessagesByPeer({ meObj, allIds }) {
  const rows = await Message.aggregate([
    {
      $match: {
        deletedFor: { $nin: [meObj] },
        $or: [
          { sender: meObj, recipient: { $in: allIds } },
          { sender: { $in: allIds }, recipient: meObj },
        ],
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $addFields: {
        other: {
          $cond: [{ $eq: ['$sender', meObj] }, '$recipient', '$sender']
        }
      }
    },
    { $group: { _id: '$other', last: { $first: '$$ROOT' } } },
  ]);

  return Object.fromEntries(rows.map(r => [String(r._id), r.last]));
}

// --- Multer Configuration for File Uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage: storage });

const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}


// --- Mongoose Models ---
const User = require('./models/User');
const Message = require('./models/Message');
const Report = require('./models/Report');
const Notification = require('./models/Notification'); // Ensure Notification model is required
const Post = require('./models/Post');
const Comment = require('./models/Comment');
const Quiz = require('./models/Quiz');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is missing. Set it in .env');
  process.exit(1);
}

const isProd = process.env.NODE_ENV === 'production';

mongoose.connect(MONGODB_URI, {
  maxPoolSize: 10,
  minPoolSize: 1,
  serverSelectionTimeoutMS: 15000,
  socketTimeoutMS: 45000,
  // connectTimeoutMS is supported by the driver. Optional:
  connectTimeoutMS: 15000,
  autoIndex: process.env.NODE_ENV !== 'production',  // true in dev, false in prod
  family: 4            // prefer IPv4
})
.then(() => console.log('MongoDB Atlas connected successfully'))
.catch(err => console.error('MongoDB Atlas connection error:', err));

// Sync declared indexes once after connect
mongoose.connection.once('open', async () => {
  try {
    const User         = mongoose.model('User');
    const Message      = mongoose.model('Message');
    const Notification = mongoose.model('Notification');

    const inProd = process.env.NODE_ENV === 'production';
    const opName = inProd ? 'createIndexes' : 'syncIndexes';

    // sequential is gentler on shared tiers
    await User[opName]();         console.log(`[indexes] User ${opName} done`);
    await Message[opName]();      console.log(`[indexes] Message ${opName} done`);
    await Notification[opName](); console.log(`[indexes] Notification ${opName} done`);

    // (optional) list final indexes for User
    const idx = await User.collection.indexes();
    console.log('[indexes] User =>', idx.map(i => i.name));

  } catch (e) {
    console.error('indexes init error', e);
  }
});


mongoose.connection.on('error', err => console.error('Mongo error:', err && err.message ? err.message : err));
mongoose.connection.on('disconnected', () => console.warn('Mongo disconnected'));


// Unread messages (respects soft-delete)
async function getUnreadMessagesCount(userId) {
  try {
    if (!userId || !ObjectId.isValid(userId)) return 0;
    const me = new ObjectId(userId);
    const n = await Message.countDocuments({
      recipient: me,
      read: false,
      deletedFor: { $nin: [me] }
    });
    return n || 0;
  } catch (err) {
    console.error(`Error fetching unread messages for ${userId}:`, err);
    return 0;
  }
}

async function getUnreadNotificationCount(userId) {
  try {
    if (!userId || !ObjectId.isValid(userId)) return 0;
    const me = new ObjectId(userId);
    const n = await Notification.countDocuments({
      recipient: me,
      read: false,
      deletedFor: { $nin: [me] }
    });
    return n || 0;
  } catch (err) {
    console.error(`Error fetching unread notifications for ${userId}:`, err);
    return 0;
  }
}

async function createNotification({ io, recipientId, senderId, type, message, extra = {} }) {
  try {
    if (!recipientId || !ObjectId.isValid(recipientId)) return null;
    const rec = new ObjectId(recipientId);

    // Allowlisted types (keeps schema happy)
    const ALLOWED = new Set(['like', 'match', 'message', 'favorite', 'wave', 'system', 'superlike']);
    const safeType = ALLOWED.has(type) ? type : 'system';

    // minimal sender
    let sender = null;
    if (senderId && ObjectId.isValid(senderId)) {
      sender = await User.findById(senderId)
        .select('_id username profile.photos')
        .lean();
    }

    // persist
    const doc = await Notification.create({
      recipient: rec,
      sender: sender ? sender._id : null,   // nullable for system notices
      type: safeType,
      message,
      extra: extra || {}                    // NOTE: uses "extra", not "data"
    });

    // payload for client
    const payload = {
      _id: String(doc._id),
      type: safeType,
      message,
      sender: sender
        ? { _id: String(sender._id), username: sender.username, avatar: sender.profile?.photos?.[0] || null }
        : null,
      createdAt: doc.createdAt,
      extra: extra || {}
    };

    if (io) {
      // deliver to user's room
      io.to(String(rec)).emit('new_notification', payload);

      // update unread badge (prefer excluding soft-deletes if field exists)
      let unread = 0;
      try {
        unread = await Notification.countDocuments({
          recipient: rec,
          read: false,
          // if you don't have deletedFor in your schema, remove this line:
          deletedFor: { $nin: [rec] }
        });
      } catch {
        // fallback if schema doesn't have deletedFor
        unread = await Notification.countDocuments({ recipient: rec, read: false });
      }
      io.to(String(rec)).emit('notif_update', { unread });
    }

    return doc;
  } catch (error) {
    console.error('Error creating notification:', error);
    return null;
  }
}


// Per-thread unread map (respects soft-delete)
async function getUnreadByThread(userId) {
  const me = new ObjectId(userId);
  const rows = await Message.aggregate([
    { $match: { recipient: me, read: false, deletedFor: { $nin: [me] } } },
    { $group: { _id: '$sender', count: { $sum: 1 } } }
  ]);
  const map = {};
  rows.forEach(r => { map[String(r._id)] = r.count; });
  return map;
}

function computeBoostActive(u, nowMs) {
  if (!u || !u.boostExpiresAt) return false;
  const t = new Date(u.boostExpiresAt).getTime();
  return Number.isFinite(t) && t > nowMs;
}

const limiterDefaults = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.session?.userId
      ? `${ipKeyGenerator(req)}:${req.session.userId}`
      : ipKeyGenerator(req),
};
const DISABLE_LIMITERS = process.env.NO_LIMITS === '1';

const likeLimiter     = DISABLE_LIMITERS ? (req,res,next)=>next() : rateLimit({ ...limiterDefaults, windowMs: 60_000, max: 40 });
const dislikeLimiter  = DISABLE_LIMITERS ? (req,res,next)=>next() : rateLimit({ ...limiterDefaults, windowMs: 60_000, max: 60 });
const boostLimiter    = DISABLE_LIMITERS ? (req,res,next)=>next() : rateLimit({ ...limiterDefaults, windowMs: 60_000, max: 5 });
const messagesLimiter = DISABLE_LIMITERS ? (req,res,next)=>next() : rateLimit({ ...limiterDefaults, windowMs: 60_000, max: 120 });


// For your lightweight analytics (/a) or any other endpoint you want to throttle
const analyticsLimiter = rateLimit({
  ...limiterDefaults,
  windowMs: 60_000,
  max: 120,
});

const HARD_DELETE_DAYS = Number(process.env.HARD_DELETE_DAYS || 30);         // age threshold
const HARD_DELETE_INTERVAL_MS = Number(process.env.HARD_DELETE_INTERVAL_MS || (6 * 60 * 60 * 1000)); // every 6h


if (!global.__hardDeleteJobStarted) {
  global.__hardDeleteJobStarted = true;

  async function runHardDeleteJob() {
    try {
      const DAYS = Number(process.env.HARD_DELETE_DAYS || 30);
      if (!DAYS || DAYS <= 0) {
        console.log('[hard-delete] skipped (HARD_DELETE_DAYS <= 0)');
        return;
      }
      const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

      // 1) Messages: both participants have soft-deleted AND doc is older than cutoff
      const msgResult = await Message.deleteMany({
        createdAt: { $lt: cutoff },
        $expr: {
          $gte: [
            { $size: { $ifNull: ["$deletedFor", []] } }, // <- handle missing field
            2
          ]
        }
      });

      // 2) Notifications (only if you soft-delete them per-recipient)
      let notifResult = { deletedCount: 0 };
      if (Notification && typeof Notification.deleteMany === 'function') {
        notifResult = await Notification.deleteMany({
          createdAt: { $lt: cutoff },
          $expr: {
            $gt: [
              { $size: { $ifNull: ["$deletedFor", []] } }, // any deletedFor entries
              0
            ]
          }
        });
      }

      console.log(
        `[hard-delete] cutoff=${cutoff.toISOString()} messages=${msgResult.deletedCount || 0} notifications=${notifResult.deletedCount || 0}`
      );
    } catch (err) {
      console.error('[hard-delete] error', err);
    }
  }

  // Kick once on boot, then schedule
  runHardDeleteJob();
  const INTERVAL = Number(process.env.HARD_DELETE_INTERVAL_MS || (6 * 60 * 60 * 1000)); // default 6h
  global.__hardDeleteTimer = setInterval(runHardDeleteJob, INTERVAL);
}


// ---- Stripe Webhook (must be BEFORE express.json()) ----
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICE_PREMIUM = STRIPE_PRICE_ID_PREMIUM;
const PRICE_ELITE   = STRIPE_PRICE_ID_ELITE;

function planFromPrice(priceId) {
  if (priceId && String(priceId) === String(PRICE_ELITE))   return 'elite';
  if (priceId && String(priceId) === String(PRICE_PREMIUM)) return 'premium';
  return 'free';
}

app.post('/webhook', require('express').raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId        = session.metadata?.userId || session.client_reference_id || null;
        const subscriptionId = session.subscription;
        const customerId     = session.customer;

        let priceId = null;
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          priceId = sub.items?.data?.[0]?.price?.id || null;
        }
        if (userId) {
          const plan = planFromPrice(priceId) || session.metadata?.plan || 'premium';
          await User.findByIdAndUpdate(userId, {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            stripePriceId: priceId,
            subscriptionPriceId: priceId,
            isPremium: plan !== 'free',
            subscriptionStatus: 'active',
            subscriptionEndsAt: null,
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeSubscriptionId: sub.id });
        if (!user) break;

        const priceId = sub.items?.data?.[0]?.price?.id || user.subscriptionPriceId || null;
        const isActive = ['active', 'trialing', 'past_due'].includes(sub.status);
        const endsAt = (sub.cancel_at_period_end || sub.status === 'canceled')
          ? new Date(sub.current_period_end * 1000)
          : null;

        user.subscriptionStatus = sub.status;
        user.subscriptionEndsAt = endsAt;
        user.isPremium = isActive;
        user.stripePriceId = priceId;
        user.subscriptionPriceId = priceId;
        await user.save();
        break;
      }

      case 'invoice.payment_succeeded': {
        const subscriptionId = event.data.object.subscription;
        const user = await User.findOne({ stripeSubscriptionId: subscriptionId });
        if (user) {
          user.subscriptionStatus = 'active';
          user.subscriptionEndsAt = null;
          user.isPremium = true;
          await user.save();
        }
        break;
      }

      case 'invoice.payment_failed': {
        const subscriptionId = event.data.object.subscription;
        const user = await User.findOne({ stripeSubscriptionId: subscriptionId });
        if (user) {
          user.subscriptionStatus = 'past_due';
          await user.save();
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = await User.findOne({ stripeSubscriptionId: sub.id });
        if (user) {
          user.subscriptionStatus = 'canceled';
          user.subscriptionEndsAt = new Date(sub.current_period_end * 1000);
          user.isPremium = false;
          await user.save();
        }
        break;
      }
      default: /* ignore */ ;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handling error', err);
    res.status(500).end();
  }
});

// add before other app.use(...) and before any async middlewares
// --- fast health before anything else ---
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/ping', (req, res) => res.type('text').send('pong'));


// --- Middleware ---
app.set('trust proxy', 1);

// Body parsers
app.use(express.json());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Views and Static - Views first, then static before routes
app.set('view engine', 'ejs');
// Use absolute path so Node does not depend on cwd
app.set('views', path.join(__dirname, 'views'));

// Serve uploads and public assets before any auth-protected routes
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/js',     express.static(path.join(__dirname, 'public/js')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/css',    express.static(path.join(__dirname, 'public/css')));
// Sessions after trust proxy, before routes
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));


// Middleware to attach full user to req.user
const wantsHTML = (req) => {
  const a = req.headers.accept || '';
  const x = req.headers['x-requested-with'] || '';
  // treat anything under /api as API
  if (req.path.startsWith('/api')) return false;
  // favor HTML if the client prefers HTML and it is not an XMLHttpRequest
  return a.includes('text/html') && !a.includes('application/json') && x !== 'XMLHttpRequest';
};

const checkAuth = async (req, res, next) => {
  try {
    if (!req.session.userId) {
      return wantsHTML(req) ? res.redirect('/login')
                            : res.status(401).json({ error: 'You must be logged in to access this.' });
    }
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return wantsHTML(req) ? res.redirect('/login')
                            : res.status(401).json({ error: 'User not found. Please log in again.' });
    }
    req.user = user;
    next();
  } catch (err) {
    console.error('checkAuth error:', err);
    return wantsHTML(req) ? res.status(500).render('error', { status: 500, message: 'Server error' })
                          : res.status(500).json({ error: 'Server error while authenticating.' });
  }
};


// --- Socket.IO Logic ---
const { Types: { ObjectId } } = require('mongoose');

// simple per-socket rate limit
const MESSAGE_LIMIT_WINDOW_MS = 15_000; // 15s window
const MESSAGE_LIMIT_COUNT = 8;

io.use((socket, next) => {
  const sess = socket.request?.session;
  if (!sess?.userId) return next(new Error('unauthorized'));
  socket.userId = String(sess.userId); // stash normalized userId
  next();
});

function canVideoChat(user) {
  // Example policy: Elite OR Premium with profile.videoChat enabled
  return isElite(user) || (isPremiumOrBetter(user) && user.videoChat === true);
}

// ----- Socket.IO RTC gate (one-time on connect) -----
io.use(async (socket, next) => {
  try {
    const uid = socket.request?.session?.userId;
    if (!uid) return next(new Error('unauthorized'));

    const user = await User.findById(uid)
      .select('isPremium stripePriceId subscriptionPriceId videoChat profile.videoChat')
      .lean();

    if (!user) return next(new Error('unauthorized'));

    const canVideo = canVideoChat(user) || (!!user?.profile?.videoChat === true);

    socket.user         = user;
    socket.userId       = String(uid);
    socket.canVideoChat = !!canVideo;

    // 🔎 helpful one-liner
    console.log(`[rtc] gate uid=${socket.userId} canVideo=${socket.canVideoChat}`);

    return next();
  } catch (e) {
    return next(e);
  }
});

// === Socket.IO: connection handler for BOTH chat + RTC ===
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id} (uid=${socket.userId})`);

  // Use ONE room format everywhere: plain uid
  socket.join(socket.userId);

  // ---- Chat rate-limiting state ----
  socket.data.msgCount = 0;
  socket.data.msgWindowStart = Date.now();

  function isValidId(id) {
    return typeof id === 'string' && ObjectId.isValid(id);
  }

  function checkRateLimit() {
    const now = Date.now();
    if (now - socket.data.msgWindowStart > MESSAGE_LIMIT_WINDOW_MS) {
      socket.data.msgWindowStart = now;
      socket.data.msgCount = 0;
    }
    socket.data.msgCount += 1;
    return socket.data.msgCount <= MESSAGE_LIMIT_COUNT;
  }

  async function emitUnreadUpdate(userId) {
    try {
      if (!ObjectId.isValid(userId)) return;
      const me = new ObjectId(userId);
      const unread = await Message.countDocuments({
        recipient: me,
        read: false,
        deletedFor: { $nin: [me] },
      });
      io.to(userId).emit('unread_update', { unread });
    } catch (e) {
      console.error('unread emit err', e);
    }
  }

  // ---------- Chat events ----------
  socket.on('register_for_notifications', (userId) => {
    try {
      const uid = String(userId || '');
      if (!isValidId(uid)) return;
      socket.join(uid); // join the plain uid
      console.log(`User ${uid} registered on ${socket.id}`);
    } catch (e) {
      console.error('register_for_notifications error', e);
    }
  });

  socket.on('chat:typing', (payload = {}) => {
    try {
      const to = String(payload.to || '');
      if (!isValidId(to)) return;
      io.to(to).emit('chat:typing', { from: socket.userId });
    } catch (e) {
      console.error('typing err', e);
    }
  });

  // OPTIONAL realtime send (still disabled to avoid dupes; you post via HTTP)
  socket.on('chat_message', async (data, ack) => {
    if (process.env.ENABLE_SOCKET_SEND !== '1') {
      if (typeof ack === 'function') ack({ ok: false, error: 'disabled' });
      return;
    }
    try {
      if (!checkRateLimit()) {
        if (typeof ack === 'function') ack({ ok: false, error: 'rate_limited' });
        return;
      }
      const sender    = String(data?.sender || '');
      const recipient = String(data?.recipient || '');
      let content     = (typeof data?.content === 'string' ? data.content : '').trim();
      if (!isValidId(sender) || !isValidId(recipient) || !content) {
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid' });
        return;
      }
      if (content.length > 4000) content = content.slice(0, 4000);

      const newMessage = await Message.create({ sender, recipient, content, read: false });
      io.to(recipient).emit('new_message', newMessage);
      io.to(sender).emit('new_message', newMessage);
      await emitUnreadUpdate(recipient);
      if (typeof ack === 'function') ack({ ok: true, item: newMessage });
    } catch (err) {
      console.error('chat_message err', err);
      if (typeof ack === 'function') ack({ ok: false, error: 'server_error' });
    }
  });

 function guardRTC(handler) {
  return (payload = {}) => {
    if (!socket.canVideoChat) {
      socket.emit('rtc:error', { code: 'upgrade-required', message: 'Upgrade required for video chat.' });
      return;
    }
    handler(payload);
  };
}

socket.on('rtc:call',      guardRTC(({ to, meta }) => {
  if (!to) return;
  console.log(`[rtc] call from=${socket.userId} to=${to}`);
  io.to(String(to)).emit('rtc:incoming', { from: socket.userId, meta: meta || {} });
}));

socket.on('rtc:offer',     guardRTC(({ to, sdp }) => {
  if (!to || !sdp) return;
  io.to(String(to)).emit('rtc:offer', { from: socket.userId, sdp });
}));

socket.on('rtc:answer',    guardRTC(({ to, sdp }) => {
  if (!to || !sdp) return;
  io.to(String(to)).emit('rtc:answer', { from: socket.userId, sdp });
}));

socket.on('rtc:candidate', guardRTC(({ to, candidate }) => {
  if (!to || !candidate) return;
  io.to(String(to)).emit('rtc:candidate', { from: socket.userId, candidate });
}));

socket.on('rtc:end', ({ to, reason }) => {
  if (!to) return;
  io.to(String(to)).emit('rtc:end', { from: socket.userId, reason: reason || 'hangup' });
});

  socket.on('disconnect', () => {
    // optional cleanup/logging
  });
});

const AnalyticsEvent = mongoose.model('AnalyticsEvent', new Schema({
  user: { type: Types.ObjectId, ref: 'User', index: true, sparse: true },
  event: { type: String, required: true, index: true },
  payload: Schema.Types.Mixed,
  path: String,
  ua: String,
  ip: String,
  at: { type: Date, default: Date.now, index: true },
}, { versionKey: false }));


const { body, param, query, validationResult } = require('express-validator');

function validate(req, res, next){
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ ok:false, errors: errors.array() });
  }
  next();
}


// Reusable validators
const validateObjectId = (name='id') => param(name).isMongoId().withMessage(`${name} must be a MongoId`);
const vMessageSend = [
  body('to').isMongoId().withMessage('to must be a MongoId'),
  body('content').isString().trim().isLength({ min:1, max:4000 }).withMessage('content 1..4000'),
  validate
];
const vSetLocation = [
  body('lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (errors.isEmpty()) return next();
    return res.status(400).json({ ok: false, error: 'Validation failed', details: errors.array() });
  }
];

// --- My Profile validators (place near your other validators) ---
const vMyProfile = [
  body('age').optional({ checkFalsy: true }).isInt({ min: 18, max: 99 }).withMessage('Age 18–99'),
  body('gender').optional({ checkFalsy: true }).isIn(['Male','Female','Non-binary']).withMessage('Invalid gender'),
  body('bio').optional({ checkFalsy: true }).isString().trim().isLength({ max: 2000 }).withMessage('Bio too long'),
  body('occupation').optional({ checkFalsy: true }).isString().trim().isLength({ max: 120 }),
  body('interests').optional({ checkFalsy: true }).isString().trim().isLength({ max: 1000 }),
  body('favoriteAfricanArtists').optional({ checkFalsy: true }).isString().trim().isLength({ max: 300 }),
  body('culturalTraditions').optional({ checkFalsy: true }).isString().trim().isLength({ max: 300 }),
  body('relationshipGoals').optional({ checkFalsy: true }).isString().trim().isLength({ max: 300 }),
  validate
];

// expose plan helpers to templates (single source of truth)
app.use((req, res, next) => {
  res.locals.planOf = planOf;
  res.locals.isElite = isElite;
  res.locals.isPremiumOrBetter = isPremiumOrBetter;
  next();
});

app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use((req, res, next) => {
  if (
    req.method === 'POST' &&
    (/^\/(like|dislike|interest|favorite|superlike|api\/(boost|favorites|interest|superlike))\b/.test(req.path))
  ) {
    console.log(`[HIT] ${req.method} ${req.path} CT=${req.headers['content-type'] || '-'} UA=${req.headers['user-agent'] || '-'}`);
  }
  next();
});

app.use(async (req, res, next) => {
  res.locals.currentUser = null;
  res.locals.unreadMessages = 0;
  res.locals.unreadNotificationCount = 0;

  if (!req.session.userId) return next();

  try {
    const currentUser = await User.findById(req.session.userId).lean();
    if (currentUser) {
      res.locals.currentUser = currentUser;
      // keep your real implementations:
      res.locals.unreadMessages = await getUnreadMessagesCount(req.session.userId);
      res.locals.unreadNotificationCount = await getUnreadNotificationCount(req.session.userId);
    }
  } catch (err) {
    console.error('locals user load err:', err);
  }
  next();
});


app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // allow our own scripts + any inline scripts that carry the per-request nonce
      "script-src": [
        "'self'",
        (req, res) => `'nonce-${res.locals.cspNonce}'`
      ],
      // allow Tailwind inline <style> blocks AND Google Fonts stylesheet
      "style-src": [
        "'self'",
        "'unsafe-inline'",
        "https://fonts.googleapis.com"
      ],
      // allow actual font files
      "font-src": [
        "'self'",
        "https://fonts.gstatic.com",
        "data:"
      ],
      // allow your images, data URLs, and HTTPS (for remote avatars/placeholders)
      "img-src": [
        "'self'",
        "data:",
        "https:"
      ],
      // allow the preconnects to Google Fonts hosts (and socket.io)
      "connect-src": [
        "'self'",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "ws",
        "wss"
      ],
      // (optional) if you embed media files via HTTPS
      "media-src": ["'self'", "https:"],
      // (optional) if you frame Stripe’s Checkout or others
      // "frame-src": ["'self'", "https://js.stripe.com"]
    }
  }
}));

// Touch lastActive at most once per minute per user
app.use((req, res, next) => {
  try {
    if (req.session?.userId) {
      const now = Date.now();
      const last = req.session._lastActiveTouch || 0;
      if (now - last > 60_000) {
        req.session._lastActiveTouch = now;
        User.updateOne(
          { _id: req.session.userId },
          { $set: { lastActive: new Date() } }
        ).catch(() => {});
      }
    }
  } catch {}
  next();
});

// --- Global navbar data (counts + streak + likesRemaining) ---
app.use(async (req, res, next) => {
  try {
    if (!req.session?.userId) return next();

    const meId  = req.session.userId;
    const meObj = new mongoose.Types.ObjectId(meId);

    // load just what we need for navbar/streak/likes
    const u = await User.findById(meId)
      .select('username isPremium likesToday lastLikeDate streakDay boostExpiresAt')
      .lean();

    // unread counts (match your dashboard logic incl. soft-delete)
    const [unreadMessages, unreadNotificationCount] = await Promise.all([
      Message.countDocuments({ recipient: meObj, read: false, deletedFor: { $nin: [meObj] } }),
      Notification.countDocuments({ recipient: meObj, read: false }),
    ]);

    // likes remaining (free only)
    const DAILY_LIKE_LIMIT = Number(process.env.DAILY_LIKE_LIMIT || 10);
    let likesRemaining = -1;
    if (u && !u.isPremium) {
      const todayKey = new Date().toDateString();
      const lastKey  = u.lastLikeDate ? new Date(u.lastLikeDate).toDateString() : null;
      const used     = todayKey !== lastKey ? 0 : Number(u.likesToday || 0);
      likesRemaining = Math.max(DAILY_LIKE_LIMIT - used, 0);
    }

    // streak chip
    const streak = {
      day: Number(u?.streakDay || 0),
      target: 7,
      percentage: Math.max(0, Math.min(100, ((Number(u?.streakDay || 0)) / 7) * 100)),
    };

    // make available to all views, including navbar.ejs
    res.locals.currentUser = res.locals.currentUser || u; // don't clobber full user if route already set it
    res.locals.unreadMessages = unreadMessages || 0;
    res.locals.unreadNotificationCount = unreadNotificationCount || 0;
    res.locals.likesRemaining = likesRemaining;
    res.locals.streak = streak;

    next();
  } catch (e) {
    console.error('[nav middleware] err', e);
    next(); // don't block page render if counts fail
  }
});

// --- Routes ---
app.get('/', (req, res) => {
  res.render('index');
});


app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

app.post('/signup', async (req, res) => {
  const { username, email, password, age, gender, bio, location } = req.body;
  try {
    let user = await User.findOne({ email });
    if (user) {
      return res.json({ success: false, message: 'User with that email already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    user = new User({ 
      username, 
      email, 
      password: hashedPassword,
      profile: { age, gender, bio, location, photos: [] }
    });
    await user.save();
    
    req.session.userId = user._id;
    res.json({ success: true, message: 'Account created successfully!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).render('login', { error: 'Invalid credentials' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).render('login', { error: 'Invalid credentials' });
    }
    req.session.userId = user._id;
    return res.redirect(303, '/dashboard');
  } catch (err) {
    console.error(err);
    return res.status(500).render('login', { error: 'Server error. Try again.' });
  }
});


app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).send('Could not log out.');
    }
    res.redirect('/');
  });
});

app.get('/verify-email', checkAuth, async (req, res) => {
  const me = await User.findById(req.session.userId).lean();
  if (!me) return res.redirect('/login');

  const [unreadMessages, unreadNotificationCount] = await Promise.all([
    Message.countDocuments({ recipient: me._id, read: false, deletedFor: { $nin: [me._id] } }),
    Notification.countDocuments({ recipient: me._id, read: false }),
  ]);

  // if you already have an email saved, jump to "code" step
  const state = req.query.state || (me.email ? 'code' : 'enter');
  res.render('verify-email', {
    currentUser: me,
    unreadMessages,
    unreadNotificationCount,
    state,
    flash: req.query.msg || null,
  });
});

app.post('/verify-email/request', checkAuth, async (req, res) => {
  try {
    const me = await User.findById(req.session.userId);
    if (!me) return res.redirect('/login');

    const rawEmail = String(req.body.email || me.email || '').trim().toLowerCase();
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail);
    if (!valid) return res.redirect('/verify-email?state=enter&msg=Invalid+email');

    // Cooldown
    const now = Date.now();
    const last = me.emailOtpRequestedAt ? me.emailOtpRequestedAt.getTime() : 0;
    if (now - last < EMAIL_OTP_RESEND_COOLDOWN_SEC * 1000) {
      return res.redirect('/verify-email?state=code&msg=Please+wait+before+resending');
    }

    const otp = makeOtp();
    const ok = await sendEmail(
      rawEmail,
      'Your verification code',
      `<p>Your verification code is:</p><p style="font-size:20px"><b>${otp}</b></p><p>This code expires in ${EMAIL_OTP_TTL_MIN} minutes.</p>`
    );
    if (!ok) return res.redirect('/verify-email?state=enter&msg=Failed+to+send+email');

    me.email = rawEmail; // save email if not set
    me.emailOtpHash = hashOtp(otp);
    me.emailOtpExpiresAt = new Date(now + EMAIL_OTP_TTL_MIN * 60 * 1000);
    me.emailOtpAttempts = 0;
    me.emailOtpRequestedAt = new Date(now);
    me.emailOtpLastIP = req.ip;
    await me.save();

    return res.redirect('/verify-email?state=code&msg=Code+sent');
  } catch (e) {
    console.error('email otp request err', e);
    return res.redirect('/verify-email?state=enter&msg=Server+error');
  }
});

app.post('/verify-email/confirm', checkAuth, async (req, res) => {
  try {
    const me = await User.findById(req.session.userId);
    if (!me) return res.redirect('/login');

    if (!me.email || !me.emailOtpHash) {
      return res.redirect('/verify-email?state=enter&msg=Please+request+a+code+first');
    }

    if ((me.emailOtpAttempts || 0) >= EMAIL_OTP_MAX_ATTEMPTS) {
      return res.redirect('/verify-email?state=code&msg=Too+many+attempts.+Request+a+new+code');
    }
    const now = Date.now();
    if (!me.emailOtpExpiresAt || now > me.emailOtpExpiresAt.getTime()) {
      return res.redirect('/verify-email?state=code&msg=Code+expired.+Request+new+code');
    }

    const code = String(req.body.code || '').replace(/[^\d]/g, '');
    if (!code || code.length < 4) {
      me.emailOtpAttempts = (me.emailOtpAttempts || 0) + 1;
      await me.save();
      return res.redirect('/verify-email?state=code&msg=Invalid+code');
    }

    if (me.emailOtpHash !== hashOtp(code)) {
      me.emailOtpAttempts = (me.emailOtpAttempts || 0) + 1;
      await me.save();
      return res.redirect('/verify-email?state=code&msg=Incorrect+code');
    }

    // Success
    me.emailVerifiedAt = new Date();
    me.emailOtpHash = null;
    me.emailOtpExpiresAt = null;
    me.emailOtpAttempts = 0;
    await me.save();

    return res.redirect('/verify-email?state=done&msg=Email+verified');
  } catch (e) {
    console.error('email otp confirm err', e);
    return res.redirect('/verify-email?state=code&msg=Server+error');
  }
});

// put near your static routes
app.get('/socket.io/socket.io.js', (req, res) => res.redirect(301, '/js/socket.io.js'));

app.get('/favicon.ico', (req, res) => res.status(204).end());

// --- RTC config (STUN/TURN) ---
app.get('/api/rtc/config', checkAuth, (req, res) => {
  // default Google STUN + optional TURN from env
  const iceServers = [];

  // public STUN
  iceServers.push({ urls: ['stun:stun.l.google.com:19302'] });

  // optional TURN (set in .env when you have a TURN service)
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(s => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.json({ rtc: { iceServers } });
});

// /profile route
app.get('/profile', checkAuth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.session.userId).lean();
    if (!currentUser) return res.status(404).send('User not found');

    const success = req.query.payment === 'success'
      ? 'Subscription successful! You are now a Premium Member.'
      : null;

    const unreadNotificationCount = await Notification.countDocuments({
      recipient: currentUser._id,
      read: false,
    });
    const unreadMessages = await Message.countDocuments({
      recipient: currentUser._id,
      read: false,
    });

    // Render **my-profile.ejs** (not profile.ejs)
    res.render('my-profile', {
      currentUser,
      success,
      unreadNotificationCount,
      unreadMessages
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});


// View another user's profile
app.get('/users/:id', checkAuth, async (req, res) => {
  try {
    const currentUserId = req.session.userId;
    const profileId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(profileId)) {
      return res.status(400).send('Invalid user ID');
    }

    const [currentUser, user] = await Promise.all([
      User.findById(currentUserId).lean(),
      User.findById(profileId).lean(),
    ]);

    if (!currentUser || !user) {
      return res.status(404).send('User not found');
    }

    // Flash message from subscription redirect
    const successMessage = req.query.payment === 'success' 
      ? 'Subscription successful! You are now a Premium Member.' 
      : null;

    // Check like/match/block status
    const hasLiked = currentUser.likes?.includes(profileId);
    const hasBeenLikedBy = user.likes?.includes(currentUserId);
    const isMatched = hasLiked && hasBeenLikedBy;
    const isBlocked = currentUser.blockedUsers?.includes(profileId);

    // Notifications + messages
    const unreadNotificationCount = await Notification.countDocuments({
      recipient: currentUserId,
      read: false,
    });

    const unreadMessages = await Message.countDocuments({
      recipient: currentUserId,
      read: false,
    });

    res.render('profile', {
      currentUser,
      user,
      isMatched,
      isBlocked,
      hasLiked,
      unreadNotificationCount: unreadNotificationCount || 0,
      unreadMessages: unreadMessages || 0,
      successMessage // ✅ fixed name
    });
  } catch (err) {
    console.error('Error loading profile:', err);
    res.status(500).send('Server Error');
  }
});

// --- GET: My Profile page ---
app.get('/my-profile', checkAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.redirect('/login');

    return res.render('my-profile', {
      currentUser: user,
      // if you redirect with ?updated=1 or ?upgrade=1 these flags will show toasts/alerts if you want
      success: req.query.updated === '1',
      upgradeSuccess: req.query.upgrade === '1'
    });
  } catch (e) {
    console.error('GET /my-profile error', e);
    return res.status(500).render('error', { status: 500, message: 'Failed to load profile.' });
  }
});

// --- POST: Save profile fields + handle up to 4 photos ---
// The form uses multiple <input name="photos">, so use array()
app.post('/my-profile', checkAuth, upload.array('photos', 8), vMyProfile, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.redirect('/login');

    // Normalize body fields
    const bio   = toTrimmed(req.body.bio);
    const age   = toInt(req.body.age);
    const gender = toTrimmed(req.body.gender);
    const occupation = toTrimmed(req.body.occupation);
    const interestsStr = toTrimmed(req.body.interests);
    const favoriteAfricanArtists = toTrimmed(req.body.favoriteAfricanArtists);
    const culturalTraditions     = toTrimmed(req.body.culturalTraditions);
    const relationshipGoals      = toTrimmed(req.body.relationshipGoals);

    // Ensure profile object exists
    user.profile = user.profile || {};

    if (bio) user.profile.bio = bio;
    if (age != null) user.profile.age = age;
    if (gender) user.profile.gender = gender;
    if (occupation) user.profile.occupation = occupation;

    // Interests: comma-separated -> array of trimmed unique values
    if (interestsStr) {
      user.profile.interests = interestsStr
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
    }

    if (favoriteAfricanArtists) user.profile.favoriteAfricanArtists = favoriteAfricanArtists;
    if (culturalTraditions)     user.profile.culturalTraditions     = culturalTraditions;
    if (relationshipGoals)      user.profile.relationshipGoals      = relationshipGoals;

    // Photos handling
    user.profile.photos = Array.isArray(user.profile.photos) ? user.profile.photos : [];
    const files = Array.isArray(req.files) ? req.files : [];

    // For each uploaded file, push into photos (max 12 for storage; show top 4 in UI)
    for (const f of files) {
      // f.path like "uploads/123.jpg" -> serve at "/uploads/123.jpg"
      const publicPath = '/' + String(f.path).replace(/\\/g, '/');
      // Avoid duplicates
      if (!user.profile.photos.includes(publicPath)) {
        user.profile.photos.push(publicPath);
      }
    }
    // Optional: keep only first 12 photos stored
    if (user.profile.photos.length > 12) {
      user.profile.photos = user.profile.photos.slice(0, 12);
    }

    await user.save();

    // Redirect so the page reloads (and avoids resubmitting the form on refresh)
    return res.redirect('/my-profile?updated=1');
  } catch (e) {
    console.error('POST /my-profile error', e);
    return res.status(500).render('error', { status: 500, message: 'Failed to save profile.' });
  }
});


app.get('/edit-profile', checkAuth, async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);

        // Fetch the count of unread notifications
        const unreadNotificationCount = await Notification.countDocuments({ 
            recipient: req.session.userId, 
            read: false 
        });

        // Fetch the count of unread messages for the navbar
        const unreadMessages = await Message.countDocuments({
            recipient: req.session.userId,
            read: false,
        });

        res.render('edit-profile', { 
            currentUser, 
            unreadNotificationCount, 
            unreadMessages,
            error: null // <-- Initialize the error variable
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});


// Helper function to handle empty strings for enum fields
const getValidEnumValue = (value) => {
    return value === '' ? undefined : value;
};

app.post('/edit-profile', checkAuth, async (req, res) => {
    try {
        const {
            username, gender, bio, location,
            firstName, birthMonth, birthYear, country, stateProvince, city,
            hairColor, eyeColor, height, weight, bodyType, ethnicity,
            appearanceRating, drinks, smokes, maritalStatus, hasChildren,
            numberOfChildren, oldestChildAge, youngestChildAge, wantsMoreChildren,
            occupation, employmentStatus, annualIncome, livingSituation,
            willingToRelocate, nationality, educationLevel, englishAbility, frenchAbility,
            religion, religiousValues, polygamy, starSign, profileHeading,
            aboutYourself, lookingForInPartner,
            // NEW: Hobbies & Interests
            hobbiesInterests,
            // NEW: Personality Questions
            earlyBirdNightOwl, stressHandling, idealWeekend, humorImportance,
            plannerSpontaneous, favoriteMusic, favoriteBookGenre, favoriteMovieGenre,
            enjoyCooking, travelImportance, stayActive, pdaComfort,
            communicationStyle, disagreementHandling, loveLanguage, introvertExtrovert,
            familyImportance, idealDate, tryingNewThings, biggestPetPeeve
        } = req.body;

        const currentUser = await User.findById(req.session.userId);
        
        // Handle multi-select fields (arrays)
        const bodyArt = Array.isArray(req.body.bodyArt) ? req.body.bodyArt : (req.body.bodyArt ? [req.body.bodyArt] : []);
        const pets = Array.isArray(req.body.pets) ? req.body.pets : (req.body.pets ? [req.body.pets] : []);
        const relationshipLookingFor = Array.isArray(req.body.relationshipLookingFor) ? req.body.relationshipLookingFor : (req.body.relationshipLookingFor ? [req.body.relationshipLookingFor] : []);
        const languagesSpoken = Array.isArray(req.body.languagesSpoken) ? req.body.languagesSpoken : (req.body.languagesSpoken ? [req.body.languagesSpoken] : []);
        const parsedHobbiesInterests = Array.isArray(hobbiesInterests) ? hobbiesInterests : (hobbiesInterests ? [hobbiesInterests] : []);

        const updateData = {
            username: getValidEnumValue(username), // Apply helper for username too if it can be empty
            'profile.firstName': getValidEnumValue(firstName),
            'profile.gender': getValidEnumValue(gender),
            'profile.bio': getValidEnumValue(bio),
            'profile.location': getValidEnumValue(location), // This is the general location field
            'profile.birthMonth': getValidEnumValue(birthMonth),
            'profile.birthYear': birthYear ? parseInt(birthYear) : undefined,
            'profile.country': getValidEnumValue(country),
            'profile.stateProvince': getValidEnumValue(stateProvince),
            'profile.city': getValidEnumValue(city),
            'profile.hairColor': getValidEnumValue(hairColor),
            'profile.eyeColor': getValidEnumValue(eyeColor),
            'profile.height': getValidEnumValue(height),
            'profile.weight': getValidEnumValue(weight),
            'profile.bodyType': getValidEnumValue(bodyType),
            'profile.ethnicity': getValidEnumValue(ethnicity),
            'profile.bodyArt': bodyArt, // Arrays are handled differently
            'profile.appearanceRating': getValidEnumValue(appearanceRating),
            'profile.drinks': getValidEnumValue(drinks),
            'profile.smokes': getValidEnumValue(smokes),
            'profile.maritalStatus': getValidEnumValue(maritalStatus),
            'profile.hasChildren': getValidEnumValue(hasChildren),
            'profile.numberOfChildren': numberOfChildren ? parseInt(numberOfChildren) : undefined,
            'profile.oldestChildAge': oldestChildAge ? parseInt(oldestChildAge) : undefined,
            'profile.youngestChildAge': youngestChildAge ? parseInt(youngestChildAge) : undefined,
            'profile.wantsMoreChildren': getValidEnumValue(wantsMoreChildren),
            'profile.pets': pets, // Arrays are handled differently
            'profile.occupation': getValidEnumValue(occupation),
            'profile.employmentStatus': getValidEnumValue(employmentStatus),
            'profile.annualIncome': getValidEnumValue(annualIncome),
            'profile.livingSituation': getValidEnumValue(livingSituation),
            'profile.willingToRelocate': getValidEnumValue(willingToRelocate),
            'profile.relationshipLookingFor': relationshipLookingFor, // Arrays are handled differently
            'profile.nationality': getValidEnumValue(nationality),
            'profile.educationLevel': getValidEnumValue(educationLevel),
            'profile.languagesSpoken': languagesSpoken, // Arrays are handled differently
            'profile.englishAbility': getValidEnumValue(englishAbility),
            'profile.frenchAbility': getValidEnumValue(frenchAbility),
            'profile.religion': getValidEnumValue(religion),
            'profile.religiousValues': getValidEnumValue(religiousValues),
            'profile.polygamy': getValidEnumValue(polygamy),
            'profile.starSign': getValidEnumValue(starSign),
            'profile.profileHeading': getValidEnumValue(profileHeading),
            'profile.aboutYourself': getValidEnumValue(aboutYourself),
            'profile.lookingForInPartner': getValidEnumValue(lookingForInPartner),
            // NEW: Hobbies & Interests
            'profile.hobbiesInterests': parsedHobbiesInterests,
            // NEW: Personality Questions
            'profile.earlyBirdNightOwl': getValidEnumValue(earlyBirdNightOwl),
            'profile.stressHandling': getValidEnumValue(stressHandling),
            'profile.idealWeekend': getValidEnumValue(idealWeekend),
            'profile.humorImportance': getValidEnumValue(humorImportance),
            'profile.plannerSpontaneous': getValidEnumValue(plannerSpontaneous),
            'profile.favoriteMusic': getValidEnumValue(favoriteMusic),
            'profile.favoriteBookGenre': getValidEnumValue(favoriteBookGenre),
            'profile.favoriteMovieGenre': getValidEnumValue(favoriteMovieGenre),
            'profile.enjoyCooking': getValidEnumValue(enjoyCooking),
            'profile.travelImportance': getValidEnumValue(travelImportance),
            'profile.stayActive': getValidEnumValue(stayActive),
            'profile.pdaComfort': getValidEnumValue(pdaComfort),
            'profile.communicationStyle': getValidEnumValue(communicationStyle),
            'profile.disagreementHandling': getValidEnumValue(disagreementHandling),
            'profile.loveLanguage': getValidEnumValue(loveLanguage),
            'profile.introvertExtrovert': getValidEnumValue(introvertExtrovert),
            'profile.familyImportance': getValidEnumValue(familyImportance),
            'profile.idealDate': getValidEnumValue(idealDate),
            'profile.tryingNewThings': getValidEnumValue(tryingNewThings),
            'profile.biggestPetPeeve': getValidEnumValue(biggestPetPeeve)
        };

        // Calculate age from birthYear
        if (birthYear) {
            updateData['profile.age'] = new Date().getFullYear() - parseInt(birthYear);
        }

        // Note: Photo uploads are now handled by the /photos route
        // This route will only save other profile data.

        await User.findByIdAndUpdate(req.session.userId, updateData, { new: true, runValidators: true });
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

// --- NEW PHOTO GALLERY ROUTES ---
app.get('/photos', checkAuth, async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        
        // Fetch the count of unread notifications
        const unreadNotificationCount = await Notification.countDocuments({
            recipient: req.session.userId,
            read: false
        });

        // Fetch the count of unread messages for the navbar
        const unreadMessages = await Message.countDocuments({
            recipient: req.session.userId,
            read: false,
        });

        // Pass the user's photos to the template
        const userPhotos = currentUser.profile.photos;

        res.render('photos', {
            currentUser,
            unreadNotificationCount,
            unreadMessages,
            userPhotos // <-- Now passing this variable
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/photos/upload', checkAuth, upload.array('profilePhotos', 5), async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        const files = req.files;

        if (!files || files.length === 0) {
            return res.status(400).json({ status: 'error', message: 'No photos were uploaded.' });
        }

        const photoUrls = files.map(file => `/uploads/${file.filename}`);

        currentUser.profile.photos.push(...photoUrls);
        if (currentUser.profile.photos.length > 5) {
            currentUser.profile.photos = currentUser.profile.photos.slice(-5); // Keep only the last 5 photos
        }

        await currentUser.save();
        res.json({ status: 'success', message: 'Photos uploaded successfully!' });
    } catch (err) {
        console.error('Error uploading photos:', err);
        res.status(500).json({ status: 'error', message: 'Failed to upload photos.' });
    }
});

app.post('/photos/delete/:photoIndex', checkAuth, async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        const photoIndex = parseInt(req.params.photoIndex);
        
        if (photoIndex < 0 || photoIndex >= currentUser.profile.photos.length) {
            return res.status(400).json({ status: 'error', message: 'Invalid photo index.' });
        }

        const photoPath = currentUser.profile.photos[photoIndex];
        
        currentUser.profile.photos.splice(photoIndex, 1);
        await currentUser.save();
        
        fs.unlink(photoPath, (err) => {
            if (err) {
                console.error('Error deleting photo file from disk:', err);
            }
        });
        
        res.json({ status: 'success', message: 'Photo deleted successfully.' });
    } catch (err) {
        console.error('Error deleting photo:', err);
        res.status(500).json({ status: 'error', message: 'Failed to delete photo.' });
    }
});


app.post('/delete-photo/:photoIndex', checkAuth, async (req, res) => {
    try {
        const currentUser = await User.findById(req.session.userId);
        const photoIndex = req.params.photoIndex;
        
        if (photoIndex < 0 || photoIndex >= currentUser.profile.photos.length) {
            return res.status(400).json({ error: 'Invalid photo index.' });
        }

        const photoPath = currentUser.profile.photos[photoIndex];
        
        currentUser.profile.photos.splice(photoIndex, 1);
        await currentUser.save();
        
        fs.unlink(photoPath, (err) => {
            if (err) {
                console.error('Error deleting photo file:', err);
            }
        });
        
        res.status(200).json({ message: 'Photo deleted successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

app.post('/unmatch/:id', checkAuth, async (req, res) => {
  try {
    const currentUserId = req.session.userId;
    const chatUserId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(chatUserId)) {
      return res.status(400).json({ status: 'error', message: 'Invalid user ID' });
    }

    const [currentUser, chatUser] = await Promise.all([
      User.findById(currentUserId),
      User.findById(chatUserId),
    ]);

    if (!currentUser || !chatUser) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    currentUser.likes = currentUser.likes.filter(id => id.toString() !== chatUserId);
    chatUser.likedBy = chatUser.likedBy.filter(id => id.toString() !== currentUserId);
    await Promise.all([currentUser.save(), chatUser.save()]);

    await Message.deleteMany({
      $or: [
        { sender: currentUserId, recipient: chatUserId },
        { sender: chatUserId, recipient: currentUserId },
      ],
    });

    res.json({ status: 'success', message: 'Unmatched successfully!' });
  } catch (err) {
    console.error('Error unmatching:', err);
    res.status(500).json({ status: 'error', message: 'Failed to unmatch.' });
  }
});

app.post('/block/:id', checkAuth, async (req, res) => {
    try {
        const currentUserId = req.session.userId;
        const blockUserId = req.params.id;

        await User.findByIdAndUpdate(currentUserId, { $push: { blockedUsers: blockUserId } });
        await User.findByIdAndUpdate(currentUserId, { $pull: { likes: blockUserId } });
        await User.findByIdAndUpdate(blockUserId, { $pull: { likes: currentUserId } });

        res.json({ status: 'success', message: 'User blocked successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: 'Server Error' });
    }
});

// --- helper: compute "is online" from lastActive (5m window)
function isOnlineFrom(lastActive) {
  if (!lastActive) return false;
  return (Date.now() - new Date(lastActive).getTime()) < 5 * 60 * 1000;
}

// --- PAGE: /matches (mutual matches, unread counts, last message)
app.get('/matches', checkAuth, async (req, res) => {
  try {
    const meId  = req.session.userId;
    const meObj = new mongoose.Types.ObjectId(meId);

    const currentUser = await User.findById(meId)
      .select('likes likedBy')
      .lean();
    if (!currentUser) return res.redirect('/login');

    // Build sets from current user (fast, in-memory)
    const { likedSet, likedBySet } = buildLikeSets(currentUser);
    const allIdsStr = [...new Set([...likedSet, ...likedBySet])];

    let cards = [];
    if (allIdsStr.length) {
      const allIds = allIdsStr.map(id => new mongoose.Types.ObjectId(id));

      // Pull user cards (no per-user likes needed since we rely on currentUser.likedBy)
      const users = await User.find({ _id: { $in: allIds } })
        .select('username createdAt verifiedAt lastActive profile.photos profile.age profile.city profile.country')
        .lean();

      // Unread per thread (exclude my soft-deletes)
      const unreadRows = await Message.aggregate([
        {
          $match: {
            recipient: meObj,
            read: false,
            sender: { $in: allIds },
            deletedFor: { $nin: [meObj] }
          }
        },
        { $group: { _id: '$sender', count: { $sum: 1 } } }
      ]);
      const unreadBy = Object.fromEntries(unreadRows.map(r => [String(r._id), r.count]));

      // Last message per pair (single query; exclude my soft-deletes)
      const lastBy = await getLastMessagesByPeer({ meObj, allIds });

      // Build cards + flags
      cards = users.map(u => {
        const idStr = String(u._id);
        const last  = lastBy[idStr] || null;

        const isMutual    = isMutualBySets(idStr, likedSet, likedBySet);
        const likedMeOnly = !likedSet.has(idStr) && likedBySet.has(idStr);
        const iLikedOnly  = likedSet.has(idStr) && !likedBySet.has(idStr);

        const lastMessage = last ? {
          content:   last.content,
          createdAt: last.createdAt,
          mine:      String(last.sender) === String(meId),
        } : null;

        const isNew = isNewBadge({ lastMessage, userCreatedAt: u.createdAt });

        return {
          ...u,
          isMutual, likedMeOnly, iLikedOnly, isNew,
          unreadCount: unreadBy[idStr] || 0,
          lastMessage
        };
      }).sort((a, b) => {
        // Sort: most recent last message first; then mutuals; then username
        const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
        const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
        return tb - ta || (b.isMutual - a.isMutual) || a.username.localeCompare(b.username);
      });
    }

    const [unreadMessages, unreadNotificationCount] = await Promise.all([
      Message.countDocuments({ recipient: meObj, read: false, deletedFor: { $nin: [meObj] } }),
      Notification.countDocuments({ recipient: meObj, read: false }),
    ]);

    return res.render('matches', {
      currentUser,
      matches: cards,
      unreadMessages,
      unreadNotificationCount
    });
  } catch (err) {
    console.error('matches page err', err);
    return res.status(500).render('error', { status: 500, message: 'Failed to load matches.' });
  }
});

// --- Premium gating for filters (shared by /dashboard and /advanced-search) ---
const FREE_MAX_RADIUS_KM = Number(process.env.FREE_MAX_RADIUS_KM || 25);

function clampFiltersByPlan(filters, user) {
  const out = { ...filters };
  const locks = { /* existing locks... */ videoChat:false };

  if (!isElite(user)) {
    // keep checkbox for UX, but make it a soft preference (no strict filter)
    if (out.videoChat === '1') {
      // comment the next line if you want *soft* boost only:
      // out.videoChat = ''; 
      locks.videoChat = true; // show a tiny lock chip in UI
    }
  }
  return { filters: out, locks };
}


function clampFiltersForFree(raw, isPremium) {
  // raw is typically req.query
  const out = { ...raw };
  const locks = {
    minPhotos: false,
    languages: false,
    lifestyle: false,   // education/smoking/drinking
    radius:    false,
    distanceSort: false,
  };

  if (!isPremium) {
    // Hide/strip premium-only knobs for free users
    if ((+out.minPhotos || 0) > 1) { out.minPhotos = ''; locks.minPhotos = true; }
    if (out.languages && String(out.languages).trim() !== '') { out.languages = ''; locks.languages = true; }
    if (out.education) { out.education = ''; locks.lifestyle = true; }
    if (out.smoking)   { out.smoking   = ''; locks.lifestyle = true; }
    if (out.drinking)  { out.drinking  = ''; locks.lifestyle = true; }

    const r = +out.radiusKm || 0;
    if (r > FREE_MAX_RADIUS_KM) { out.radiusKm = String(FREE_MAX_RADIUS_KM); locks.radius = true; }

    if (out.sort === 'distance') { out.sort = 'active'; locks.distanceSort = true; }
  }

  return { filters: out, locks };
}

const CALL_COOLDOWN_MS = Number(process.env.CALL_COOLDOWN_MS || (30 * 60 * 1000)); // 30 min
const __lastCallTry = new Map(); // key `${me}:${other}` -> ts

// Request a video call (Elite can initiate; Premium can accept later)
app.post('/api/call/request/:id', checkAuth, async (req, res) => {
  try {
    const me    = await User.findById(req.session.userId)
      .select('_id username createdAt verifiedAt stripePriceId subscriptionPriceId isPremium videoChat')
      .lean();
    const other = await User.findById(req.params.id)
      .select('_id username verifiedAt videoChat')
      .lean();

    if (!me || !other) return res.status(404).json({ ok:false });

    // Gate: only Elite initiates
    if (!isElite(me)) return res.status(402).json({ ok:false, error:'elite_required' });

    // Safety: both verified + my account age >= 48h + recipient opted-in
    const ageOk = me.createdAt && (Date.now() - new Date(me.createdAt).getTime() > 48*3600*1000);
    if (!ageOk || !me.verifiedAt || !other.verifiedAt || !other?.videoChat) {
      return res.status(400).json({ ok:false, error:'not_allowed' });
    }

    // Cooldown per pair
    const key = `${me._id}:${other._id}`;
    const now = Date.now();
    if (__lastCallTry.has(key) && now - __lastCallTry.get(key) < CALL_COOLDOWN_MS) {
      return res.status(429).json({ ok:false, error:'cooldown' });
    }
    __lastCallTry.set(key, now);

    // Notify recipient (socket + Notification)
    const ioRef = req.io || req.app?.get?.('io') || (typeof io !== 'undefined' ? io : null);

    // Use 'system' to avoid enum mismatch; if your enum has 'call_request', switch to that.
    if (typeof createNotification === 'function') {
      await createNotification({
        io: ioRef,
        recipientId: other._id,
        senderId: me._id,
        type: 'system',
        message: 'wants to start a video chat 📹',
        extra: { link: `/messages?with=${me._id}` }
      });
    }

    // Socket ring (recipient must have joined their userId room — your code already does)
    ioRef?.to(String(other._id)).emit('rtc:ring', {
      from: { _id: String(me._id), username: me.username }
    });

    return res.json({ ok:true });
  } catch (e) {
    console.error('call request err', e);
    return res.status(500).json({ ok:false });
  }
});

// ---- GET - Advanced Search (mirrors /dashboard filters + gating) ----
app.get('/advanced-search', checkAuth, async (req, res) => {
  try {
    // We need blockedUsers (exclude), lat/lng (distance), and plan fields (gating)
    const currentUser = await User.findById(req.session.userId)
      .select('blockedUsers profile.lat profile.lng isPremium stripePriceId subscriptionPriceId')
      .lean();

    if (!currentUser) return res.redirect('/login');

    // -- Helpers (local sanitizers) --
    const ALLOWED_GENDERS = new Set(['Any', 'Male', 'Female', 'Non-binary']);
    const normGender = (g) => {
      const map = { Man: 'Male', Woman: 'Female', 'Nonbinary': 'Non-binary', 'Non binary': 'Non-binary' };
      const val = (g || 'Any').trim();
      const mapped = map[val] || val;
      return ALLOWED_GENDERS.has(mapped) ? mapped : 'Any';
    };
    const safeRegex = (s) => {
      if (!s) return null;
      try { return new RegExp(String(s), 'i'); } catch { return null; }
    };

    // 1) Collect incoming query in the same shape as /dashboard
    const rawFilters = {
      seekingGender : normGender(req.query.seekingGender),
      minAge        : toTrimmed(req.query.minAge) || '',
      maxAge        : toTrimmed(req.query.maxAge) || '',
      country       : (req.query.country || 'Any').trim(),
      stateProvince : toTrimmed(req.query.stateProvince) || '',
      city          : toTrimmed(req.query.city) || '',
      q             : toTrimmed(req.query.q) || '',
      interests     : toTrimmed(req.query.interests) || '',
      location      : toTrimmed(req.query.location) || '',

      // advanced
      verifiedOnly  : req.query.verifiedOnly || '',
      onlineNow     : req.query.onlineNow || '',
      hasPhoto      : req.query.hasPhoto || '',
      minPhotos     : toTrimmed(req.query.minPhotos) || '',
      radiusKm      : toTrimmed(req.query.radiusKm) || '',
      religion      : toTrimmed(req.query.religion) || '',
      denomination  : toTrimmed(req.query.denomination) || '',
      languages     : req.query.languages || '',
      education     : toTrimmed(req.query.education) || '',
      smoking       : toTrimmed(req.query.smoking) || '',
      drinking      : toTrimmed(req.query.drinking) || '',
      videoChat     : toTrimmed(req.query.videoChat || ''), // '' | '1' | '0'
      sort          : (req.query.sort || 'active'),         // active | recent | distance | ageAsc | ageDesc
    };

    // Normalize min/max age (swap if reversed)
    const minAgeRaw = toInt(rawFilters.minAge);
    const maxAgeRaw = toInt(rawFilters.maxAge);
    if (minAgeRaw != null && maxAgeRaw != null && minAgeRaw > maxAgeRaw) {
      rawFilters.minAge = String(maxAgeRaw);
      rawFilters.maxAge = String(minAgeRaw);
    }

    // 2) Premium/plan gating (same clamp you use on /dashboard)
    const isPrem = typeof isPremiumOrBetter === 'function'
      ? isPremiumOrBetter(currentUser)
      : !!currentUser.isPremium;
    const isElit = typeof isElite === 'function' ? isElite(currentUser) : false;

    const { filters: f1, locks: l1 } = clampFiltersForFree(rawFilters, isPrem, isElit);
    const { filters, locks: l2 }     = clampFiltersByPlan(f1, currentUser);
    const premiumLocks               = { ...l1, ...l2 };

    // 3) Base query (exclude me + blocked; require profile)
    const excluded = [
      currentUser._id,
      ...((currentUser.blockedUsers || []).map(id => id)),
    ];

    const query = { _id: { $nin: excluded }, profile: { $exists: true } };

    // Gender
    if (filters.seekingGender !== 'Any') {
      query['profile.gender'] = filters.seekingGender;
    }

    // Age
    const minAge = toInt(filters.minAge);
    const maxAge = toInt(filters.maxAge);
    if (minAge != null && maxAge != null) query['profile.age'] = { $gte: minAge, $lte: maxAge };
    else if (minAge != null)              query['profile.age'] = { $gte: minAge };
    else if (maxAge != null)              query['profile.age'] = { $lte: maxAge };

    // Location
    if (filters.country !== 'Any') query['profile.country'] = filters.country;
    const reState = safeRegex(filters.stateProvince);
    const reCity  = safeRegex(filters.city);
    if (reState) query['profile.stateProvince'] = reState;
    if (reCity)  query['profile.city']          = reCity;

    // Free-text & interests
    if (filters.q) {
      query.$or = [
        { username: safeRegex(filters.q) || filters.q },
        { 'profile.bio': safeRegex(filters.q) || filters.q },
      ];
    }
    if (filters.interests) {
      query['profile.interests'] = { $regex: filters.interests, $options: 'i' };
    }

    // Advanced toggles
    if (filters.verifiedOnly === '1') query.verifiedAt = { $ne: null };
    if (filters.onlineNow   === '1') query.lastActive = { $gte: new Date(Date.now() - 5 * 60 * 1000) };
    if (filters.hasPhoto    === '1') query['profile.photos.0'] = { $exists: true, $ne: null };

    // Min photos
    const minPhotosWanted = toInt(filters.minPhotos, 0);
    if (minPhotosWanted && minPhotosWanted > 1) {
      query[`profile.photos.${minPhotosWanted - 1}`] = { $exists: true, $ne: null };
    }

    // Faith / language / lifestyle
    if (filters.religion)     query['profile.religion']     = safeRegex(filters.religion)     || filters.religion;
    if (filters.denomination) query['profile.denomination'] = safeRegex(filters.denomination) || filters.denomination;

    if (filters.languages && String(filters.languages).trim() !== '') {
      const langs = Array.isArray(filters.languages)
        ? filters.languages
        : String(filters.languages).split(',').map(s => s.trim()).filter(Boolean);
      if (langs.length) query['profile.languages'] = { $in: langs };
    }

    if (filters.education) query['profile.education'] = safeRegex(filters.education) || filters.education;
    if (filters.smoking)   query['profile.smoking']   = safeRegex(filters.smoking)   || filters.smoking;
    if (filters.drinking)  query['profile.drinking']  = safeRegex(filters.drinking)  || filters.drinking;

    // Video chat availability (top-level field)
    // clampFiltersByPlan already blanked filters.videoChat for non-Elite
    if (filters.videoChat === '1') {
      query.videoChat = true;
    } else if (filters.videoChat === '0') {
      query.videoChat = { $ne: true }; // treat missing/false as "No"
    }

    // 4) Sorting (boost first, then requested base sort; distance handled after distance calc)
    const sortKey = filters.sort || 'active';
    let sortBase = { lastActive: -1, _id: -1 };
    if (sortKey === 'recent')  sortBase = { createdAt: -1, _id: -1 };
    if (sortKey === 'ageAsc')  sortBase = { 'profile.age': 1,  _id: -1 };
    if (sortKey === 'ageDesc') sortBase = { 'profile.age': -1, _id: -1 };
    const sort = { boostExpiresAt: -1, ...sortBase };

    // 5) Paging
    const page  = Math.max(toInt(req.query.page, 1), 1);
    const limit = Math.min(Math.max(toInt(req.query.limit, 24), 1), 48);
    const skip  = (page - 1) * limit;

    // 6) Projection (include `videoChat` for badge rendering)
    const projection = {
      username: 1,
      lastActive: 1,
      createdAt: 1,
      boostExpiresAt: 1,
      verifiedAt: 1,
      isPremium: 1,
      stripePriceId: 1,
      subscriptionPriceId: 1,
      videoChat: 1,
      'profile.age': 1,
      'profile.bio': 1,
      'profile.photos': 1,
      'profile.country': 1,
      'profile.stateProvince': 1,
      'profile.city': 1,
      'profile.lat': 1,
      'profile.lng': 1,
      'profile.languages': 1,
      'profile.religion': 1,
      'profile.denomination': 1,
    };

    // 7) Fetch + count
    const [rawList, total] = await Promise.all([
      User.find(query).select(projection).sort(sort).skip(skip).limit(limit).lean(),
      User.countDocuments(query),
    ]);

    // 8) Enhance results (online + distance + boost flag)
    const now   = Date.now();
    const meLat = currentUser?.profile?.lat;
    const meLng = currentUser?.profile?.lng;

    const enhance = (u) => {
      const isOnline = u.lastActive ? (now - new Date(u.lastActive).getTime() < 5 * 60 * 1000) : false;
      const distanceKm =
        typeof meLat === 'number' && typeof meLng === 'number' &&
        typeof u?.profile?.lat === 'number' && typeof u?.profile?.lng === 'number'
          ? haversineKm(meLat, meLng, u.profile.lat, u.profile.lng)
          : null;
      return { ...u, isOnline, distanceKm, boostActive: computeBoostActive(u, now) };
    };

    let people = (rawList || []).map(enhance);

    // 9) Radius filter + distance sort (final step; after enhancement)
    const radiusKm = toInt(filters.radiusKm, 0) || 0;
    if (radiusKm > 0 && typeof meLat === 'number' && typeof meLng === 'number') {
      people = people.filter(u => typeof u.distanceKm === 'number' && u.distanceKm <= radiusKm);
    }
    if (sortKey === 'distance') {
      people.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    }

    // 10) Navbar unread badges (if you don't already set these in res.locals)
    const [unreadMessages, unreadNotificationCount] = await Promise.all([
      Message.countDocuments({
        recipient: currentUser._id,
        read: false,
        deletedFor: { $nin: [currentUser._id] }
      }),
      Notification.countDocuments({ recipient: currentUser._id, read: false }),
    ]);

    // 11) Render
    return res.render('advanced-search', {
      currentUser,
      filters,                 // sticky values
      premiumLocks,            // which controls were clamped/locked for free users
      people,                  // results grid
      pageMeta: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
        sort: sortKey,
      },
      unreadMessages,
      unreadNotificationCount,
    });
  } catch (err) {
    console.error('advanced-search err:', err);
    return res.status(500).render('error', { status: 500, message: 'Failed to load Advanced Search.' });
  }
});

// GET /viewed-you
app.get('/viewed-you', checkAuth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.session.userId)
      .select('isPremium blockedUsers views')
      .lean();
    if (!currentUser) return res.redirect('/login');

    const blocked = new Set((currentUser.blockedUsers || []).map(String));

    // group by viewer -> latest view time
    const latestByViewer = new Map();
    for (const v of (currentUser.views || [])) {
      const k = String(v.user);
      if (blocked.has(k)) continue;
      if (!latestByViewer.has(k) || latestByViewer.get(k) < v.at) {
        latestByViewer.set(k, v.at);
      }
    }
    const viewers = [...latestByViewer.entries()]
      .sort((a, b) => b[1] - a[1]) // latest first
      .map(([id]) => id);

    // paging
    const page  = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '24', 10), 1), 48);
    const skip  = (page - 1) * limit;
    const total = viewers.length;
    const slice = viewers.slice(skip, skip + limit);

    const projection = {
      username: 1, verifiedAt: 1, lastActive: 1,
      'profile.age': 1, 'profile.city': 1, 'profile.country': 1, 'profile.photos': 1
    };
    const people = slice.length
      ? await User.find({ _id: { $in: slice } }).select(projection).lean()
      : [];

    // For now: free users always blurred on /viewed-you; premium = unblurred
    const blurred = !currentUser.isPremium;

    res.render('viewed-you', {
      currentUser,
      people,
      blurred,
      pageMeta: {
        page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1)
      },
      unreadMessages: await Message.countDocuments({ recipient: currentUser._id, read: false }),
      unreadNotificationCount: await Notification.countDocuments({ recipient: currentUser._id, read: false }),
    });
  } catch (e) {
    console.error('viewed-you err', e);
    res.status(500).render('error', { status: 500, message: 'Failed to load Viewed You.' });
  }
});


// ---------- helpers (keep these) ----------
const dayKey = (d = new Date()) => new Date(d).toDateString();

// 1 free reveal/day for non-premium; premium is always revealed
function canRevealLikesToday(req, isPremium) {
  if (isPremium) return true;
  return req.session?.likesYouRevealDay === dayKey();
}
function markRevealedLikesToday(req) {
  req.session.likesYouRevealDay = dayKey();
}

// Optional legacy middleware you might use elsewhere; canonicalized keys
function requirePremiumOrDailyReveal(limit = 1, { graceHours = 72, verifiedBonus = 1 } = {}) {
  return async (req, res, next) => {
    const u = await User.findById(req.session.userId);
    if (!u) return res.redirect('/login');

    if (isPremiumOrBetter(u)) return next();

    // Grace example (keep your own logic)
    const createdAt = u.createdAt ? new Date(u.createdAt).getTime() : 0;
    const nowMs = Date.now();
    const graceOk = !!createdAt && (nowMs - createdAt) <= graceHours * 3600 * 1000;
    if (graceOk) return next();

    // Daily counters on user doc (optional)
    const today = dayKey();
    if (u.likesYouRevealDay !== today) {
      u.likesYouRevealDay = today;
      u.likesYouRevealCount = 0;
    }
    const allowance = limit + (u.verifiedAt ? verifiedBonus : 0);
    if ((u.likesYouRevealCount || 0) < allowance) {
      u.likesYouRevealCount = (u.likesYouRevealCount || 0) + 1;
      await u.save();
      req.session.likesYouRevealDay = today;
      return next();
    }

    return res.status(402).render('paywall', {
      feature: 'Who liked you',
      allowance, used: u.likesYouRevealCount
    });
  };
}
// ---------- "Who Liked You" ----------
app.get('/likes-you', checkAuth, async (req, res) => {
  try {
    const meId  = req.session.userId;

    // We need: premium flag, my likes (to remove mutuals), my likedBy, blocked
    const currentUser = await User.findById(meId)
      .select('isPremium plan likes likedBy blockedUsers')
      .lean();
    if (!currentUser) return res.redirect('/login');

    const isPremium = !!currentUser.isPremium || (currentUser.plan && currentUser.plan !== 'free');

    // Build the candidate list:
    //  - start from likedBy
    //  - remove anyone I’ve already liked (mutuals)
    //  - remove blocked
    const myLikesSet     = new Set((currentUser.likes || []).map(String));
    const blockedSet     = new Set((currentUser.blockedUsers || []).map(String));
    // newest first if your likedBy is chronological
    const likerIds = (currentUser.likedBy || [])
      .map(String)
      .filter(uid => !myLikesSet.has(uid))
      .filter(uid => !blockedSet.has(uid))
      .reverse();

    // paging
    const page  = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '24', 10), 1), 48);
    const skip  = (page - 1) * limit;
    const total = likerIds.length;
    const slice = likerIds.slice(skip, skip + limit);

    const projection = {
      username: 1, verifiedAt: 1, lastActive: 1,
      'profile.age': 1, 'profile.city': 1, 'profile.country': 1, 'profile.photos': 1
    };
    const people = slice.length
      ? await User.find({ _id: { $in: slice } }).select(projection).lean()
      : [];

    const revealed = canRevealLikesToday(req, isPremium);

    // unread counts (messages respects soft-delete, notifs as-is)
    const [unreadMessages, unreadNotificationCount] = await Promise.all([
      Message.countDocuments({
        recipient: meId,
        read: false,
        deletedFor: { $nin: [new mongoose.Types.ObjectId(meId)] }
      }),
      Notification.countDocuments({ recipient: meId, read: false })
    ]);

    const justRevealed = !!req.session.justRevealedLikes;
    req.session.justRevealedLikes = undefined;

    return res.render('likes-you', {
      currentUser: { _id: meId, isPremium },
      people,
      blurred: !revealed, // <-- your EJS overlay key
      justRevealed: req.query.revealed === '1',
      pageMeta: {
        page, limit, total, totalPages: Math.max(Math.ceil(total / limit), 1)
      },
      unreadMessages,
      unreadNotificationCount,
    });
  } catch (e) {
    console.error('likes-you err', e);
    return res.status(500).render('error', { status: 500, message: 'Failed to load Liked You.' });
  }
});

// POST /likes-you/reveal  (non-premium gets 1 free reveal per day)
app.post('/likes-you/reveal', checkAuth, async (req, res) => {
  try {
    const me = await User.findById(req.session.userId).select('isPremium plan').lean();
    if (!me) return res.redirect('/login');

    const isPremium = !!me.isPremium || (me.plan && me.plan !== 'free');
    if (!isPremium) markRevealedLikesToday(req); // premium is always unblurred

    // NEW: flash a “just revealed” once
    req.session.justRevealedLikes = true;

    return res.redirect(303, '/likes-you');
  } catch (e) {
    console.error('likes-you reveal err', e);
    return res.redirect('/likes-you');
  }
});

app.get('/notifications', checkAuth, async (req, res) => {
  try {
    const me = await User.findById(req.session.userId).lean();
    if (!me) { req.session.destroy(() => {}); return res.redirect('/login'); }

    const meObj = new ObjectId(me._id);
    const notifications = await Notification.find({
      recipient: meObj,
      deletedFor: { $nin: [meObj] }
    })
    .populate('sender', 'username profile.photos')
    .sort({ createdAt: -1 })
    .lean();

    const [unreadMessages, unreadNotificationCount] = await Promise.all([
      Message.countDocuments({ recipient: meObj, read: false, deletedFor: { $nin: [meObj] } }),
      Notification.countDocuments({ recipient: meObj, read: false, deletedFor: { $nin: [meObj] } }),
    ]);

    res.render('notifications', {
      currentUser: me,
      notifications,
      unreadMessages,
      unreadNotificationCount
    });
  } catch (error) {
    console.error('notifications page err', error);
    res.status(500).send('Server error');
  }
});
// GET /api/notifications (feed for infinite scroll)
app.get('/api/notifications', checkAuth, async (req, res) => {
  try {
    const me = new mongoose.Types.ObjectId(req.session.userId);
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 50);
    const before = req.query.before ? new Date(req.query.before) : null;

    const q = { recipient: me, deletedFor: { $nin: [me] } };
    if (before) q.createdAt = { $lt: before };

    const items = await Notification.find(q)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ ok: true, items });
  } catch (e) {
    console.error('api/notifications err', e);
    res.status(500).json({ ok: false });
  }
});

app.post('/notifications/:id/mark-read', checkAuth, async (req, res) => {
  try {
    const me = new ObjectId(req.session.userId);
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).send('Bad id');

    const n = await Notification.findOne({ _id: id, recipient: me });
    if (!n) return res.status(404).send('Notification not found');

    if (!n.read) { n.read = true; await n.save(); }

    // live badge update
    const unread = await Notification.countDocuments({ recipient: me, read: false, deletedFor: { $nin: [me] } });
    const io = req.app.get('io');
    io && io.to(String(me)).emit('notif_update', { unread });

    res.redirect('/notifications');
  } catch (error) {
    console.error('mark-read err', error);
    res.status(500).send('Server error');
  }
});

app.post('/notifications/mark-all-read', checkAuth, async (req, res) => {
  try {
    const me = new ObjectId(req.session.userId);
    await Notification.updateMany(
      { recipient: me, read: false, deletedFor: { $nin: [me] } },
      { $set: { read: true } }
    );

    const unread = 0;
    const io = req.app.get('io');
    io && io.to(String(me)).emit('notif_update', { unread });

    res.json({ ok: true });
  } catch (e) {
    console.error('mark-all-read err', e);
    res.status(500).json({ ok: false });
  }
});

app.delete('/notifications/dismiss/:id', checkAuth, async (req, res) => {
  try {
    const me = new ObjectId(req.session.userId);
    const id = req.params.id;
    if (!ObjectId.isValid(id)) return res.status(400).json({ status: 'error', message: 'Bad id' });

    const result = await Notification.updateOne(
      { _id: id, recipient: me },
      { $addToSet: { deletedFor: me } }  // soft delete for me only
    );

    if (!result.modifiedCount) {
      return res.status(404).json({ status: 'error', message: 'Notification not found' });
    }

    // recompute unread
    const unread = await Notification.countDocuments({ recipient: me, read: false, deletedFor: { $nin: [me] } });
    const io = req.app.get('io');
    io && io.to(String(me)).emit('notif_update', { unread });

    res.json({ status: 'success', message: 'Notification dismissed.', unread });
  } catch (error) {
    console.error('dismiss err', error);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
});

app.get('/api/unread/notifications', checkAuth, async (req, res) => {
  try {
    const me = new ObjectId(req.session.userId);
    const count = await Notification.countDocuments({ recipient: me, read: false, deletedFor: { $nin: [me] } });
    res.json({ ok: true, count });
  } catch (e) {
    console.error('unread notifs err', e);
    res.status(500).json({ ok: false });
  }
});

const fetchUserAndCounts = async (req, res, next) => {
  try {
    if (req.session.userId) {
      const currentUser = await User.findById(req.session.userId);
      if (currentUser) {
        req.currentUser = currentUser;
        // Assuming you have logic to count unread messages and notifications
        // For now, we'll just pass these from the previous routes to avoid an error.
        // You may need to add the actual logic to get these counts here.
        req.unreadMessages = 0; // Replace with actual unread count logic
        req.unreadNotificationCount = 0; // Replace with actual notification count logic
      } else {
        // User not found, clear session and redirect to login
        req.session.destroy();
        return res.redirect('/login');
      }
    }
    next();
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).send('Server Error');
  }
};

// Route to render the main settings page
app.get('/settings', checkAuth, fetchUserAndCounts, (req, res) => {
  res.render('settings', { 
    unreadMessages: req.unreadMessages, 
    unreadNotificationCount: req.unreadNotificationCount,
    currentUser: req.currentUser 
  });
});

// Route for email settings
app.get('/settings/email', checkAuth, fetchUserAndCounts, (req, res) => {
  res.render('email-settings', { 
    unreadMessages: req.unreadMessages, 
    unreadNotificationCount: req.unreadNotificationCount,
    currentUser: req.currentUser
  });
});

// Route for password settings
app.get('/settings/password', checkAuth, fetchUserAndCounts, (req, res) => {
  res.render('password-settings', { 
    unreadMessages: req.unreadMessages, 
    unreadNotificationCount: req.unreadNotificationCount,
    currentUser: req.currentUser
  });
});

// Route for billing settings
app.get('/settings/billing', checkAuth, fetchUserAndCounts, (req, res) => {
  res.render('billing-settings', { 
    unreadMessages: req.unreadMessages, 
    unreadNotificationCount: req.unreadNotificationCount,
    currentUser: req.currentUser,
    error: null, // Pass an initial value for the error variable
    success: null // Pass an initial value for the success variable
  });
});

// Route to get the community hub page
app.get('/community', checkAuth, async (req, res) => {
    try {
        const currentUserId = req.session.userId;
        const currentUser = await User.findById(currentUserId);
        
        // Fetch all posts and populate the author field to get the username
        const posts = await Post.find().populate('author').sort({ createdAt: -1 });

        res.render('community', { currentUser: currentUser, posts: posts });
    } catch (err) {
        console.error('Error fetching community posts:', err);
        res.status(500).send('Server Error');
    }
});

// Route to create a new post
app.post('/community/create-post', checkAuth, async (req, res) => {
    try {
        const { title, content } = req.body;
        const currentUserId = req.session.userId;

        const newPost = new Post({
            author: currentUserId,
            title,
            content
        });

        await newPost.save();
        
        res.redirect('/community');
    } catch (err) {
        console.error('Error creating post:', err);
        res.status(500).send('Server Error');
    }
});

// Route to get a single post and its comments
app.get('/community/post/:id', checkAuth, async (req, res) => {
    try {
        const postId = req.params.id;
        const currentUserId = req.session.userId;
        const currentUser = await User.findById(currentUserId);
        
        // Find the post and populate both the author and the comments
        const post = await Post.findById(postId)
            .populate('author')
            .populate({
                path: 'comments',
                populate: {
                    path: 'author'
                }
            });

        if (!post) {
            return res.status(404).send('Post not found.');
        }

        res.render('post', { currentUser, post });
    } catch (err) {
        console.error('Error fetching post and comments:', err);
        res.status(500).send('Server Error');
    }
});

// Route to create a new comment on a post
app.post('/community/post/:id/comment', checkAuth, async (req, res) => {
    try {
        const postId = req.params.id;
        const { content } = req.body;
        const currentUserId = req.session.userId;

        const post = await Post.findById(postId);
        if (!post) {
            return res.status(404).json({ status: 'error', message: 'Post not found.' });
        }

        const newComment = new Comment({
            author: currentUserId,
            post: postId,
            content
        });

        await newComment.save();
        
        // Add the new comment to the post's comments array
        post.comments.push(newComment._id);
        await post.save();

        res.redirect(`/community/post/${postId}`);

    } catch (err) {
        console.error('Error creating comment:', err);
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});


// Route to handle user reports
app.post('/report-user', checkAuth, async (req, res) => {
    try {
        const { reportedUserId, reason, details } = req.body;
        const currentUserId = req.session.userId;

        // Check if the user is trying to report themselves
        if (currentUserId === reportedUserId) {
            return res.status(400).json({ status: 'error', message: 'You cannot report your own profile.' });
        }
        
        // Find the user being reported to ensure they exist
        const reportedUser = await User.findById(reportedUserId);
        if (!reportedUser) {
            return res.status(404).json({ status: 'error', message: 'User to report not found.' });
        }

        const newReport = new Report({
            reporter: currentUserId,
            reportedUser: reportedUserId,
            reason,
            details
        });

        await newReport.save();

        res.json({ status: 'success', message: 'Report submitted successfully. Thank you for making our community safer.' });
    } catch (err) {
        console.error('Error submitting report:', err);
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});


// Route to render the quiz page with a random question
app.get('/quiz', checkAuth, async (req, res) => {
    try {
        const currentUserId = req.session.userId;
        const currentUser = await User.findById(currentUserId);
        
        // Find a random quiz question from the database
        const count = await Quiz.countDocuments();
        const random = Math.floor(Math.random() * count);
        const randomQuiz = await Quiz.findOne().skip(random);

        if (!randomQuiz) {
            return res.status(404).send('No quiz questions available.');
        }

        res.render('quiz', { currentUser, quiz: randomQuiz });
    } catch (err) {
        console.error('Error fetching quiz question:', err);
        res.status(500).send('Server Error');
    }
});

// Route to handle quiz answer submission
app.post('/quiz/submit', checkAuth, async (req, res) => {
    try {
        const { quizId, selectedAnswer } = req.body;
        const quiz = await Quiz.findById(quizId);
        
        if (!quiz) {
            return res.status(404).json({ status: 'error', message: 'Quiz question not found.' });
        }

        if (quiz.correctAnswer === selectedAnswer) {
            // A real application would update user's profile with a score or badge
            // For now, we'll just send a success message.
            res.json({ status: 'correct', message: 'That\'s correct!' });
        } else {
            res.json({ status: 'incorrect', message: `Incorrect. The correct answer was: ${quiz.correctAnswer}` });
        }

    } catch (err) {
        console.error('Error submitting quiz answer:', err);
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

// Middleware to check if the date has changed and reset the like counter
const resetDailyLikes = async (req, res, next) => {
  try {
    if (req.session.userId) {
      const user = await User.findById(req.session.userId);
      if (user) {
        const now = new Date();

        // ----- Likes (free only) -----
        if (!user.isPremium) {
          const lastLike = user.lastLikeDate;
          const likeNewDay = !lastLike ||
            now.getDate()  !== lastLike.getDate()  ||
            now.getMonth() !== lastLike.getMonth() ||
            now.getFullYear() !== lastLike.getFullYear();

          if (likeNewDay) {
            user.likesToday   = 0;
            user.lastLikeDate = now;
          } else {
            user.likesToday   = user.likesToday || 0;
            user.lastLikeDate = user.lastLikeDate || now;
          }
        }

        // ----- Super-likes (all users) -----
        const lastSL = user.lastSuperLikeDate;
        const slNewDay = !lastSL ||
          now.getDate()  !== lastSL.getDate()  ||
          now.getMonth() !== lastSL.getMonth() ||
          now.getFullYear() !== lastSL.getFullYear();

        if (slNewDay) {
          user.superLikesToday   = 0;
          user.lastSuperLikeDate = now;
        } else {
          user.superLikesToday   = user.superLikesToday || 0;
          user.lastSuperLikeDate = user.lastSuperLikeDate || now;
        }

        await user.save();
      }
    }
    next();
  } catch (err) {
    console.error('Error resetting daily likes:', err);
    next(err);
  }
};

async function applyDailySuperlike(reqUserId, usedNow) {
  const u = await User.findById(reqUserId).select('isPremium lastSuperLikeDate superLikesToday');
  if (!u) return { ok:false };

  const todayKey = new Date().toDateString();
  const lastKey  = u.lastSuperLikeDate ? new Date(u.lastSuperLikeDate).toDateString() : null;
  if (todayKey !== lastKey) {
    u.superLikesToday   = 0;
    u.lastSuperLikeDate = new Date();
  }
  if (usedNow) u.superLikesToday = (u.superLikesToday || 0) + 1;
  await u.save();

  const cap = u.isPremium ? PREMIUM_SUPERLIKES_PER_DAY : FREE_SUPERLIKES_PER_DAY;
  return { ok:true, used: u.superLikesToday, cap, remaining: Math.max(cap - u.superLikesToday, 0), isPremium: !!u.isPremium };
}

// env caps (keep these near other envs)
const FREE_SUPERLIKES_PER_DAY    = Number(process.env.FREE_SUPERLIKES_PER_DAY    || 1);
const PREMIUM_SUPERLIKES_PER_DAY = Number(process.env.PREMIUM_SUPERLIKES_PER_DAY || 5);

// optional cooldown (in-proc)
const SUPERLIKE_COOLDOWN_SEC = Number(process.env.SUPERLIKE_COOLDOWN_SEC || 30);
const __lastSuperLike = global.__lastSuperLike || (global.__lastSuperLike = new Map());

async function superLikeHandler(req, res) {
  try {
    const me   = String(req.session.userId || '');
    const them = String(req.params.id || '');
    if (!mongoose.Types.ObjectId.isValid(me) || !mongoose.Types.ObjectId.isValid(them) || me === them) {
      return res.status(400).json({ ok:false, error:'bad_id' });
    }

    // 🔒 cooldown — now me/them exist
    const key = `${me}:${them}`;
    const nowMs = Date.now();
    const last  = __lastSuperLike.get(key) || 0;
    if (nowMs - last < SUPERLIKE_COOLDOWN_SEC * 1000) {
      return res.status(429).json({ ok:false, error:'cooldown' });
    }

    const meObj   = new mongoose.Types.ObjectId(me);
    const themObj = new mongoose.Types.ObjectId(them);

    // check daily quota BEFORE writing
    const usage = await applyDailySuperlike(meObj, false);
    if (!usage.ok) return res.status(401).json({ ok:false });
    const cap = usage.isPremium ? PREMIUM_SUPERLIKES_PER_DAY : FREE_SUPERLIKES_PER_DAY;
    if (usage.used >= cap) {
      return res.status(402).json({ ok:false, error:'limit', cap });
    }

    // idempotent writes; super-like also implies a normal like
    const [r1, r2] = await Promise.all([
      User.updateOne({ _id: meObj },   { $addToSet: { superLiked: themObj, likes: themObj } }),
      User.updateOne({ _id: themObj }, { $addToSet: { superLikedBy: meObj, likedBy: meObj } }),
    ]);
    const changed = (r1.modifiedCount + r2.modifiedCount) > 0;

    if (changed) {
      await applyDailySuperlike(meObj, true);   // consume 1 token
      __lastSuperLike.set(key, nowMs);          // remember cooldown

      // notify recipient
      const io = req.app.get('io');
      if (typeof createNotification === 'function') {
        await createNotification({
          io,
          recipientId: themObj,
          senderId: meObj,
          type: 'superlike',
          message: '⚡ Someone super-liked you!',
          extra: { link: `/users/${me}` }
        });
      }
    }

    return res.json({
      ok: true,
      state: changed ? 'sent' : 'unchanged',
      remaining: Math.max(cap - (usage.used + (changed ? 1 : 0)), 0),
      cap
    });
  } catch (e) {
    console.error('superlike err', e);
    return res.status(500).json({ ok:false });
  }
}

// Keep your middleware vibe (reuse validateObjectId/likeLimiter if you want)
app.post('/superlike/:id', checkAuth, validateObjectId('id'), validate, superLikeHandler);
app.post('/api/superlike/:id', checkAuth, validateObjectId('id'), validate, superLikeHandler);


// Add the new middleware to the dashboard and like routes
app.use(resetDailyLikes);

// put this once, above routes (safe to keep even if defined elsewhere)
if (typeof global.computeBoostActive !== 'function') {
  global.computeBoostActive = function computeBoostActive(u, nowMs = Date.now()) {
    if (!u || !u.boostExpiresAt) return false;
    const t = new Date(u.boostExpiresAt).getTime();
    return Number.isFinite(t) && t > nowMs;
  };
}

// ---- GET - Dashboard (merged + advanced filters + member level) ----
app.get('/dashboard', checkAuth, async (req, res) => {
  try {
    const now = Date.now();

    const currentUser = await User.findById(req.session.userId)
      .populate('likes', '_id')
      .populate('dislikes', '_id')
      .populate('blockedUsers', '_id')
      .exec();

    if (!currentUser) {
      req.session.destroy(() => {});
      return res.redirect('/login');
    }

    // Map subscription/product to tiers used in UI: free | silver | emerald
    const STRIPE_PRICE_ID_EMERALD = process.env.STRIPE_PRICE_ID_EMERALD || '';
    const STRIPE_PRICE_ID_SILVER  = process.env.STRIPE_PRICE_ID_SILVER  || '';
    const tierOf = (u) => {
      const price = u.stripePriceId || u.subscriptionPriceId || null;
      if (price && STRIPE_PRICE_ID_EMERALD && String(price) === String(STRIPE_PRICE_ID_EMERALD)) return 'emerald';
      if (price && STRIPE_PRICE_ID_SILVER  && String(price) === String(STRIPE_PRICE_ID_SILVER))  return 'silver';
      if (u.isPremium) return 'silver';
      return 'free';
    };

    // Exclude self & blocked
    const excludedUserIds = [
      ...(currentUser.blockedUsers || []).map(u => u._id),
      currentUser._id,
    ];

    // ---- Filters (existing + new) ----
    const rawFilters = {
      seekingGender : req.query.seekingGender || 'Any',
      minAge        : toTrimmed(req.query.minAge) || '',
      maxAge        : toTrimmed(req.query.maxAge) || '',
      country       : req.query.country || 'Any',
      stateProvince : toTrimmed(req.query.stateProvince) || '',
      city          : toTrimmed(req.query.city) || '',
      q             : toTrimmed(req.query.q) || '',
      interests     : toTrimmed(req.query.interests) || '',
      location      : toTrimmed(req.query.location) || '',

      // NEW:
      verifiedOnly  : req.query.verifiedOnly || '',
      onlineNow     : req.query.onlineNow || '',
      hasPhoto      : req.query.hasPhoto || '',
      minPhotos     : toTrimmed(req.query.minPhotos) || '',
      radiusKm      : toTrimmed(req.query.radiusKm) || '',
      religion      : toTrimmed(req.query.religion) || '',
      denomination  : toTrimmed(req.query.denomination) || '',
      languages     : req.query.languages || '',   // string CSV or array
      education     : toTrimmed(req.query.education) || '',
      smoking       : toTrimmed(req.query.smoking) || '',
      drinking      : toTrimmed(req.query.drinking) || '',
      sort          : req.query.sort || 'active',  // includes 'distance'
      // NOTE: If you support videoChat here, it should be on rawFilters too ('' | '1' | '0')
      videoChat     : toTrimmed(req.query.videoChat || ''),
    };

    // ---- Premium clamp (added) ----
    const FREE_MAX_RADIUS_KM = Number(process.env.FREE_MAX_RADIUS_KM || 25);
    function clampFiltersForFree(filters, isPremium) {
      const out = { ...filters };
      const locks = { minPhotos:false, languages:false, lifestyle:false, radius:false, distanceSort:false };
      if (!isPremium) {
        if ((+out.minPhotos || 0) > 1) { out.minPhotos = ''; locks.minPhotos = true; }
        if (out.languages && String(out.languages).trim() !== '') { out.languages = ''; locks.languages = true; }
        if (out.education) { out.education = ''; locks.lifestyle = true; }
        if (out.smoking)   { out.smoking   = ''; locks.lifestyle = true; }
        if (out.drinking)  { out.drinking  = ''; locks.lifestyle = true; }
        const r = +out.radiusKm || 0;
        if (r > FREE_MAX_RADIUS_KM) { out.radiusKm = String(FREE_MAX_RADIUS_KM); locks.radius = true; }
        if (out.sort === 'distance') { out.sort = 'active'; locks.distanceSort = true; }
      }
      return { filters: out, locks };
    }

    // ⬇️⬇️⬇️  **CHANGED ORDER**: clamp filters FIRST so `filters` exists before we read filters.sort below
    const { filters: f1, locks: l1 } = clampFiltersForFree(rawFilters, !!currentUser.isPremium);
    const { filters, locks: l2 }     = clampFiltersByPlan(f1, currentUser);
    const premiumLocks               = { ...l1, ...l2 };
    // ⬆️⬆️⬆️

    // ---- Paging ----
    const page  = Math.max(toInt(req.query.page, 1), 1);
    const limit = Math.min(Math.max(toInt(req.query.limit, 24), 1), 48);
    const skip  = (page - 1) * limit;

    // ---- Sorting (boost first, then chosen order) ----
    const sortKey = filters.sort || 'active';   // ✅ now safe: filters is defined
    let sortBase = { lastActive: -1, _id: -1 };
    if (sortKey === 'recent')   sortBase = { createdAt: -1, _id: -1 };
    if (sortKey === 'ageAsc')   sortBase = { 'profile.age': 1,  _id: -1 };
    if (sortKey === 'ageDesc')  sortBase = { 'profile.age': -1, _id: -1 };
    // distance sort handled post-fetch (after we compute distances)
    const sort = { boostExpiresAt: -1, ...sortBase };

    // ---- Base query ----
    const query = { _id: { $nin: excludedUserIds }, profile: { $exists: true } };

    // strict filter only if Elite:
    if (filters.videoChat === '1' && isElite(currentUser)) {
      query.videoChat = true;
    }

    // Gender
    if (filters.seekingGender !== 'Any') query['profile.gender'] = filters.seekingGender;

    // Age range
    const minAge = toInt(filters.minAge);
    const maxAge = toInt(filters.maxAge);
    if (minAge != null && maxAge != null) query['profile.age'] = { $gte: minAge, $lte: maxAge };
    else if (minAge != null)              query['profile.age'] = { $gte: minAge };
    else if (maxAge != null)              query['profile.age'] = { $lte: maxAge };

    // Location filters
    if (filters.country !== 'Any') query['profile.country'] = filters.country;
    if (filters.stateProvince)     query['profile.stateProvince'] = new RegExp(filters.stateProvince, 'i');
    if (filters.city)              query['profile.city'] = new RegExp(filters.city, 'i');

    // Free-text & interests
    if (filters.q) {
      query.$or = [
        { username: new RegExp(filters.q, 'i') },
        { 'profile.bio': new RegExp(filters.q, 'i') },
      ];
    }
    if (filters.interests) {
      query['profile.interests'] = { $regex: filters.interests, $options: 'i' };
    }

    // ---- Advanced filters ----
    if (filters.verifiedOnly === '1')  query.verifiedAt = { $ne: null };
    if (filters.onlineNow   === '1')   query.lastActive = { $gte: new Date(Date.now() - 5 * 60 * 1000) };
    if (filters.hasPhoto    === '1')   query['profile.photos.0'] = { $exists: true, $ne: null };

    const minPhotosWanted = toInt(filters.minPhotos, 0);
    if (minPhotosWanted && minPhotosWanted > 1) {
      query[`profile.photos.${minPhotosWanted - 1}`] = { $exists: true, $ne: null };
    }

    if (filters.religion)     query['profile.religion']     = new RegExp(filters.religion, 'i');
    if (filters.denomination) query['profile.denomination'] = new RegExp(filters.denomination, 'i');

    if (filters.languages && String(filters.languages).trim() !== '') {
      const langs = Array.isArray(filters.languages)
        ? filters.languages
        : String(filters.languages).split(',').map(s => s.trim()).filter(Boolean);
      if (langs.length) query['profile.languages'] = { $in: langs };
    }

    if (filters.education) query['profile.education'] = new RegExp(filters.education, 'i');
    if (filters.smoking)   query['profile.smoking']   = new RegExp(filters.smoking, 'i');
    if (filters.drinking)  query['profile.drinking']  = new RegExp(filters.drinking, 'i');

    // ---- Projection ----
    const projection = {
      username             : 1,
      lastActive           : 1,
      createdAt            : 1,
      boostExpiresAt       : 1,
      verifiedAt           : 1,
      isPremium            : 1,
      stripePriceId        : 1,
      subscriptionPriceId  : 1,
      'profile.age'        : 1,
      'profile.bio'        : 1,
      'profile.photos'     : 1,
      'profile.country'      : 1,
      'profile.stateProvince': 1,
      'profile.city'         : 1,
      'profile.prompts'    : 1,
      'profile.lat'        : 1,
      'profile.lng'        : 1,
      'profile.languages'  : 1,
      'profile.religion'   : 1,
      'profile.denomination': 1,
    };

    // ---- Fetch + count ----
    const [rawList, total] = await Promise.all([
      User.find(query).select(projection).sort(sort).skip(skip).limit(limit).lean(),
      User.countDocuments(query),
    ]);

    // ---- Enhance ----
    const meLat = currentUser?.profile?.lat;
    const meLng = currentUser?.profile?.lng;

    const enhance = (u) => {
      const isOnline = u.lastActive
        ? (now - new Date(u.lastActive).getTime() < 5 * 60 * 1000)
        : false;

      const distanceKm =
        typeof meLat === 'number' && typeof meLng === 'number' &&
        typeof u?.profile?.lat === 'number' && typeof u?.profile?.lng === 'number'
          ? haversineKm(meLat, meLng, u.profile.lat, u.profile.lng)   // <-- ensure this helper exists
          : null;

      return {
        ...u,
        isOnline,
        distanceKm,
        boostActive: computeBoostActive(u, now),                      // <-- ensure this helper exists
        memberLevel: tierOf(u), // free | silver | emerald (used by EJS crowns)
      };
    };

    let potentialMatches = (rawList || []).map(enhance);

    // ---- Radius post-filter + optional distance sort ----
    const radiusKm = toInt(filters.radiusKm, 0) || 0;
    if (radiusKm > 0 && typeof meLat === 'number' && typeof meLng === 'number') {
      potentialMatches = potentialMatches.filter(u =>
        typeof u.distanceKm === 'number' && u.distanceKm <= radiusKm
      );
    }
    if (filters.sort === 'distance') {
      potentialMatches.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));
    }

    // ---- Favorites & Wave flags for UI (non-destructive) ----
    const favoriteSet   = new Set((currentUser.favorites   || []).map(id => String(id)));
    const wavedSet      = new Set((currentUser.waved       || []).map(id => String(id)));
    const superLikedSet = new Set((currentUser.superLiked  || []).map(id => String(id)));

    potentialMatches = potentialMatches.map(u => {
      const idStr = String(u._id);
      return {
        ...u,
        isFavorite: favoriteSet.has(idStr),
        iWaved:     wavedSet.has(idStr),
        iSuperLiked: superLikedSet.has(idStr),
      };
    });

    // ---- Likes remaining (freemium) ----
    let likesRemaining = -1;
    if (!currentUser.isPremium) {
      const today   = new Date().toDateString();
      const lastDay = currentUser.lastLikeDate ? new Date(currentUser.lastLikeDate).toDateString() : null;
      if (today !== lastDay) {
        currentUser.likesToday   = 0;
        currentUser.lastLikeDate = new Date();
        await currentUser.save();
      }
      const used = Number(currentUser.likesToday || 0);
      likesRemaining = Math.max(DAILY_LIKE_LIMIT - used, 0);
    }

    // ---- Unread counts ----
    const [unreadNotificationCount, unreadMessages] = await Promise.all([
      Notification.countDocuments({ recipient: currentUser._id, read: false }),
      Message.countDocuments({ recipient: currentUser._id, read: false }),
    ]);

    // ---- Daily suggestions (newest) ----
    let dailySuggestions = [];
    try {
      const rawDaily = await User.find({ _id: { $nin: excludedUserIds }, profile: { $exists: true } })
        .select(projection)
        .sort({ createdAt: -1, _id: -1 })
        .limit(12)
        .lean();
      dailySuggestions = (rawDaily || []).map(enhance);
    } catch { dailySuggestions = []; }

    // Mirror flags on daily suggestions (optional)
    dailySuggestions = (dailySuggestions || []).map(u => {
      const idStr = String(u._id);
      return {
        ...u,
        isFavorite: favoriteSet.has(idStr),
        iWaved:     wavedSet.has(idStr),
      };
    });

    // ---- Streak ----
    const streak = { day: Number(currentUser.streakDay || 0), target: 7, percentage: 0 };
    streak.percentage = Math.max(0, Math.min(100, (streak.day / streak.target) * 100));

    // ---- Render ----
    return res.render('dashboard', {
      currentUser,
      potentialMatches,
      dailySuggestions,
      likesRemaining,
      unreadNotificationCount: unreadNotificationCount || 0,
      unreadMessages: unreadMessages || 0,
      filters,              // clamped filters (sticky)
      premiumLocks,         // which controls were locked
      pageMeta: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
        sort: sortKey,
      },
      streak,
    });
  } catch (err) {
    console.error('Error fetching dashboard:', err);
    return res.status(500).render('error', {
      status: 500,
      message: 'Something went wrong while loading your dashboard.',
    });
  }
});


const DAILY_LIKE_LIMIT = Number(process.env.DAILY_LIKE_LIMIT) || 10;

async function applyDailyLike(reqUserId, likedNow) {
  const user = await User.findById(reqUserId);
  if (!user) return;

  const todayKey = new Date().toDateString();
  const lastKey = user.lastLikeDate ? new Date(user.lastLikeDate).toDateString() : null;
  if (todayKey !== lastKey) {
    user.likesToday = 0;
    user.lastLikeDate = new Date();
  }
  if (likedNow) user.likesToday = (user.likesToday || 0) + 1;

  const GOAL = 5; // example target to advance streak
  if (user.likesToday >= GOAL) {
    const lastStreakKey = user.lastStreakDayKey;
    if (lastStreakKey !== todayKey) {
      user.streakDay = (user.streakDay || 0) + 1;
      user.lastStreakDayKey = todayKey;
    }
  }
  await user.save();
}

// simple in-memory cooldown (per process)
const WAVE_COOLDOWN_MS = 60 * 1000; // 1 min
const lastWave = new Map();          // key `${me}:${them}` -> ts

async function waveHandler(req, res) {
  try {
    const me   = String(req.session.userId || '');
    const them = String(req.params.id || '');

    if (!ObjectId.isValid(me) || !ObjectId.isValid(them) || me === them) {
      return res.status(400).json({ ok:false, error: 'bad_id' });
    }

    const meObj   = new ObjectId(me);
    const themObj = new ObjectId(them);

    // cooldown
    const key = `${me}:${them}`;
    const now = Date.now();
    if (lastWave.has(key) && (now - lastWave.get(key) < WAVE_COOLDOWN_MS)) {
      return res.status(429).json({ ok:false, error: 'cooldown' });
    }

    // Apply updates (idempotent via $addToSet).
    // Keep compatibility with your legacy fields (interests/interestedBy) AND new 'waved'.
    const [r1, r2] = await Promise.all([
      User.updateOne(
        { _id: meObj },
        { $addToSet: { interests: themObj, waved: themObj } }  // mine: I waved & I’m interested
      ),
      User.updateOne(
        { _id: themObj },
        { $addToSet: { interestedBy: meObj } }                  // theirs: they were waved at
      )
    ]);

    const firstTime = (r1.modifiedCount > 0); // only notify the first time I wave at them
    if (firstTime) {
      lastWave.set(key, now);
      const io = req.app.get('io');
      if (typeof createNotification === 'function') {
        await createNotification({
          io,
          recipientId: themObj,
          senderId: meObj,
          type: 'wave',                            // use 'wave' (fits our Notification enum)
          message: '👋 Someone waved at you!',
          extra: { link: `/users/${me}` }
        });
      }
    }

    return res.json({ ok:true, state: firstTime ? 'sent' : 'unchanged' });
  } catch (e) {
    console.error('wave err', e);
    return res.status(500).json({ ok:false });
  }
}

// Keep your original path + middleware (rate limits, id validator)
app.post(
  '/interest/:id',
  checkAuth,
  likeLimiter,
  validateObjectId('id'),
  validate,
  waveHandler,
  async (req, res) => {
    try {
      const me = req.session.userId;
      const them = req.params.id;
      if (String(me) === String(them)) {
        return res.status(400).json({ ok:false, error:'self' });
      }
      const [uMe, uThem] = await Promise.all([
        User.findById(me),
        User.findById(them),
      ]);
      if (!uMe || !uThem) return res.status(404).json({ ok:false });

      uMe.interests ||= [];
      uThem.interestedBy ||= [];
      if (!uMe.interests.some(x => String(x)===String(them))) uMe.interests.push(uThem._id);
      if (!uThem.interestedBy.some(x => String(x)===String(me))) uThem.interestedBy.push(uMe._id);

      await Promise.all([uMe.save(), uThem.save()]);

      await createNotification({
        io,
        recipientId: them,
        senderId: me,
        type: 'interest',
        message: 'sent you a wave 👋',
      });

      return res.json({ ok:true });
    } catch (e) {
      console.error('interest err', e);
      return res.status(500).json({ ok:false });
    }
  }
);

async function favoriteAddHandler(req, res) {
  try {
    const me   = String(req.session.userId || '');
    const them = String(req.params.id || '');

    if (!ObjectId.isValid(me) || !ObjectId.isValid(them) || me === them) {
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }

    const meObj   = new ObjectId(me);
    const themObj = new ObjectId(them);

    const result = await User.updateOne(
      { _id: meObj },
      { $addToSet: { favorites: themObj } }
    );

    // Notify only on first-time add
    if (result.modifiedCount > 0 && typeof createNotification === 'function') {
      const io = req.app.get('io');
      await createNotification({
        io,
        recipientId: themObj,
        senderId: meObj,
        type: 'favorite',
        message: 'Someone favorited you ⭐',
        extra: { link: `/users/${me}` },
      });
    }

    return res.json({ ok: true, state: result.modifiedCount > 0 ? 'added' : 'unchanged' });
  } catch (e) {
    console.error('favorite add err', e);
    return res.status(500).json({ ok: false });
  }
}

async function favoriteRemoveHandler(req, res) {
  try {
    const me   = String(req.session.userId || '');
    const them = String(req.params.id || '');

    if (!ObjectId.isValid(me) || !ObjectId.isValid(them)) {
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }

    const meObj   = new ObjectId(me);
    const themObj = new ObjectId(them);

    const result = await User.updateOne(
      { _id: meObj },
      { $pull: { favorites: themObj } }
    );

    return res.json({ ok: true, state: result.modifiedCount > 0 ? 'removed' : 'unchanged' });
  } catch (e) {
    console.error('favorite del err', e);
    return res.status(500).json({ ok: false });
  }
}

// --- Favorites (star) ---
app.post('/favorite/:id',
  checkAuth,
  likeLimiter,
  validateObjectId('id'),
  validate,
  favoriteAddHandler,
  async (req, res) => {
    try {
      const me = req.session.userId;
      const them = req.params.id;
      await User.updateOne({ _id: me }, { $addToSet: { favorites: them } });
      res.json({ ok:true });
    } catch (e) {
      console.error('favorite add err', e);
      res.status(500).json({ ok:false });
    }
  }
);

app.delete('/favorite/:id',
  checkAuth,
  likeLimiter,
  validateObjectId('id'),
  validate,
  favoriteRemoveHandler,
  async (req, res) => {
    try {
      const me = req.session.userId;
      const them = req.params.id;
      await User.updateOne({ _id: me }, { $pull: { favorites: them } });
      res.json({ ok:true });
    } catch (e) {
      console.error('favorite del err', e);
      res.status(500).json({ ok:false });
    }
  }
);

// --- PAGE: Favorites hub (my favorites + favorited me) ---
app.get('/favorites', checkAuth, async (req, res) => {
  try {
    const meId  = req.session.userId;
    const meObj = new mongoose.Types.ObjectId(meId);

    const currentUser = await User.findById(meId)
      .select('favorites waved isPremium profile username')
      .lean();
    if (!currentUser) return res.redirect('/login');

    const favoriteSet = new Set((currentUser.favorites || []).map(String));
    const wavedSet    = new Set((currentUser.waved || []).map(String));

    const projection = {
      username: 1,
      verifiedAt: 1,
      lastActive: 1,
      'profile.age': 1,
      'profile.city': 1,
      'profile.country': 1,
      'profile.photos': 1,
    };

    // My favorites (I starred them)
    let myFavorites = [];
    if ((currentUser.favorites || []).length) {
      const ids = currentUser.favorites.map(id => new mongoose.Types.ObjectId(id));
      const list = await User.find({ _id: { $in: ids } })
        .select(projection)
        .lean();
      myFavorites = list.map(u => ({
        ...u,
        isFavorite: true,
        iWaved: wavedSet.has(String(u._id)),
      }));
    }

    // Favorited me (people who starred me)
    const whoFavoritedMe = await User.find({ favorites: meObj })
      .select(projection)
      .lean();
    const favoritedMe = (whoFavoritedMe || []).map(u => ({
      ...u,
      isFavorite: favoriteSet.has(String(u._id)),
      iWaved: wavedSet.has(String(u._id)),
    }));

    // navbar counts
    const [unreadMessages, unreadNotificationCount] = await Promise.all([
      Message.countDocuments({ recipient: meObj, read: false, deletedFor: { $nin: [meObj] } }),
      Notification.countDocuments({ recipient: meObj, read: false }),
    ]);

    return res.render('favorites', {
      currentUser,
      myFavorites,
      favoritedMe,
      unreadMessages,
      unreadNotificationCount,
    });
  } catch (err) {
    console.error('favorites page err', err);
    return res.status(500).render('error', { status: 500, message: 'Failed to load favorites.' });
  }
});



// DISLIKE a user
app.post('/dislike/:id', checkAuth, dislikeLimiter, validateObjectId('id'), validate, async (req, res) => {
  console.log('[ROUTE] POST /dislike/%s by %s', req.params.id, req.session.userId);
    try {
      const currentUserId = req.session.userId;
      const dislikedUserId = req.params.id;

      await User.findByIdAndUpdate(
        currentUserId,
        { $addToSet: { dislikes: dislikedUserId }, $pull: { likes: dislikedUserId } }
      );

      return res.json({ status: 'success', message: 'User disliked successfully.' });
    } catch (err) {
      console.error('Error disliking user:', err);
      return res.status(500).json({ status: 'error', message: 'Server Error' });
    }
  }
);

// LIKE a user (freemium logic + notifications)
app.post('/like/:id', checkAuth, likeLimiter, validateObjectId('id'), validate, async (req, res) => {
  console.log('[ROUTE] POST /like/%s by %s', req.params.id, req.session.userId);
    try {
      const userIdToLike = req.params.id;
      const currentUserId = req.session.userId;

      console.log(`[LIKE] attempt: from ${currentUserId} to ${userIdToLike}`);

      if (!userIdToLike) {
        return res.status(400).json({ status: 'error', message: 'Missing user id.' });
      }
      if (String(userIdToLike) === String(currentUserId)) {
        return res.status(400).json({ status: 'error', message: 'You cannot like your own profile.' });
      }

      const [currentUser, likedUser] = await Promise.all([
        User.findById(currentUserId),
        User.findById(userIdToLike),
      ]);
      if (!currentUser || !likedUser) {
        return res.status(404).json({ status: 'error', message: 'User not found.' });
      }

      // reset daily on new day, enforce limit
      if (!currentUser.isPremium) {
        const today = new Date().toDateString();
        const lastLikeDay = currentUser.lastLikeDate ? new Date(currentUser.lastLikeDate).toDateString() : null;
        if (today !== lastLikeDay) currentUser.likesToday = 0;
        if ((currentUser.likesToday || 0) >= DAILY_LIKE_LIMIT) {
          return res.status(429).json({
            status: 'error',
            message: `You have reached your daily limit of ${DAILY_LIKE_LIMIT} likes. Upgrade to premium for unlimited likes!`,
            likesRemaining: 0,
          });
        }
      }

      // ensure arrays
      currentUser.likes   = currentUser.likes   || [];
      currentUser.matches = currentUser.matches || [];
      likedUser.likes     = likedUser.likes     || [];
      likedUser.matches   = likedUser.matches   || [];
      likedUser.likedBy   = likedUser.likedBy   || [];

      const hasId = (arr, id) => Array.isArray(arr) && arr.some(x => String(x) === String(id));

      // already liked
      if (hasId(currentUser.likes, userIdToLike)) {
        let likesRemaining = -1;
        if (!currentUser.isPremium) {
          likesRemaining = Math.max(DAILY_LIKE_LIMIT - (currentUser.likesToday || 0), 0);
        }
        return res.json({
          status: 'already-liked',
          message: 'You have already liked this user.',
          alreadyLiked: true,
          likesRemaining,
        });
      }

      // apply like
      currentUser.likes.push(likedUser._id);
      if (!hasId(likedUser.likedBy, currentUserId)) {
        likedUser.likedBy.push(currentUser._id);
      }

      // mutual match?
      let matchFound = false;
      if (hasId(likedUser.likes, currentUserId)) {
        if (!hasId(currentUser.matches, likedUser._id)) currentUser.matches.push(likedUser._id);
        if (!hasId(likedUser.matches, currentUser._id))  likedUser.matches.push(currentUser._id);
        matchFound = true;
      }

      // increment daily count for freemium
      if (!currentUser.isPremium) {
        currentUser.likesToday = (currentUser.likesToday || 0) + 1;
        currentUser.lastLikeDate = new Date();
      }

      await Promise.all([currentUser.save(), likedUser.save()]);

      // remaining likes (freemium)
      let likesRemaining = -1;
      if (!currentUser.isPremium) {
        likesRemaining = Math.max(DAILY_LIKE_LIMIT - (currentUser.likesToday || 0), 0);
      }

      if (matchFound) {
        await createNotification({
          io,
          recipientId: likedUser._id,
          senderId: currentUser._id,
          type: 'match',
          message: 'It is a match',
          extra: { threadUrl: `/messages?with=${currentUser._id}` },
        });

        return res.json({
          status: 'match',
          message: `${likedUser.username} is also a match!`,
          likesRemaining,
          threadUrl: `/messages?with=${userIdToLike}`,
        });
      } else {
        await createNotification({
          io,
          recipientId: likedUser._id,
          senderId: currentUser._id,
          type: 'like',
          message: 'liked you',
        });

        return res.json({ status: 'success', message: 'User liked!', likesRemaining });
      }
    } catch (err) {
      console.error('[LIKE] Error liking user:', err);
      return res.status(500).json({ status: 'error', message: 'Server error. ' + (err?.message || '') });
    }
  }
);

// BOOST (30 minutes; stacks if already active)
app.post('/api/boost', checkAuth, boostLimiter, async (req, res) => {
  console.log('[ROUTE] POST /api/boost by %s', req.session.userId);
    try {
      const user = await User.findById(req.session.userId);
      if (!user) return res.status(401).json({ ok: false, message: 'Unauthorized' });

      const nowMs = Date.now();
      const durationMs = 30 * 60 * 1000; // 30 min
      const currentExpiryMs = user.boostExpiresAt ? new Date(user.boostExpiresAt).getTime() : 0;
      const baseMs = (currentExpiryMs > nowMs) ? currentExpiryMs : nowMs;
      user.boostExpiresAt = new Date(baseMs + durationMs);
      await user.save();

      return res.json({ ok: true, boostActive: true, boostExpiresAt: user.boostExpiresAt });
    } catch (e) {
      console.error('Boost error:', e);
      return res.status(500).json({ ok: false, message: 'Could not activate boost' });
    }
  }
);

// ---- GET /upgrade ----
app.get('/upgrade', checkAuth, async (req, res) => {
  try {
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(404).send('User not found.');

    const plan    = planOf(user);
    const success = req.query.success || req.query.upgradeSuccess || null;
    const error   = req.query.error   || req.query.upgradeError   || null;

    return res.render('upgrade', { currentUser: user, plan, success, error });
  } catch (err) {
    console.error('upgrade page err', err);
    return res.status(500).send('Server Error');
  }
});

// GET /checkout/:plan -> create session and redirect to Stripe
app.get('/checkout/:plan', checkAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).send('Stripe not configured');

    const userId = req.session.userId;
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).send('User not found');

    const planParam = String(req.params.plan || '').toLowerCase(); // 'premium' | 'elite'
    const plan = (planParam === 'elite') ? 'elite' : 'premium';

    const priceId = plan === 'elite' ? STRIPE_PRICE_ID_ELITE : STRIPE_PRICE_ID_PREMIUM;
    if (!priceId) return res.status(400).send(`Price not configured for ${plan}`);

    const params = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${BASE_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${BASE_URL}/upgrade?upgradeError=cancelled`,
      client_reference_id: String(userId),
      metadata: { userId: String(userId), plan },
      allow_promotion_codes: true,
    };
    if (user.stripeCustomerId) params.customer = user.stripeCustomerId;

    // Helpful log while you’re testing
    console.log(`[stripe] create-checkout GET user=${userId} plan=${plan} price=${priceId}`);

    const session = await stripe.checkout.sessions.create(params);
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('GET /checkout/:plan err', err);
    return res.status(500).send('Failed to create checkout session');
  }
});

// ===== Create Checkout session (Premium/Elite) =====
app.post('/create-checkout-session', checkAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).send('Stripe not configured');

    const userId = req.session.userId;
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).send('User not found');

    // plan: 'premium' | 'elite'
    const plan = String(req.body.plan || 'premium').toLowerCase();
    const priceId = plan === 'elite' ? process.env.STRIPE_PRICE_ID_ELITE : process.env.STRIPE_PRICE_ID_PREMIUM;
    if (!priceId) return res.status(400).send(`Price not configured for ${plan}`);

    const successUrl = BASE_URL ? `${BASE_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`
                                : absoluteUrl(req, '/upgrade/success?session_id={CHECKOUT_SESSION_ID}');
    const cancelUrl  = BASE_URL ? `${BASE_URL}/upgrade?upgradeError=cancelled`
                                : absoluteUrl(req, '/upgrade?upgradeError=cancelled');

    const params = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url:  cancelUrl,
      client_reference_id: String(userId),
      metadata: { userId: String(userId), plan },
      allow_promotion_codes: true,
    };

    // Reuse customer if we already have one
    if (user.stripeCustomerId) params.customer = user.stripeCustomerId;

    const session = await stripe.checkout.sessions.create(params);
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('create-checkout-session err:', err);
    return res.status(500).send('Failed to create checkout session');
  }
});

// ===== Checkout Success (no webhook requirement for MVP) =====
app.get('/upgrade/success', checkAuth, async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.redirect('/upgrade?upgradeError=Missing session');

    const session = await stripe.checkout.sessions.retrieve(String(session_id), {
      expand: ['subscription.items.data.price']
    });

    if (!session || session.mode !== 'subscription') {
      return res.redirect('/upgrade?upgradeError=Invalid session');
    }

    const userId         = session.metadata?.userId || session.client_reference_id;
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;
    const customerId     = typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id;

    // Price id from the active subscription line
    let priceId = null;
    if (subscriptionId) {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
      priceId = sub.items?.data?.[0]?.price?.id || null;
    }

    if (userId) {
      await User.findByIdAndUpdate(userId, {
        $set: {
          stripeCustomerId: customerId || null,
          stripeSubscriptionId: subscriptionId || null,
          stripePriceId: priceId || null,
          subscriptionPriceId: priceId || null,
          isPremium: true,
          subscriptionStatus: 'active',
          subscriptionEndsAt: null
        }
      });
    }

    return res.redirect('/upgrade?upgradeSuccess=1');
  } catch (err) {
    console.error('upgrade success err:', err);
    return res.redirect('/upgrade?upgradeError=Could not finalize');
  }
});

// PRODUCTION-READY: Manage Subscription (Stripe Billing Portal)
app.post('/billing-portal', checkAuth, async (req, res) => {
  const startedAt = Date.now();

  // ---- helpers ----
  const baseUrlFromReq = () => {
    // Works behind a proxy if you set: app.set('trust proxy', 1)
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host  = (req.headers['x-forwarded-host']  || req.get('host'));
    return `${proto}://${host}`;
  };
  const absoluteUrl = (path) =>
    (process.env.BASE_URL ? new URL(path, process.env.BASE_URL).href
                          : new URL(path, baseUrlFromReq()).href);

  const timeoutAfter = (ms, label) =>
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms));

  try {
    if (!stripe) return res.redirect('/upgrade?upgradeError=Stripe not configured');

    const user = await User.findById(req.session.userId).lean();
    if (!user) return res.redirect('/login');

    // 1) Resolve customer id, backfill from subscription if needed
    let customerId = user.stripeCustomerId;
    if (!customerId && user.stripeSubscriptionId) {
      try {
        const sub = await Promise.race([
          stripe.subscriptions.retrieve(user.stripeSubscriptionId),
          timeoutAfter(12_000, 'Retrieve subscription')
        ]);
        const cust = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
        if (cust) {
          customerId = cust;
          await User.updateOne({ _id: user._id }, { $set: { stripeCustomerId: cust } });
        }
      } catch (e) {
        // soft-fail; we’ll error out below if still missing
        console.warn('[billing-portal] backfill failed');
      }
    }
    if (!customerId) {
      return res.redirect('/upgrade?upgradeError=No Stripe customer on file. Complete checkout first.');
    }

    // 2) Guard against key/data mode mismatch (very common prod bug)
    try {
      const cust = await Promise.race([
        stripe.customers.retrieve(customerId),
        timeoutAfter(12_000, 'Retrieve customer')
      ]);
      const key = process.env.STRIPE_SECRET_KEY || '';
      const keyMode  = key.startsWith('sk_live_') ? 'live' : (key.startsWith('sk_test_') ? 'test' : 'unknown');
      const custMode = cust.livemode ? 'live' : 'test';
      if (keyMode !== custMode) {
        return res.redirect(`/upgrade?upgradeError=Stripe key/data mode mismatch (${keyMode.toUpperCase()} vs ${custMode.toUpperCase()}).`);
      }
    } catch {
      return res.redirect('/upgrade?upgradeError=Stripe customer not found or unreachable.');
    }

    // 3) Build a safe return URL (HTTPS in prod, localhost ok in test)
    const returnUrl = process.env.BILLING_PORTAL_RETURN_URL || absoluteUrl('/upgrade');

    // 4) Create portal session; if a bad configuration id is set, fall back to default
    const args = { customer: customerId, return_url: returnUrl };

    if (process.env.STRIPE_PORTAL_CONFIG_ID) {
      try {
        const cfg = await Promise.race([
          stripe.billingPortal.configurations.retrieve(process.env.STRIPE_PORTAL_CONFIG_ID),
          timeoutAfter(8_000, 'Retrieve portal configuration')
        ]);
        if (cfg?.id) args.configuration = cfg.id;
      } catch {
        // Invalid/other-account/mode config id — ignore and use default
      }
    }

    const session = await Promise.race([
      stripe.billingPortal.sessions.create(args),
      timeoutAfter(12_000, 'Create portal session')
    ]);

    // 5) Redirect user to Stripe-hosted portal
    // Minimal log: duration only (avoid logging PII/ids in prod)
    console.info(`[billing-portal] ok in ${Date.now() - startedAt}ms`);
    return res.redirect(303, session.url);

  } catch (err) {
    // Friendly, non-leaky error message for users; keep details out of the UI
    const msg = String(err?.message || 'Could not open billing portal.');
    // Optional: you can branch on known messages here if you want finer UX
    console.error('[billing-portal] error'); // keep logs terse in prod
    return res.redirect('/upgrade?upgradeError=' + encodeURIComponent('Could not open billing portal.'));
  }
});

// ---- POST /subscription/cancel ----
app.post('/subscription/cancel', checkAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const user = await User.findById(req.session.userId).lean();
    if (!user?.stripeSubscriptionId) return res.status(400).json({ error: 'No subscription' });

    const sub = await stripe.subscriptions.update(user.stripeSubscriptionId, { cancel_at_period_end: true });
    return res.json({ status: 'cancelling', endsAt: sub.current_period_end * 1000 });
  } catch (err) {
    console.error('cancel sub err:', err);
    return res.status(500).json({ error: 'Failed to cancel' });
  }
});

// ---- helpers ----
async function isMutualMatch(aId, bId) {
  // True if A liked B AND B liked A
  const [aLikesB, bLikesA] = await Promise.all([
    User.exists({ _id: aId, likes: bId }),
    User.exists({ _id: bId, likes: aId }),
  ]);
  return Boolean(aLikesB && bLikesA);
}


async function loadThread(meId, otherId, opts = {}) {
  const limit  = Math.min(Math.max(parseInt(opts.limit || '50', 10), 1), 200);
  const before =
    (opts.before && !Number.isNaN(Date.parse(opts.before)))
      ? new Date(opts.before)
      : null;

  // Guard invalid ids
  if (!ObjectId.isValid(meId) || !ObjectId.isValid(otherId)) {
    return { peer: null, initialHistory: [] };
  }
  const me    = new ObjectId(meId);
  const other = new ObjectId(otherId);

  // Peer header info (add more fields if you show them)
  const peer = await User.findById(other)
    .select('username verifiedAt profile.photos profile.age profile.city profile.country')
    .lean();
  if (!peer) return { peer: null, initialHistory: [] };

  // Thread query — EXCLUDE messages soft-deleted for me
  const baseThreadQuery = {
    $or: [
      { sender: me,    recipient: other },
      { sender: other, recipient: me   }
    ],
    deletedFor: { $nin: [me] }  // ✅ correct way for array field
  };
  if (before) baseThreadQuery.createdAt = { $lt: before };

  // Oldest→newest for UI
  const initialHistory = await Message.find(baseThreadQuery)
    .sort({ createdAt: 1, _id: 1 })
    .limit(limit)
    .lean();

  // Mark unread peer->me as read (don’t count soft-deleted ones)
  await Message.updateMany(
    { sender: other, recipient: me, read: false, deletedFor: { $nin: [me] } },
    { $set: { read: true, readAt: new Date() } }
  );

  // Update my navbar unread badge (exclude soft-deleted)
  try {
    const unread = await Message.countDocuments({
      recipient: me,
      read: false,
      deletedFor: { $nin: [me] }
    });
    if (typeof io !== 'undefined') {
      io.to(me.toString()).emit('unread_update', { unread });
    }
  } catch (e) {
    console.error('unread emit err (loadThread)', e);
  }

  // Tell the other user I’ve read up to the latest timestamp
  try {
    const latest = await Message.findOne({
      sender: other,
      recipient: me,
      read: true,
      deletedFor: { $nin: [me] }
    }).sort({ createdAt: -1 }).select('createdAt').lean();

    if (latest?.createdAt && typeof io !== 'undefined') {
      io.to(other.toString()).emit('chat:read', {
        with: me.toString(),
        until: latest.createdAt
      });
    }
  } catch (e) {
    console.error('read receipt emit err (loadThread)', e);
  }

  return { peer, initialHistory };
}

// ---- GET /chat/:id ----
app.get('/chat/:id', checkAuth, async (req, res) => {
  try {
    const meId    = String(req.session.userId);
    const otherId = String(req.params.id);

    const currentUser = await User.findById(meId)
      .select('_id username isPremium stripePriceId subscriptionPriceId profile.videoChat profile.photos')
      .lean();
    if (!currentUser) return res.redirect('/login');

    // Load thread & peer
    const { peer, initialHistory } = await loadThread(meId, otherId);
    if (!peer) {
      return res.status(404).render('error', { status: 404, message: 'User not found.' });
    }

    // Ensure peer has the fields chat.ejs expects
    // (if loadThread already returns them, this is a no-op)
    const safePeer = {
      _id:        peer._id,
      username:   peer.username,
      profile:    peer.profile || {},
      isPremium:  peer.isPremium || false,
      stripePriceId:       peer.stripePriceId || null,
      subscriptionPriceId: peer.subscriptionPriceId || null,
      videoChat:  peer.videoChat ?? peer?.profile?.videoChat ?? false,
      photos:     peer?.profile?.photos || [],
    };

    // Mutual match (controls composer visibility)
    const isMatched = await isMutualMatch(meId, otherId);

    // Navbar badges (respect soft-deletes)
    const meObj = new ObjectId(meId);
    const [unreadMessages, unreadNotificationCount] = await Promise.all([
      Message.countDocuments({
        recipient: meObj,
        read: false,
        deletedFor: { $nin: [meObj] }
      }),
      Notification.countDocuments({ recipient: meObj, read: false }),
    ]);

    return res.render('chat', {
      currentUser,
      peer: safePeer,          // ✅ what chat.ejs expects
      otherUser: safePeer,     // (optional back-compat)
      isMatched,
      messages: initialHistory,
      initialHistory,
      unreadMessages,
      unreadNotificationCount
    });
  } catch (e) {
    console.error('chat route err', e);
    return res.status(500).render('error', { status: 500, message: 'Failed to load chat.' });
  }
});

// Threads page with optional ?with=<userId>
app.get('/messages', checkAuth, async (req, res) => {
  try {
    const currentUser = await User.findById(req.session.userId).lean();
    if (!currentUser) return res.redirect('/login');

    // Build matched users list
    const likedSet   = new Set((currentUser.likes   || []).map(id => id.toString()));
    const likedBySet = new Set((currentUser.likedBy || []).map(id => id.toString()));
    const matchedUserIdsStr = [...likedSet].filter(id => likedBySet.has(id));

    const matches = matchedUserIdsStr.length
      ? await User.find({ _id: { $in: matchedUserIdsStr } }).lean()
      : [];

    // Fast unread-per-thread (one aggregation)
const meId = new ObjectId(currentUser._id);
const matchedIds = matchedUserIdsStr.map(id => new ObjectId(id));
let unreadBy = {};
if (matchedIds.length) {
  const rows = await Message.aggregate([
    {
      $match: {
        recipient: meId,
        read: false,
        sender: { $in: matchedIds },
        deletedFor: { $nin: [meId] }  // ✅ exclude my soft-deletes
      }
    },
    { $group: { _id: '$sender', count: { $sum: 1 } } }
  ]);
  unreadBy = Object.fromEntries(rows.map(r => [String(r._id), r.count]));
}

// Optional lastMessage preview for each match (only visible-to-me)
const withLast = await Promise.all(matches.map(async (u) => {
  const lastMessage = await Message.findOne({
    $or: [
      { sender: currentUser._id, recipient: u._id },
      { sender: u._id,           recipient: currentUser._id }
    ],
    deletedFor: { $nin: [meId] }   // ✅ only messages I haven't soft-deleted
  })
  .sort({ createdAt: -1 })
  .populate('sender', 'username')
  .lean();
  return { ...u, lastMessage };
}));

// 👇 NEW: show only threads that still have visible messages, unless ?all=1
const showAll = String(req.query.all || '') === '1';
const listForView = showAll ? withLast : withLast.filter(u => !!u.lastMessage);

// If a thread is selected
let peer = null;
let initialHistory = [];
const peerId = req.query.with || null;
if (peerId) {
  ({ peer, initialHistory } = await loadThread(currentUser._id, peerId));
}

// Navbar badges (keep your soft-delete exclusion consistent if you like)
const [unreadMessages, unreadNotificationCount] = await Promise.all([
  Message.countDocuments({ recipient: currentUser._id, read: false, deletedFor: { $nin: [meId] } }),
  Notification.countDocuments({ recipient: currentUser._id, read: false })
]);

return res.render('messages', {
  currentUser,
  matches: listForView,     // ✅ filtered
  peer,
  initialHistory,
  unreadBy,
  unreadMessages,
  unreadNotificationCount,
  showAll                  // ✅ for the tiny toggle in the UI
});

  } catch (err) {
    console.error('Error fetching messages page:', err);
    return res.status(500).render('error', { status: 500, message: 'Failed to load messages.' });
  }
});

// Send a message (one true way)
app.post(
  '/api/messages',
  checkAuth,
  messagesLimiter,
  vMessageSend,
  async (req, res) => {
    try {
      const sender = req.session.userId;
      const { to: recipient, content } = req.body;

       // ✅ Block send if not matched (remove if you allow cold messages)
    const matched = await isMutualMatch(sender, recipient);
    if (!matched) {
      return res.status(403).json({ ok: false, code: 'not_matched', message: 'Chat requires a mutual match.' });
    }
      // Verify mutual match
      const saved = await new Message({
        sender,
        recipient,
        content: String(content).slice(0, 4000),
        read: false,
      }).save();

      // Use the same io reference style you use elsewhere
      const ioRef = req.io || req.app?.get?.('io') || (typeof io !== 'undefined' ? io : null);

      ioRef?.to(recipient.toString()).emit('chat:incoming', saved);
      ioRef?.to(sender.toString()).emit('chat:sent', saved);

      // ✅ Put THIS block right here (replaces your old unread count emit)
      const recipObj = new ObjectId(recipient);
      const unread = await Message.countDocuments({
        recipient: recipObj,
        read: false,
        deletedFor: { $nin: [recipObj] }   // exclude messages the recipient soft-deleted
      });
      ioRef?.to(recipient.toString()).emit('unread_update', { unread });
      // ✅ end replacement

      return res.json({ ok: true, message: saved });
    } catch (err) {
      console.error('send message err', err);
      return res.status(500).json({ ok: false });
    }
  }
);

app.post('/api/messages', checkAuth, messagesLimiter, vMessageSend, async (req, res) => {
  try {
    const sender = String(req.session.userId || '');
    let recipient = (req.body.to || req.body.recipient || '').trim();
    let content   = (req.body.content || '').trim();

    if (!sender) return res.status(401).json({ ok: false, error: 'auth' });
    if (!recipient || !ObjectId.isValid(recipient)) {
      return res.status(400).json({
        ok: false,
        errors: [{ type: 'field', msg: 'to must be a MongoId', path: 'to', location: 'body' }],
      });
    }
    if (recipient === sender) {
      return res.status(400).json({ ok: false, error: 'Cannot message yourself' });
    }
    content = content.slice(0, 4000);
    if (!content) {
      return res.status(400).json({
        ok: false,
        errors: [{ type: 'field', msg: 'content is required', path: 'content', location: 'body' }],
      });
    }

    // Require mutual match (keep/remove per your product rules)
    const matched = await isMutualMatch(sender, recipient);
    if (!matched) {
      return res.status(403).json({ ok: false, code: 'not_matched', message: 'Chat requires a mutual match.' });
    }

    const message = await Message.create({ sender, recipient, content, read: false });

    const ioRef = req.io || req.app?.get?.('io') || null;
    ioRef?.to(String(recipient)).emit('chat:incoming', message);
    ioRef?.to(String(sender)).emit('chat:sent', message);

    const recipObj = new ObjectId(recipient);
    const unread = await Message.countDocuments({
      recipient: recipObj,
      read: false,
      deletedFor: { $nin: [recipObj] }
    });
    ioRef?.to(String(recipient)).emit('unread_update', { unread });

    return res.json({ ok: true, message });
  } catch (err) {
    console.error('send message err', err);
    return res.status(500).json({ ok: false });
  }
});


// Mark a thread as read (robust + precise receipts)
app.post('/api/messages/:otherUserId/read', checkAuth, async (req, res) => {
  try {
    const me = new ObjectId(req.session.userId);
    const other = new ObjectId(req.params.otherUserId);

    const visibleFromOtherToMe = {
      sender: other,
      recipient: me,
      deletedFor: { $nin: [me] }    // ✅ correct for array field
    };

    await Message.updateMany(
      { ...visibleFromOtherToMe, read: { $ne: true } },
      { $set: { read: true, readAt: new Date() } }
    );

    const latest = await Message.findOne(visibleFromOtherToMe)
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const unread = await Message.countDocuments({
      recipient: me,
      read: false,
      deletedFor: { $nin: [me] }     // ✅ keep consistent
    });

    const ioRef = req.io || req.app?.get?.('io') || (typeof io !== 'undefined' ? io : null);
    ioRef?.to(me.toString()).emit('unread_update', { unread });

    if (latest?.createdAt) {
      ioRef?.to(other.toString()).emit('chat:read', {
        with: me.toString(),
        until: latest.createdAt
      });
    }

    return res.json({ ok: true, unread, until: latest?.createdAt || null });
  } catch (e) {
    console.error('mark read err', e);
    return res.status(500).json({ ok: false });
  }
});

// GET /api/messages/:otherUserId?before=ISO&limit=30
app.get('/api/messages/:otherUserId', checkAuth, async (req, res) => {
  try {
    const me     = new ObjectId(req.session.userId);
    const other  = new ObjectId(req.params.otherUserId);
    const before = isNaN(Date.parse(req.query.before)) ? new Date() : new Date(req.query.before);
    const limit  = Math.min(parseInt(req.query.limit || '30', 10), 100);

    const items = await Message.find({
      $or: [
        { sender: me,    recipient: other },
        { sender: other, recipient: me    }
      ],
      deletedFor: { $nin: [me] },       // ✅ exclude my soft-deletes
      createdAt: { $lt: before }
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

    return res.json({ items });
  } catch (e) {
    console.error('fetch thread err', e);
    return res.status(500).json({ items: [] });
  }
});

// Unread counts per matched thread (and total) — excludes soft-deleted
app.get('/api/unread/threads', checkAuth, async (req, res) => {
  try {
    const me = req.session.userId;
    const meId = new mongoose.Types.ObjectId(me); // ✅ define meId once, as ObjectId

    // Build mutual match set from likes/likedBy
    const meDoc = await User.findById(meId).select('likes likedBy').lean();
    if (!meDoc) return res.status(401).json({ ok: false, by: {}, total: 0 });

    const likedSet   = new Set((meDoc.likes   || []).map(id => id.toString()));
    const likedBySet = new Set((meDoc.likedBy || []).map(id => id.toString()));
    const matchedIdsStr = [...likedSet].filter(id => likedBySet.has(id));

    if (matchedIdsStr.length === 0) {
      return res.json({ ok: true, by: {}, total: 0 });
    }

    const matchedIds = matchedIdsStr.map(id => new mongoose.Types.ObjectId(id));

    // Count unread (recipient = me, read=false) per matched sender,
    // and ignore messages I've soft-deleted (deletedFor: { $nin: [meId] })
    const rows = await Message.aggregate([
      {
        $match: {
          recipient: meId,
          read: false,
          sender: { $in: matchedIds },
          deletedFor: { $nin: [meId] }
        }
      },
      { $group: { _id: '$sender', count: { $sum: 1 } } }
    ]);

    const by = Object.fromEntries(rows.map(r => [String(r._id), r.count]));
    const total = rows.reduce((acc, r) => acc + r.count, 0);

    return res.json({ ok: true, by, total });
  } catch (e) {
    console.error('unread threads err', e);
    return res.status(500).json({ ok: false, by: {}, total: 0 });
  }
});

app.get('/api/unread/messages', checkAuth, async (req, res) => {
  try {
    const meObj = new mongoose.Types.ObjectId(req.session.userId);
    const count = await Message.countDocuments({ recipient: meObj, read: false, deletedFor: { $nin: [meObj] } });
    res.json({ ok: true, count });
  } catch (e) { res.json({ ok: false, count: 0 }); }
});

app.get('/api/unread/notifications', checkAuth, async (req, res) => {
  try {
    const meObj = new mongoose.Types.ObjectId(req.session.userId);
    const count = await Notification.countDocuments({ recipient: meObj, read: false });
    res.json({ ok: true, count });
  } catch (e) { res.json({ ok: false, count: 0 }); }
});


// --- Bulk delete/report for messages (soft-delete via deletedFor) ---
app.post('/api/messages/bulk', checkAuth, async (req, res) => {
  try {
    const meId  = String(req.session.userId || '');
    if (!mongoose.Types.ObjectId.isValid(meId)) {
      return res.status(401).json({ ok: false });
    }
    const meObj = new mongoose.Types.ObjectId(meId);

    const body = req.body || {};
    const action = String(body.action || 'deleteThreads'); // 'deleteThreads' | 'deleteMessages' | 'report'
    const threadUserIds = Array.isArray(body.threadUserIds) ? body.threadUserIds : [];
    const messageIds    = Array.isArray(body.messageIds)    ? body.messageIds    : [];

    let modified = 0;

    // delete entire threads with specified peers
    if (action === 'deleteThreads' && threadUserIds.length) {
      const peers = threadUserIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (peers.length) {
        const result = await Message.updateMany(
          {
            deletedFor: { $nin: [meObj] },
            $or: peers.map(pid => ({
              $or: [
                { sender: meObj, recipient: pid },
                { sender: pid, recipient: meObj },
              ]
            }))
          },
          { $addToSet: { deletedFor: meObj } }
        );
        modified += Number(result.modifiedCount || 0);
      }
    }

    // delete specific messages
    if (action === 'deleteMessages' && messageIds.length) {
      const ids = messageIds
        .filter(id => mongoose.Types.ObjectId.isValid(id))
        .map(id => new mongoose.Types.ObjectId(id));

      if (ids.length) {
        const result = await Message.updateMany(
          { _id: { $in: ids }, deletedFor: { $nin: [meObj] } },
          { $addToSet: { deletedFor: meObj } }
        );
        modified += Number(result.modifiedCount || 0);
      }
    }

    // simple report hook (extend if you store reports)
    if (action === 'report' && (messageIds.length || threadUserIds.length)) {
      // no-op: add your Moderation model here if needed
    }

    return res.json({ ok: true, modified });
  } catch (err) {
    console.error('/api/messages/bulk err', err);
    return res.status(500).json({ ok: false });
  }
});


app.post('/a', analyticsLimiter, async (req, res) => {
  try {
    const { event, payload, ts, path } = req.body || {};
    if (!event || typeof event !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing event name' });
    }
    const doc = {
      user: req.session?.userId || null,
      event,
      payload: (payload && typeof payload === 'object') ? payload : {},
      path: path || req.originalUrl,
      ua: req.get('user-agent') || '',
      ip: (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '').trim(),
      at: ts ? new Date(ts) : new Date(),
    };
    await AnalyticsEvent.create(doc);
    return res.json({ ok: true });
  } catch (e) {
    console.error('analytics err', e);
    return res.status(200).json({ ok: true }); // don’t break UX if logging fails
  }
});
// --- Save lat/lng for distance on cards ---
app.post('/api/profile/location', checkAuth, vSetLocation, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const user = await User.findById(req.session.userId);
    if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    user.profile = user.profile || {};
    user.profile.lat = Number(lat);
    user.profile.lng = Number(lng);
    await user.save();

    return res.json({ ok: true });
  } catch (e) {
    console.error('location save error', e);
    return res.status(500).json({ ok: false, error: 'Failed to save location' });
  }
});


app.get('/_probe', (req, res) => {
  res.send(`
    <html>
      <head>
        <link rel="stylesheet" href="/css/app.css">
      </head>
      <body>
        <h1>Probe</h1>
        <p>If this text is styled, static is working.</p>
        <img src="/images/logo.png" onerror="this.insertAdjacentHTML('afterend','<p>logo not found</p>')">
      </body>
    </html>
  `);
});

// Global error-handling middleware (place at the end, before server.listen)
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  const message = err.message || 'Unexpected server error';
  try {
    res.status(status).render('error', { status, message });
  } catch {
    res.status(status).send(`${status} ${message}`);
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
