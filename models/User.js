// models/User.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

/* ---------- Profile subdocument (kept aligned to /dashboard & /advanced-search) ---------- */
const UserProfileSchema = new Schema(
  {
    firstName: { type: String, trim: true },

    // Core
    age: { type: Number, min: 18, max: 120 },
    gender: { type: String, enum: ['Male', 'Female', 'Other'] },

    // Place
    country: { type: String, trim: true },
    stateProvince: { type: String, trim: true },
    city: { type: String, trim: true },
    location: { type: String, trim: true },

    // Media
    photos: [{ type: String, trim: true }],

    // Bio & prompts
    bio: { type: String, trim: true },
    prompts: [{ type: String, trim: true }],

    // Culture / lifestyle (used by filters)
    languages: [{ type: String, trim: true }],
    religion: { type: String, trim: true },
    denomination: { type: String, trim: true },
    education: { type: String, trim: true },
    smoking: { type: String, trim: true },
    drinking: { type: String, trim: true },

    // Availability
    videoChat: { type: Boolean, default: false }, // ✅ used by "Available for Video Chat" filter

    // Geo for distance
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
  },
  { _id: false }
);

/* -------------------------------- Main User schema -------------------------------- */
const userSchema = new Schema({
  // Auth
  username: { type: String, required: true, unique: true, trim: true },
  email:    { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },

  // Profile
  profile: { type: UserProfileSchema, default: {} },

  // Graph
  likes:        [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  likedBy:      [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  dislikes:     [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  blockedUsers: [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  matches:      [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }], // optional

  // “Wave / Interest” (compat + new)
  interests:    [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }], // legacy name
  interestedBy: [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }], // legacy name
  waved:        [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],

  // Favorites ⭐
  favorites:    [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],

  // Super-likes ⚡
  superLiked:      [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  superLikedBy:    [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  superLikesToday: { type: Number, default: 0 },
  lastSuperLikeDate: { type: Date, default: null },

  // “Viewed me”
  views: [{
    user: { type: Schema.Types.ObjectId, ref: 'User' },
    at:   { type: Date, default: Date.now }
  }],

  // Freemium / streaks
  likesToday:         { type: Number, default: 0 },
  lastLikeDate:       { type: Date, default: null },
  streakDay:          { type: Number, default: 0 },
  lastStreakDayKey:   { type: String, default: null }, // e.g., toDateString()

  // Premium / subs (plan helpers read stripePriceId/subscriptionPriceId)
  isPremium:            { type: Boolean, default: false }, // legacy flag
  stripeCustomerId:     { type: String, default: null },
  stripeSubscriptionId: { type: String, default: null },
  stripePriceId:        { type: String, default: null },
  subscriptionPriceId:  { type: String, default: null },
  subscriptionStatus:   {
    type: String,
    enum: ['active','incomplete','past_due','canceled','trialing','unpaid','canceling', null],
    default: null
  },
  subscriptionEndsAt: { type: Date, default: null },

  // Boost / Spotlight
  boostExpiresAt:     { type: Date, default: null },
  spotlightExpiresAt: { type: Date, default: null }, // optional future use

  // Verification
  verifiedAt:      { type: Date, default: null }, // selfie/manual verify
  emailVerifiedAt: { type: Date, default: null },

  // Email OTP (for free email verification)
  emailOtpHash:        { type: String, default: null },
  emailOtpExpiresAt:   { type: Date,   default: null },
  emailOtpAttempts:    { type: Number, default: 0 },
  emailOtpRequestedAt: { type: Date,   default: null },
  emailOtpLastIP:      { type: String, default: null },

  // Likes-you reveal (1/day token for free users)
  likesRevealDay:   { type: String,  default: null }, // toDateString()
  likesRevealCount: { type: Number,  default: 0 },

  // Activity
  isOnline:   { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now },
});

/* ------------------------------ Indexes (safe to sync) ------------------------------ */
// General
userSchema.index({ boostExpiresAt: -1 });
userSchema.index({ lastActive: -1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ verifiedAt: 1 });
userSchema.index({ emailVerifiedAt: 1 });

// Search & geo
userSchema.index({ 'profile.age': 1 });
userSchema.index({ username: 'text', 'profile.bio': 'text' }); // one text index/collection
userSchema.index({ 'profile.lat': 1, 'profile.lng': 1 });

// Multikey lookups
userSchema.index({ likes: 1 });
userSchema.index({ likedBy: 1 });
userSchema.index({ favorites: 1 });
userSchema.index({ waved: 1 });

// Views (subdocs)
userSchema.index({ 'views.at': -1 });
userSchema.index({ 'views.user': 1, 'views.at': -1 });

// Super-likes
userSchema.index({ superLiked: 1 });
userSchema.index({ superLikedBy: 1 });

// Video chat availability
userSchema.index({ 'profile.videoChat': 1 });

/* ------------------------------- Middleware (minor) ------------------------------- */
userSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('User', userSchema);
