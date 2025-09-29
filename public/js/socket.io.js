// public/js/socket.io.js
// Single, robust socket helper used across all pages.

(() => {
  // Prevent double-loading if the script tag appears twice
  if (window.__socketHelperLoaded) return;
  window.__socketHelperLoaded = true;

  // ---- Singleton socket ----
  window.__appSocket = window.__appSocket || io({
    withCredentials: true,
    // transports: ['websocket'], // uncomment if you want WS-only
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });
  const socket = window.__appSocket;
  window.socket = socket; // optional global alias

  // ---- Utils ----
  function getCurrentUserId() {
    return (
      document.getElementById('currentUserId')?.value ||
      window.currentUserId || // fallback if set globally
      ''
    );
  }

  // Idempotent registration per userId
  function registerOnce(userId) {
    const uid = String(userId || '');
    if (!uid) return;
    if (window.__notifRegisteredFor === uid) return; // already registered
    socket.emit('register_for_notifications', uid);
    window.__notifRegisteredFor = uid;
    // console.debug('[socket] registered for notifications', uid);
  }

  // Small throttle util (for typing, etc.)
  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    return (...args) => {
      const now = Date.now();
      const remaining = ms - (now - last);
      if (remaining <= 0) {
        last = now;
        fn(...args);
      } else {
        clearTimeout(timer);
        timer = setTimeout(() => {
          last = Date.now();
          fn(...args);
        }, remaining);
      }
    };
  }

  // ---- Lifecycle ----
  // Register on DOM ready (covers SSR pages that render the hidden input)
  document.addEventListener('DOMContentLoaded', () => {
    registerOnce(getCurrentUserId());
  });

  // Also register on (re)connect in case of refresh/reconnect
  socket.on('connect', () => {
    registerOnce(getCurrentUserId());
  });

  // If the tab regains focus, ensure we’re registered (guards SPA navigations)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      registerOnce(getCurrentUserId());
    }
  });

  // ---- Incoming events (generic; feature pages can add their own too) ----

  // Notifications: bump a badge if present
  socket.on('new_notification', (payload) => {
    // Try a few selectors to find your nav badge
    const el =
      document.querySelector('[data-nav-notif]') ||
      document.getElementById('notifBadge') ||
      document.querySelector('.notif-badge') ||
      document.querySelector('.indicator .indicator-item');

    if (el) {
      const n = parseInt(el.textContent || '0', 10) || 0;
      el.textContent = String(n + 1);
      el.classList.remove('hidden');
    }

    // Optional: toast UI could go here
    // console.log('[notif] incoming', payload);
  });

  // Messages: pages like /messages or /chat have their own handlers,
  // but we still allow a generic fallback to nudge a global badge.
  socket.on('new_message', (m) => {
    // If thread list / chat page is open, their page JS will handle it.
    // Here we just update a global unread badge if present.
    const el =
      document.querySelector('[data-nav-msg]') ||
      document.getElementById('msgBadge') ||
      document.querySelector('.msg-badge');

    if (el) {
      const n = parseInt(el.textContent || '0', 10) || 0;
      el.textContent = String(n + 1);
      el.classList.remove('hidden');
    }
  });

  // Live unread/notification count updates (if your server emits these)
  socket.on('unread_update', (data) => {
    const count = Number(data?.unread || 0);
    const el =
      document.querySelector('[data-nav-msg]') ||
      document.getElementById('msgBadge') ||
      document.querySelector('.msg-badge');
    if (el) {
      el.textContent = String(count);
      el.classList.toggle('hidden', count <= 0);
    }
  });

  socket.on('notif_update', (data) => {
    const count = Number(data?.unread || 0);
    const el =
      document.querySelector('[data-nav-notif]') ||
      document.getElementById('notifBadge') ||
      document.querySelector('.notif-badge');
    if (el) {
      el.textContent = String(count);
      el.classList.toggle('hidden', count <= 0);
    }
  });

  // Typing relay (optional): expose a helper with throttle
  const _emitTyping = (to) => {
    const toId = String(to || '');
    if (!toId) return;
    socket.emit('typing', { to: toId });
  };
  const emitTyping = throttle(_emitTyping, 1200); // at most once every 1.2s
  window.emitTyping = emitTyping; // page JS can call: emitTyping(peerId)

  // Debug (optional):
  // socket.on('connect_error', (e) => console.warn('[socket] connect_error', e));
  // socket.on('reconnect_attempt', (n) => console.log('[socket] reconnect_attempt', n));
})();
