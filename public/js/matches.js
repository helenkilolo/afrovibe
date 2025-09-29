// public/js/matches.js

// Delegate clicks for all "Like back" buttons
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.like-back');
  if (!btn) return;

  const id = btn.dataset.userId;
  if (!id) return;

  const originalText = btn.textContent;
  btn.disabled = true;
  btn.dataset.loading = 'true';
  btn.classList.add('btn-disabled');
  btn.textContent = 'Liking…';

  try {
    const res = await fetch('/like/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    });

    let data = null;
    try { data = await res.json(); } catch (_) {}

    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || 'Failed to like back.';
      throw new Error(msg);
    }

    // Success: jump to chat
    window.location.href = '/chat/' + encodeURIComponent(id);
  } catch (err) {
    // Error UI
    btn.disabled = false;
    btn.dataset.loading = 'false';
    btn.classList.remove('btn-disabled');
    btn.textContent = originalText;

    // minimal toast/alert
    if (window?.toast?.error) {
      toast.error(err.message || 'Could not like back. Please try again.');
    } else {
      alert(err.message || 'Could not like back. Please try again.');
    }
  }
});
