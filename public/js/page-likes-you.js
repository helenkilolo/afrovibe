// public/js/page-likes-you.js
(function () {
  const meId = document.getElementById('currentUserId')?.value || '';
  const socket = window.socket || (window.socket = io());

  // --- socket registration + simple notifications ---
  socket.on('connect', () => {
    if (meId) socket.emit('register_for_notifications', meId);
  });

  socket.on('new_notification', (n) => {
    // Minimal handler; customize as needed
    if (n?.type === 'match') {
      showMatchModal(n.message || 'You have a new match!');
    } else if (n?.type === 'like') {
      showAlert('New Like', n.message || 'Someone liked you!');
    }
  });

  // --- image fallback without inline JS ---
  document.querySelectorAll('img.likeyou-photo').forEach(img => {
    img.addEventListener('error', () => {
      img.src = '/images/default-avatar.png';
    }, { once: true });
  });

  // --- Like Back / Dislike actions (event delegation) ---
  document.addEventListener('click', async (e) => {
    const likeBtn = e.target.closest('.like-back-btn');
    const dislikeBtn = e.target.closest('.dislike-btn');

    if (likeBtn) {
      const id = likeBtn.dataset.userId;
      if (!id) return;
      likeBtn.disabled = true;
      likeBtn.textContent = 'Liking…';
      try {
        const res = await fetch(`/like/${encodeURIComponent(id)}`, { method: 'POST', credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || 'Failed to like back');

        // If server indicates mutual match
        if (data?.status === 'match') {
          showMatchModal(data?.message || 'It’s a match!');
        } else {
          showAlert('Success', 'Liked back successfully!');
        }

        // Remove the card from the grid
        likeBtn.closest('article')?.remove();
      } catch (err) {
        likeBtn.disabled = false;
        likeBtn.textContent = 'Like back';
        showAlert('Error', err.message || 'Failed to like back.');
      }
      return;
    }

    if (dislikeBtn) {
      const id = dislikeBtn.dataset.userId;
      if (!id) return;
      const card = dislikeBtn.closest('article');
      dislikeBtn.disabled = true;
      try {
        const res = await fetch(`/dislike/${encodeURIComponent(id)}`, { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error('Failed to dislike');
        card?.remove();
      } catch (err) {
        dislikeBtn.disabled = false;
        showAlert('Error', err.message || 'Failed to dislike.');
      }
      return;
    }
  });

  // --- modal helpers ---
  function showAlert(title, message) {
    const modal = document.getElementById('alertModal');
    if (!modal) return;
    document.getElementById('alertTitle').textContent = title || 'Notice';
    document.getElementById('alertMessage').textContent = message || '';
    modal.showModal();
  }

  function showMatchModal(text) {
    const modal = document.getElementById('matchModal');
    if (!modal) return;
    document.getElementById('matchedUser').textContent = text || '';
    modal.showModal();
  }
})();
