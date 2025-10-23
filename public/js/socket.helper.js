
(() => {
  // Prevent double-loading
  if (window.__socketHelperLoaded) return;
  window.__socketHelperLoaded = true;

  // ---- Singleton socket ----
  const socket = (window.__appSocket = window.__appSocket || io({
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    // transports: ['websocket'], // uncomment for WS-only if desired
  }));
  window.socket = socket; // optional alias

  // ---- Utils ----
  function getCurrentUserId() {
    return (
      document.getElementById('currentUserId')?.value ||
      window.currentUserId || // optional global fallback
      ''
    );
  }

  // Idempotent room registration so we don't re-register on every reconnect
  function registerOnce(userId) {
    const uid = String(userId || '');
    if (!uid) return;
    if (window.__notifRegisteredFor === uid) return; // already registered for this user
    socket.emit('register_for_notifications', uid);
    window.__notifRegisteredFor = uid;
  }

  // Small throttle helper (used to expose a typing emitter)
  function throttle(fn, ms) {
    let last = 0, t = null;
    return (...args) => {
      const now = Date.now();
      const wait = ms - (now - last);
      if (wait <= 0) { last = now; fn(...args); }
      else {
        clearTimeout(t);
        t = setTimeout(() => { last = Date.now(); fn(...args); }, wait);
      }
    };
  }

  // ---- Lifecycle hooks ----
  // Register once DOM is ready (covers SSR where hidden input is present)
  document.addEventListener('DOMContentLoaded', () => {
    registerOnce(getCurrentUserId());
  });

  // Also re-register on socket reconnect
  socket.on('connect', () => {
    registerOnce(getCurrentUserId());
  });

  // And when tab regains focus (helps with SPA-ish navigation)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      registerOnce(getCurrentUserId());
    }
  });

  // ---- Generic incoming events ----

  // Increment a notifications badge if present
  socket.on('new_notification', () => {
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
  });

  // Increment a messages badge in a generic way
  socket.on('new_message', () => {
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

  // Live unread counts (server may emit these)
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

  // If your server denies RTC based on plan and throws 'upgrade-required'
  socket.on('connect_error', (err) => {
    if (String(err?.message).includes('upgrade-required')) {
      window.location.href = '/upgrade?reason=video';
    }
  });

  // ---- Typing helper (pages can call: window.emitTyping(peerId)) ----
  const _emitTyping = (to) => {
    const toId = String(to || '');
    if (!toId) return;
    socket.emit('chat:typing', { to: toId });
  };
  window.emitTyping = throttle(_emitTyping, 1200);
})();
