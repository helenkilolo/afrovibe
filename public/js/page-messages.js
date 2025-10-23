// public/js/page-messages.js
(() => {
  const list          = document.getElementById('threadList');
  const enterManage   = document.getElementById('enterManage');
  const cancelManage  = document.getElementById('cancelManage');
  const deleteBtn     = document.getElementById('deleteThreads');

  let managing = false;
  const selected = new Set();

  function setManaging(on) {
    managing = !!on;
    enterManage?.classList.toggle('hidden', managing);
    cancelManage?.classList.toggle('hidden', !managing);
    deleteBtn?.classList.toggle('hidden', !managing);

    // show/hide checkboxes and clear selection when exiting
    list?.querySelectorAll('.threadChk').forEach(cb => {
      cb.classList.toggle('hidden', !managing);
      if (!managing) cb.checked = false;
    });
    list?.querySelectorAll('li[data-user-id]').forEach(li => {
      li.classList.toggle('bg-base-200/60', false);
    });
    selected.clear();
    updateDeleteCount();
  }

  function updateDeleteCount() {
    if (!deleteBtn) return;
    const n = selected.size;
    deleteBtn.textContent = n > 0 ? `Delete (${n})` : 'Delete';
    deleteBtn.disabled = n === 0;
  }

  enterManage?.addEventListener('click', () => setManaging(true));
  cancelManage?.addEventListener('click', () => setManaging(false));

  // Toggle selection helper
  function toggleRow(li, force) {
    const id = li?.dataset?.userId || '';
    if (!id) return;

    const cb = li.querySelector('.threadChk');
    const newState = typeof force === 'boolean' ? force : !cb.checked;

    cb.checked = newState;
    li.classList.toggle('bg-base-200/60', newState);

    if (newState) selected.add(id);
    else selected.delete(id);

    updateDeleteCount();
  }

  // Click handling:
  // - In manage mode: clicking ANYWHERE in the row toggles selection (and stops navigation)
  // - Outside manage mode: normal link to /chat/:id
  list?.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-user-id]');
    if (!li) return;

    // direct checkbox click – don't bubble to link
    if (e.target.classList.contains('threadChk')) {
      e.stopPropagation();
      toggleRow(li, e.target.checked);
      e.preventDefault();
      return;
    }

    if (managing) {
      e.preventDefault(); // stop <a> navigation
      toggleRow(li);
    }
  });

  // Keyboard accessibility: Space toggles when focused in manage mode
  list?.addEventListener('keydown', (e) => {
    if (!managing) return;
    if (e.key !== ' ' && e.key !== 'Spacebar') return;
    const li = e.target.closest('li[data-user-id]');
    if (!li) return;
    e.preventDefault();
    toggleRow(li);
  });

  // Bulk delete (soft-delete)
  deleteBtn?.addEventListener('click', async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return; // should be disabled already
    if (!confirm(`Delete ${ids.length} conversation${ids.length > 1 ? 's' : ''} for you?`)) return;

    try {
      const res = await fetch('/api/messages/bulk', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteThreads', threadUserIds: ids })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error('Failed');

      // Remove rows from DOM
      ids.forEach(id => list.querySelector(`li[data-user-id="${id}"]`)?.remove());
      setManaging(false);
    } catch {
      alert('Could not delete threads.');
    }
  });

  // Unread badges (optional)
  (async function hydrateUnread() {
    try {
      const r = await fetch('/api/unread/threads', { credentials: 'same-origin' });
      const j = await r.json();
      if (!j?.ok) return;
      const by = j.by || {};
      Object.keys(by).forEach(uid => {
        const el = document.querySelector(`[data-unread-for="${uid}"]`);
        if (!el) return;
        const n = Number(by[uid] || 0);
        if (n > 0) {
          el.textContent = String(n);
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });
    } catch {}
  })();
})();
