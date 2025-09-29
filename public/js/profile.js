// profile.js — all client logic for /my-profile (CSP-safe, no inline handlers)

(function () {
  // Tabs
  const tabs = document.querySelectorAll('[role="tab"]');
  const showTab = (name) => {
    const ov = document.getElementById('tab-overview');
    const ed = document.getElementById('tab-edit');
    if (!ov || !ed) return;
    ov.classList.toggle('hidden', name !== 'overview');
    ed.classList.toggle('hidden', name !== 'edit');
    tabs.forEach((b) => b.classList.toggle('tab-active', b.dataset.tab === name));
  };
  tabs.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  showTab('overview');

  // Socket notifications
  try {
    const me = document.querySelector('body').dataset?.me || window.__ME__;
    const socket = window.io();
    socket.on('connect', () => {
      if (me) socket.emit('register_for_notifications', me);
    });
    socket.on('new_notification', (n) => {
      toast(n.type === 'match' ? `🎉 ${n.message}` : `🔔 ${n.message}`, n.type === 'match' ? 'success' : 'info');
    });
  } catch {}

  // Photo previews
  document.querySelectorAll('input[type=file][name="photos"]').forEach((input) => {
    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const img = e.target.closest('label')?.querySelector('.preview-img');
      if (!img) return;
      const url = URL.createObjectURL(file);
      img.src = url;
    });
  });

  // Location save (both buttons)
  function wireLocation(btn) {
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!navigator.geolocation) {
        toast('Geolocation not supported on this device', 'error');
        return;
      }
      btn.disabled = true;
      btn.classList.add('btn-disabled');
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const r = await fetch('/api/profile/location', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            });
            const data = await r.json();
            if (data.ok) toast('Location saved. Distance will appear on cards.', 'success');
            else toast('Could not save location', 'error');
          } catch {
            toast('Network error saving location', 'error');
          } finally {
            btn.disabled = false;
            btn.classList.remove('btn-disabled');
          }
        },
        (err) => {
          toast(err?.message || 'Permission denied for geolocation', 'error');
          btn.disabled = false;
          btn.classList.remove('btn-disabled');
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  }
  wireLocation(document.getElementById('setLocationBtn'));
  wireLocation(document.getElementById('setLocationBtnBottom'));

  // Boost
  const boostBtn = document.getElementById('boostBtn');
  const boostBadge = document.getElementById('boostBadge');
  const boostCountdown = document.getElementById('boostCountdown');

  function startBoostCountdown(expiresIso) {
    if (!expiresIso || !boostBadge || !boostCountdown) return;
    boostBadge.classList.remove('hidden');
    const end = new Date(expiresIso).getTime();
    const tick = () => {
      const remain = Math.max(0, end - Date.now());
      const m = Math.floor(remain / 60000);
      const s = Math.floor((remain % 60000) / 1000);
      boostCountdown.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      if (remain <= 0) {
        boostBadge.classList.add('hidden');
        clearInterval(timer);
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
  }

  // Initialize existing boost countdown if active
  if (boostBadge?.dataset?.expires) {
    const t = new Date(boostBadge.dataset.expires).getTime();
    if (Number.isFinite(t) && t > Date.now()) startBoostCountdown(boostBadge.dataset.expires);
  }

  if (boostBtn) {
    boostBtn.addEventListener('click', async () => {
      boostBtn.disabled = true;
      try {
        const r = await fetch('/api/boost', { method: 'POST', credentials: 'same-origin' });
        const data = await r.json();
        if (data.ok) {
          toast('🚀 Profile boosted for 30 minutes!', 'success');
          startBoostCountdown(data.boostExpiresAt);
        } else {
          toast(data.message || 'Could not activate boost', 'error');
        }
      } catch {
        toast('Network error while boosting', 'error');
      } finally {
        boostBtn.disabled = false;
      }
    });
  }

  // Copy profile link
  const copyBtn = document.getElementById('copyLinkBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const url = `${location.origin}/u/${encodeURIComponent(
        document.querySelector('h1')?.textContent?.trim() || 'me'
      )}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied to clipboard', 'info');
      } catch {
        toast('Could not copy link', 'error');
      }
    });
  }

  // Completion meter (simple heuristic)
  try {
    const fields = [
      !!document.querySelector('img[alt$="avatar"]')?.getAttribute('src')?.includes('default-avatar') === false,
      !!textValue('<%= currentUser?.profile?.bio %>'),
      !!textValue('<%= currentUser?.profile?.age %>'),
      !!textValue('<%= currentUser?.profile?.gender %>'),
      !!textValue('<%= currentUser?.profile?.occupation %>'),
      (('<%= (currentUser?.profile?.interests||[]) %>'.length || 0) > 2),
    ];
    const pct = Math.round((fields.filter(Boolean).length / fields.length) * 100);
    const bar = document.getElementById('completionBar');
    const lbl = document.getElementById('completionPct');
    if (bar) bar.value = pct;
    if (lbl) lbl.textContent = `${pct}%`;
  } catch {}
  function textValue(s) {
    return typeof s === 'string' && s.trim().length ? s.trim() : '';
  }

  // Toast helper (daisyUI)
  function toast(msg, type = 'info') {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `alert alert-${type}`;
    el.innerHTML = `<span>${msg}</span>`;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('opacity-0');
      el.style.transition = 'opacity .4s';
    }, 2200);
    setTimeout(() => el.remove(), 2700);
  }
})();
