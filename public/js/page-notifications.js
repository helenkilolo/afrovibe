// public/js/page-notifications.js
(function () {
  const meId = document.getElementById('currentUserId')?.value || '';
  const list = document.getElementById('notifList');
  const loading = document.getElementById('loadingMore');
  const btnAll = document.getElementById('markAllRead');

  // socket singleton
  const socket = window.socket || (window.socket = io());
  socket.on('connect', () => { if (meId) socket.emit('register_for_notifications', meId); });

  // Live: prepend new notifications
  socket.on('new_notification', (n) => {
    if (!list) return;
    const li = document.createElement('li');
    li.className = 'p-3 rounded-xl border flex items-start gap-3';
    li.dataset.id = n._id || n.id || '';
    li.dataset.ts = new Date(n.createdAt || Date.now()).toISOString();
    li.innerHTML = `
      <div class="w-10 h-10 rounded-full bg-base-200 flex items-center justify-center shrink-0">
        ${iconFor(n.type)}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm">${escapeHtml(n.message || titleFor(n.type))}</div>
        <div class="text-[11px] opacity-60">${new Date(n.createdAt || Date.now()).toLocaleString()}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <form method="post" action="/notifications/${encodeURIComponent(li.dataset.id)}/mark-read">
          <button class="btn btn-ghost btn-xs">Mark read</button>
        </form>
        <button class="btn btn-outline btn-xs dismiss-btn" data-id="${encodeURIComponent(li.dataset.id)}">Dismiss</button>
      </div>
    `;
    list.insertBefore(li, list.firstChild);
    bumpNavBadge(1);
  });

  // Optional live badge update from server
  socket.on('notif_update', (p) => {
    if (typeof p?.unread === 'number') setNavBadge(p.unread);
  });

  // Mark all read
  btnAll?.addEventListener('click', async () => {
    try {
      const r = await fetch('/notifications/mark-all-read', { method: 'POST', credentials: 'same-origin' });
      const d = await r.json();
      if (!d?.ok) throw 0;
      list?.querySelectorAll('li').forEach(li => li.classList.add('opacity-70'));
      list?.querySelectorAll('form[action*="/mark-read"]').forEach(f => f.remove());
      setNavBadge(0);
    } catch { alert('Could not mark all as read.'); }
  });

  // Dismiss (soft delete)
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.dismiss-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    btn.disabled = true;
    try {
      const r = await fetch(`/notifications/dismiss/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok || d?.status !== 'success') throw 0;
      list?.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.remove();
      if (typeof d.unread === 'number') setNavBadge(d.unread);
    } catch { alert('Could not dismiss.'); btn.disabled = false; }
  });

  // Infinite scroll (uses /api/notifications feed)
  let loadingMore = false, reachedEnd = false;
  window.addEventListener('scroll', async () => {
    if (loadingMore || reachedEnd) return;
    if (window.innerHeight + window.scrollY < document.body.offsetHeight - 200) return;
    loadingMore = true;
    loading?.classList.remove('hidden');
    try {
      const lastTs = list?.lastElementChild?.getAttribute('data-ts');
      const url = new URL('/api/notifications', location.origin);
      if (lastTs) url.searchParams.set('before', lastTs);
      const r = await fetch(url, { credentials: 'same-origin' });
      const d = await r.json();
      const arr = Array.isArray(d.items) ? d.items : [];
      if (!arr.length) { reachedEnd = true; return; }
      const frag = document.createDocumentFragment();
      arr.forEach(n => {
        const li = document.createElement('li');
        li.className = 'p-3 rounded-xl border flex items-start gap-3 ' + (n.read ? 'opacity-70' : '');
        li.dataset.id = n._id;
        li.dataset.ts = new Date(n.createdAt).toISOString();
        li.innerHTML = `
          <div class="w-10 h-10 rounded-full bg-base-200 flex items-center justify-center shrink-0">
            ${iconFor(n.type)}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-sm">${escapeHtml(n.message || titleFor(n.type))}</div>
            <div class="text-[11px] opacity-60">${new Date(n.createdAt).toLocaleString()}</div>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${n.read ? '' : `<form method="post" action="/notifications/${encodeURIComponent(n._id)}/mark-read">
                                <button class="btn btn-ghost btn-xs">Mark read</button>
                              </form>`}
            <button class="btn btn-outline btn-xs dismiss-btn" data-id="${encodeURIComponent(n._id)}">Dismiss</button>
          </div>
        `;
        frag.appendChild(li);
      });
      list?.appendChild(frag);
    } catch {}
    finally { loadingMore = false; loading?.classList.add('hidden'); }
  }, { passive: true });

  // helpers
  function iconFor(t){ return (t==='match'?'🎉':t==='like'?'❤️':t==='favorite'?'⭐':t==='wave'?'👋':'🔔'); }
  function titleFor(t){ return (t||'').replace(/^./, c => c.toUpperCase()); }
  function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function bumpNavBadge(delta){
    const el = document.querySelector('[data-role="nav-notifications"]') || document.querySelector('.indicator-item');
    if (!el) return;
    const n = parseInt(el.textContent || '0', 10) || 0;
    setNavBadge(Math.max(n + delta, 0));
  }
  function setNavBadge(n){
    const el = document.querySelector('[data-role="nav-notifications"]') || document.querySelector('.indicator-item');
    if (!el) return;
    el.textContent = String(n);
    el.hidden = !(Number(n) > 0);
  }
})();
