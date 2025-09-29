// /public/js/dashboard.js
(() => {
  // ---------- tiny utils ----------
  const $  = (s, r=document) => r.querySelector(s);
  const on = (el, ev, fn, opts) => el && el.addEventListener(ev, fn, opts);

  function delegate(selector, type, handler, root=document) {
    on(root, type, (e) => {
      const t = e.target.closest(selector);
      if (t && root.contains(t)) handler(t, e);
    });
  }

  async function postJSON(url, data, method='POST') {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
    });
    let json = {};
    try { json = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, json };
  }

  // ---------- modal (uiModal) ----------
  const uiModal = $('#uiModal');
  const uiTitle = $('#uiModalTitle');
  const uiBody  = $('#uiModalBody');
  function openModal(title, body) {
    if (!uiModal) return;
    if (uiTitle) uiTitle.textContent = title || '';
    if (uiBody)  uiBody.textContent  = body  || '';
    try { uiModal.showModal(); } catch {}
  }
  function closeModal(){ if (uiModal?.open) uiModal.close(); }
  delegate('[data-modal-close]', 'click', closeModal);
  on(uiModal, 'click', (e) => { if (!e.target.closest('.modal-box')) closeModal(); });
  on(document, 'keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // ---------- LIKE (turns green on success) ----------
  const likesCountEl = $('#likes-count');
  delegate('.like-btn', 'click', async (btn) => {
    const id = btn.dataset.userId, name = btn.dataset.username || 'this user';
    if (!id) return;
    const originalText = btn.textContent;

    // optimistic UI
    btn.disabled = true;
    btn.classList.add('btn-success');
    btn.classList.remove('btn-primary');
    btn.textContent = 'Liked';

    const before = likesCountEl ? parseInt(likesCountEl.textContent) : null;
    let decremented = false;
    if (likesCountEl && Number.isFinite(before) && before > 0) {
      likesCountEl.textContent = String(before - 1);
      decremented = true;
    }

    const { ok, status, json } = await postJSON(`/like/${id}`);
    if (!ok) {
      // rollback
      if (decremented && likesCountEl) likesCountEl.textContent = String(before);
      btn.disabled = false;
      btn.classList.remove('btn-success');
      btn.classList.add('btn-primary');
      btn.textContent = originalText;

      if (status === 429) return openModal('Daily limit reached', json.message || 'Upgrade to premium for more likes.');
      return openModal('Error', json.message || 'Could not like right now.');
    }

    if (typeof json.likesRemaining !== 'undefined' && likesCountEl) {
      likesCountEl.textContent = String(json.likesRemaining);
      if (+json.likesRemaining === 0) document.querySelectorAll('.like-btn').forEach(b => b.disabled = true);
    }

    if (json.status === 'match')      openModal('Match!', `${name} liked you too. 🎉`);
    else if (json.status === 'already-liked') openModal('Already liked', `You already liked ${name}.`);
    else                               openModal('Liked', `You liked ${name}.`);
  });

  // ---------- DISLIKE ----------
  delegate('.dislike-btn', 'click', async (btn) => {
    const id = btn.dataset.userId, name = btn.dataset.username || 'this user';
    if (!id) return;
    btn.disabled = true;
    const { ok, json } = await postJSON(`/dislike/${id}`);
    btn.disabled = false;
    if (ok) {
      openModal('Hidden', `You won’t see ${name} for now.`);
      btn.closest('[data-user-id]')?.remove();
    } else {
      openModal('Error', json.message || 'Could not perform action.');
    }
  });

 // ---------- WAVE / INTEREST (👋) ----------
async function sendWave(id) {
  // Try API path first, then legacy path for backward-compat
  const tryApi = await postJSON(`/api/interest/${encodeURIComponent(id)}`);
  if (tryApi.ok || tryApi.status === 429) return tryApi;
  const fallback = await postJSON(`/interest/${encodeURIComponent(id)}`);
  return fallback;
}

// Supports BOTH the legacy .interest-btn and the new .wave-btn
delegate('.wave-btn, .interest-btn', 'click', async (btn) => {
  const id   = btn.getAttribute('data-id') || btn.dataset.userId;
  const name = btn.dataset.username || 'this user';
  if (!id) return;

  btn.disabled = true;
  const res = await sendWave(id);

  // Cooldown handling (429)
  if (res.status === 429) {
    const label = btn.querySelector('span');
    // If it's the new wave-btn (with a label), show brief hint inline
    if (label && btn.classList.contains('wave-btn')) {
      const prev = label.textContent;
      label.textContent = 'Cooldown';
      setTimeout(() => { label.textContent = prev || 'Wave'; btn.disabled = false; }, 2000);
    } else {
      // legacy interest-btn UX
      openModal('Slow down', 'Please wait a bit before waving again.');
      btn.disabled = false;
    }
    return;
  }

  if (res.ok) {
    // New wave-btn: set "Waved" and keep disabled
    const label = btn.querySelector('span');
    if (label) label.textContent = 'Waved';
    btn.disabled = true;

    // Legacy interest-btn: keep your modal feedback as before
    if (btn.classList.contains('interest-btn') && !btn.classList.contains('wave-btn')) {
      openModal('Interest sent', `You waved at ${name}.`);
    }
  } else {
    openModal('Error', res.json?.message || 'Could not send wave.');
    btn.disabled = false;
  }
});

 // ---------- FAVORITES ⭐ ----------
delegate('.favorite-toggle', 'click', async (btn) => {
  const id = btn.getAttribute('data-id') || btn.dataset.userId;
  if (!id) return;

  const isOn = btn.classList.contains('text-yellow-500') || btn.getAttribute('aria-pressed') === 'true';
  btn.disabled = true;

  // Try API route first, then legacy path, so both UIs work
  let res = await fetch(`/api/favorites/${encodeURIComponent(id)}`, {
    method: isOn ? 'DELETE' : 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    // fallback to legacy
    res = await fetch(`/favorite/${encodeURIComponent(id)}`, {
      method: isOn ? 'DELETE' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let data = {};
  try { data = await res.json(); } catch {}

  if (res.ok && data && data.ok !== false) {
    const next = !isOn;
    // visual + a11y states
    btn.classList.toggle('text-yellow-500', next);
    btn.setAttribute('aria-pressed', String(next));
    btn.title = next ? 'Unfavorite' : 'Favorite';

    // if the button has a visible label span, update it
    const label = btn.querySelector('span:not(.sr-only)');
    if (label) label.textContent = next ? 'Favorited' : 'Favorite';

    // (optional) modal toast – keep silent for now to avoid noise
    // openModal(next ? 'Saved' : 'Removed', next ? 'Added to favorites.' : 'Removed from favorites.');
  } else {
    openModal('Error', (data && (data.error || data.message)) || 'Could not update favorites.');
  }

  btn.disabled = false;
});

// ---------- SUPER-LIKE ⚡ ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.superlike-btn');
  if (!btn || btn.disabled) return;
  const id = btn.getAttribute('data-id') || btn.dataset.userId;
  if (!id) return;

  btn.disabled = true;

  try {
    // Try API route, fall back to legacy path
    let res = await fetch(`/api/superlike/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) res = await fetch(`/superlike/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = await res.json().catch(() => ({}));

    if (res.status === 402 || data.error === 'limit') {
      // Out of daily super-likes — nudge upgrade
      // You can swap this for a modal to /upgrade
      const label = btn.querySelector('span'); if (label) label.textContent = 'Limit reached';
      setTimeout(() => { const l = btn.querySelector('span'); if (l) l.textContent = 'Super-Like'; btn.disabled = false; }, 1500);
      return;
    }

    if (!res.ok || data.ok === false) throw new Error(data.error || 'failed');

    // Success — lock the button and set label
    const label = btn.querySelector('span');
    if (label) label.textContent = 'Super-Liked';
    btn.disabled = true;
  } catch (err) {
    console.warn('superlike error', err);
    btn.disabled = false;
  }
});


  // ---------- BOOST (works from navbar or page) ----------
  delegate('#boostBtn,.boost-btn,#navBoostBtn', 'click', async (btn) => {
    btn.disabled = true;
    const { ok, json } = await postJSON('/api/boost');
    btn.disabled = false;
    openModal(ok ? 'Boost activated' : 'Boost failed',
              ok ? 'You will appear higher for 30 minutes.' : (json.message || 'Try again in a moment.'));
  });

  // ---------- FILTERS (works from navbar or page) ----------
  const filtersDialog = $('#filtersDialog');
  const filtersForm   = $('#filtersForm');
  delegate('#openFilters,.open-filters,#navOpenFilters', 'click', () => filtersDialog?.showModal());
  delegate('[data-close="filters"]', 'click',  () => filtersDialog?.close());
  on(filtersDialog, 'click', (e) => { if (!e.target.closest('.modal-box')) filtersDialog.close(); });

  if (filtersForm) {
    on(filtersForm, 'submit', (e) => {
      e.preventDefault();
      const fd = new FormData(filtersForm);
      const params = new URLSearchParams();
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string' && v.trim() === '') continue;
        params.set(k, v);
      }
      params.set('page', '1');
      try { filtersDialog?.close(); } catch {}
      location.assign('/dashboard?' + params.toString());
    });
  }

  // ---------- streak (if you move bar into navbar, still works) ----------
  const streakBar = document.querySelector('[data-streak]');
  if (streakBar) {
    const pct = Number(streakBar.dataset.streak || 0);
    streakBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  // ---------- PHOTO LIGHTBOX (intercept camera chip) ----------
const photoDlg = document.querySelector('#photoLightbox');
const photoImg = document.querySelector('#photoImg');
const photoCap = document.querySelector('#photoCaption');
const photoPrev = document.querySelector('#photoPrev');
const photoNext = document.querySelector('#photoNext');
const photoProfileLink = document.querySelector('#photoProfileLink');

let photoList = [];
let photoIndex = 0;
let photoUserId = null;
let photoUsername = null;

function renderPhoto() {
  if (!photoList.length) return;
  const src = photoList[photoIndex];
  photoImg.src = src;
  photoCap.textContent = `${photoUsername || 'Photo'} • ${photoIndex + 1}/${photoList.length}`;
}

function openLightbox(list, startIdx, userId, username) {
  photoList = Array.isArray(list) ? list : [];
  photoIndex = Math.max(0, Math.min(startIdx || 0, photoList.length - 1));
  photoUserId = userId || null;
  photoUsername = username || '';
  if (photoProfileLink) photoProfileLink.href = `/users/${photoUserId || ''}`;
  renderPhoto();
  photoDlg?.showModal();
}

function closeLightbox() { if (photoDlg?.open) photoDlg.close(); }

if (photoDlg) {
  // backdrop click closes
  photoDlg.addEventListener('click', (e) => {
    if (!e.target.closest('.modal-box')) closeLightbox();
  });
}

if (photoPrev) photoPrev.addEventListener('click', () => {
  if (!photoList.length) return;
  photoIndex = (photoIndex - 1 + photoList.length) % photoList.length;
  renderPhoto();
});
if (photoNext) photoNext.addEventListener('click', () => {
  if (!photoList.length) return;
  photoIndex = (photoIndex + 1) % photoList.length;
  renderPhoto();
});

// Intercept camera chip clicks
delegate('.open-photos', 'click', (a, e) => {
  // stop the anchor from navigating to /users/:id
  e.preventDefault();
  e.stopPropagation();

  try {
    const list = JSON.parse(a.dataset.photos || '[]');
    const uid = a.dataset.userId || '';
    const uname = a.dataset.username || '';
    openLightbox(list, 0, uid, uname);
  } catch {
    // if parsing somehow fails, fall back to navigation
    window.location.assign(a.getAttribute('href'));
  }
});

// Close via [data-close="photoLightbox"]
delegate('[data-close="photoLightbox"]', 'click', (el, e) => {
  e.preventDefault();
  e.stopPropagation();
  closeLightbox();
});

  
})();
