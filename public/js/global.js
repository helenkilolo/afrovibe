// public/js/global.js
(() => {
  if (window.__globalInit) return;
  window.__globalInit = true;

  const sock = window.socket || (window.io ? io() : null);
  const me = document.documentElement.getAttribute('data-me') || '';

  function setBadge(sel, n) {
    const el = document.querySelector(sel);
    if (!el) return;
    const num = Number(n) || 0;
    if (num <= 0) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = String(num);
  }

  if (sock) {
    if (me) sock.emit('register_for_notifications', me);

    sock.on('unread_update', (p) => setBadge('[data-role="nav-unread-msgs"]', p?.unread || 0));
    sock.on('notif_update',  (p) => setBadge('[data-role="nav-unread-notifs"]', p?.unread || 0));
  }

  // Normalize on load (SSR may be stale)
  fetch('/api/unread/messages', { credentials: 'same-origin' })
    .then(r => r.json()).then(j => setBadge('[data-role="nav-unread-msgs"]', j.count || 0))
    .catch(() => {});
  fetch('/api/unread/notifications', { credentials: 'same-origin' })
    .then(r => r.json()).then(j => setBadge('[data-role="nav-unread-notifs"]', j.count || 0))
    .catch(() => {});
})();
