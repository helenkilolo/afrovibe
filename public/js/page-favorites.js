// public/js/page-favorites.js

// FAVORITES ⭐
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.favorite-toggle');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (!id) return;

  const isOn = btn.classList.contains('text-yellow-500');
  btn.disabled = true;

  try {
    const method = isOn ? 'DELETE' : 'POST';
    const res = await fetch(`/api/favorites/${encodeURIComponent(id)}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || 'failed');

    // optimistic toggle
    btn.classList.toggle('text-yellow-500', !isOn);
    const label = btn.querySelector('span');
    if (label) label.textContent = !isOn ? 'Favorited' : 'Favorite';
    btn.title = !isOn ? 'Unfavorite' : 'Favorite';
  } catch (err) {
    console.warn('favorite error', err);
  } finally {
    btn.disabled = false;
  }
});

// WAVE 👋
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.wave-btn');
  if (!btn || btn.disabled) return;
  const id = btn.getAttribute('data-id');
  if (!id) return;

  btn.disabled = true;

  try {
    const res = await fetch(`/api/interest/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      if (res.status === 429) {
        const label = btn.querySelector('span'); if (label) label.textContent = 'Cooldown';
        setTimeout(() => { const l = btn.querySelector('span'); if (l) l.textContent = 'Wave'; btn.disabled = false; }, 2000);
        return;
      }
      throw new Error('failed');
    }
    const label = btn.querySelector('span');
    if (label) label.textContent = 'Waved';
  } catch (err) {
    console.warn('wave error', err);
    btn.disabled = false;
  }
});
