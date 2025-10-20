// public/js/page-messages.js
(function () {
  // ----- DOM refs / state -----
  const myId       = document.getElementById('currentUserId')?.value || '';
  const peerId     = document.getElementById('peerId')?.value || document.getElementById('otherUserId')?.value || '';
  const threadUl   = document.getElementById('threadList');
  const chatScroll = document.getElementById('chatScroll');

  // Reuse the navbar socket if present, else create one
  const socket = window.__navSocket || window.socket || (window.socket = io());

  // ----- helpers -----
  function qsRowByUser(id) {
    const a = threadUl?.querySelector(`a[data-user-id="${CSS.escape(String(id))}"]`);
    return a ? a.closest('li') : null;
  }

  function moveThreadToTop(userId) {
    const row = qsRowByUser(userId);
    if (threadUl && row && threadUl.firstElementChild !== row) {
      threadUl.insertBefore(row, threadUl.firstElementChild);
    }
  }

  function updatePreviewRow(userId, message, isMine) {
    const a = threadUl?.querySelector(`a[data-user-id="${CSS.escape(String(userId))}"]`);
    if (!a) return;

    const previewEl = a.querySelector('.text-xs');
    if (previewEl) {
      const text = message?.content || message?.text || '';
      const name = a.querySelector('.truncate')?.textContent || '';
      previewEl.textContent = (isMine ? 'You: ' : (name ? name + ': ' : '')) + text;
    }
    moveThreadToTop(userId);
  }

  function buildBubble(m) {
    const mine = String(m.sender) === String(myId);
    const wrap = document.createElement('div');
    wrap.className = 'msg-row flex ' + (mine ? 'justify-end' : 'justify-start');
    wrap.dataset.mid = m._id || '';

    const bubble = document.createElement('div');
    bubble.className = 'max-w-[80%] rounded-2xl px-3 py-2 ' + (mine ? 'bg-primary text-white' : 'bg-gray-100');
    bubble.innerHTML = `
      <div class="whitespace-pre-wrap break-words text-sm"></div>
      <div class="text-[10px] opacity-70 mt-1">${new Date(m.createdAt || Date.now()).toLocaleString()}</div>
    `;
    bubble.querySelector('div').textContent = m.content || m.text || '';
    wrap.appendChild(bubble);
    return wrap;
  }

  function renderMessage(m) {
    if (!chatScroll) return;
    const el = buildBubble(m);
    chatScroll.appendChild(el);
    chatScroll.scrollTop = chatScroll.scrollHeight;
    attachRow(el); // keep multi-select binding
  }

  // ----- unread counts -----
  async function refreshUnreadThreadCounts() {
    try {
      const r = await fetch('/api/unread/threads', { credentials: 'same-origin' });
      const d = await r.json();
      if (!d || !d.ok) return;
      const by = d.by || {};

      threadUl?.querySelectorAll('a[data-user-id]').forEach(a => {
        const uid = a.dataset.userId;
        const n = by[uid] || 0;
        let badge = a.querySelector('.unread-badge');
        const name = a.querySelector('.truncate');
        const preview = a.querySelector('.text-xs');

        if (n > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'ml-auto badge badge-primary unread-badge';
            a.appendChild(badge);
          }
          badge.textContent = String(n);
          name?.classList.add('font-semibold');
          preview?.classList.add('font-medium');
        } else {
          badge?.remove();
          name?.classList.remove('font-semibold');
          preview?.classList.remove('font-medium');
        }
      });

      const navBadge = document.querySelector('[data-role="nav-unread"]');
      if (navBadge) {
        const total = Number(d.total || 0);
        navBadge.textContent = String(total);
        navBadge.hidden = !(total > 0);
      }
    } catch {}
  }

  // Mark current preview as read on load
  if (peerId) {
    fetch(`/api/messages/${encodeURIComponent(peerId)}/read`, { method: 'POST', credentials: 'same-origin' })
      .then(() => {
        const a = threadUl?.querySelector(`a[data-user-id="${CSS.escape(peerId)}"]`);
        a?.querySelectorAll('.unread-badge').forEach(el => el.remove());
        a?.querySelector('.truncate')?.classList.remove('font-semibold');
        a?.querySelector('.text-xs')?.classList.remove('font-medium');
      }).catch(()=>{});
  }

  // ----- socket events -----
  socket.on('connect', () => {
    try { if (myId) socket.emit('register_for_notifications', myId); } catch {}
  });

  function handleIncoming(m) {
    const openThread =
      peerId &&
      String(m.sender) === String(peerId) &&
      String(m.recipient) === String(myId);

    if (openThread) {
      renderMessage(m);
      fetch(`/api/messages/${encodeURIComponent(peerId)}/read`, { method: 'POST', credentials: 'same-origin' }).catch(()=>{});
    } else {
      const a = threadUl?.querySelector(`a[data-user-id="${CSS.escape(String(m.sender))}"]`);
      if (a) {
        let badge = a.querySelector('.unread-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'ml-auto badge badge-primary unread-badge';
          badge.textContent = '1';
          a.appendChild(badge);
        } else {
          const n = parseInt(badge.textContent || '0', 10) || 0;
          badge.textContent = String(n + 1);
        }
        a.querySelector('.truncate')?.classList.add('font-semibold');
        a.querySelector('.text-xs')?.classList.add('font-medium');
      }
    }

    const mine = String(m.sender) === String(myId);
    const otherUserId = mine ? m.recipient : m.sender;
    updatePreviewRow(otherUserId, m, mine);
  }

  socket.on('chat:incoming', handleIncoming);
  socket.on('new_message',  handleIncoming);

  // ----- manage/delete entire threads -----
  const btnManage = document.getElementById('enterManage');
  const btnCancel = document.getElementById('cancelManage');
  const btnDelete = document.getElementById('deleteThreads');

  function setManage(on) {
    threadUl?.querySelectorAll('.threadChk').forEach(chk => {
      chk.classList.toggle('hidden', !on);
      chk.checked = false;
    });
    btnDelete?.classList.toggle('hidden', !on);
    btnCancel?.classList.toggle('hidden', !on);
    btnManage?.classList.toggle('hidden',  on);
  }
  btnManage?.addEventListener('click', () => setManage(true));
  btnCancel?.addEventListener('click', () => setManage(false));

  // ⇩ Use /api/messages/bulk for thread deletes
  btnDelete?.addEventListener('click', async () => {
    const ids = [...threadUl?.querySelectorAll('.threadChk:checked') || []]
      .map(chk => chk.dataset.userId)
      .filter(Boolean);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} conversation(s) for you?`)) return;

    btnDelete.disabled = true;
    try {
      const res = await fetch('/api/messages/bulk', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteThreads', threadUserIds: ids })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error('bulk-delete failed');

      // Remove rows locally
      ids.forEach(id => { qsRowByUser(id)?.remove(); });
      setManage(false);
    } catch (e) {
      alert('Could not delete conversations. Please try again.');
    } finally {
      btnDelete.disabled = false;
    }
  });

  // ----- per-message multi-select (long-press) -----
  const toolbar  = document.getElementById('msToolbar');
  const countEl  = document.getElementById('msCount');
  const selected = new Set();

  function updateToolbar() {
    const n = selected.size;
    if (countEl) countEl.textContent = n;
    if (toolbar) toolbar.classList.toggle('hidden', n === 0);
  }

  function toggleRow(row, force) {
    const id = row.dataset.mid;
    const on = (force != null) ? force : !row.classList.contains('ring-2');
    row.classList.toggle('ring-2', on);
    row.classList.toggle('ring-red-400', on);
    row.classList.toggle('rounded-lg', on);
    if (on) selected.add(id); else selected.delete(id);
    updateToolbar();
  }

  function attachRow(row) {
    if (!row || row._msBound) return;
    row._msBound = true;
    let timer = null;

    // mouse
    row.addEventListener('mousedown', () => { timer = setTimeout(() => toggleRow(row, true), 350); });
    row.addEventListener('mouseup',   () => clearTimeout(timer));
    row.addEventListener('mouseleave',() => clearTimeout(timer));

    // touch
    row.addEventListener('touchstart', () => { timer = setTimeout(() => toggleRow(row, true), 350); }, { passive: true });
    row.addEventListener('touchend',   () => clearTimeout(timer));
    row.addEventListener('touchcancel',() => clearTimeout(timer));

    // click toggles when already selecting
    row.addEventListener('click', () => toggleRow(row));
  }

  document.querySelectorAll('.msg-row').forEach(attachRow);

  document.getElementById('msCancel')?.addEventListener('click', () => {
    document.querySelectorAll('.msg-row.ring-2').forEach(el => {
      el.classList.remove('ring-2','ring-red-400','rounded-lg');
    });
    selected.clear();
    updateToolbar();
  });

  // ⇩ Use /api/messages/bulk for per-message deletes
  document.getElementById('msDelete')?.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!confirm('Delete selected messages for you?')) return;
    const ids = [...selected];

    try {
      const res = await fetch('/api/messages/bulk', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteMessages', messageIds: ids })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error('Delete failed');

      ids.forEach(id => document.querySelector(`.msg-row[data-mid="${CSS.escape(id)}"]`)?.remove());
      selected.clear();
      updateToolbar();
    } catch (e) {
      alert('Could not delete. Please try again.');
    }
  });

  // ----- kickoff -----
  refreshUnreadThreadCounts();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshUnreadThreadCounts(); });
  setInterval(refreshUnreadThreadCounts, 45_000);
  if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
})();


// ========== RTC (Video chat) – signaling: rtc:call/offer/answer/candidate/end ==========
(function () {
  const modal      = document.getElementById('rtc-modal');
  const vRemote    = document.getElementById('rtc-remote');
  const vLocal     = document.getElementById('rtc-local');
  const statusEl   = document.getElementById('rtc-status');
  const incomingUI = document.getElementById('rtc-incoming');
  const fromLbl    = document.getElementById('rtc-from-label');

  const btnsCall   = document.querySelectorAll('.video-call-btn');
  const btnMute    = modal?.querySelector('.rtc-mute');
  const btnVideo   = modal?.querySelector('.rtc-video');
  const btnEndAll  = modal?.querySelectorAll('.rtc-hangup');
  const btnAccept  = modal?.querySelector('.rtc-accept');
  const btnDecline = modal?.querySelector('.rtc-decline');

  if (!modal || !vLocal || !vRemote || !btnsCall.length) return;

  const socket   = window.__navSocket || window.socket || (window.socket = io());
  const myUserId = document.getElementById('currentUserId')?.value || '';
  const fixedPeerId = document.getElementById('peerId')?.value || document.getElementById('otherUserId')?.value || '';

  // Handle server-side gating errors gracefully
  socket.on('connect_error', (err) => {
    if (String(err?.message).includes('upgrade-required')) {
      window.location.href = '/upgrade?reason=video';
    }
  });
  socket.on('rtc:error', (e) => {
    if (e?.code === 'upgrade-required') {
      window.location.href = '/upgrade?reason=video';
    }
  });

  // Modal helpers
  function openModal() { try { modal.showModal(); } catch {} }
  function closeModal() { try { modal.close(); } catch {} }
  function setStatus(txt) { if (statusEl) statusEl.textContent = txt; }

  // RTC state
  let pc = null;
  let localStream = null;
  let isCaller = false;
  let targetUserId = null;
  let rtcConfig = null;

  async function getRTCConfig() {
    if (rtcConfig) return rtcConfig;
    try {
      const res = await fetch('/api/rtc/config', { credentials: 'include' });
      const json = await res.json();
      rtcConfig = json?.rtc || { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
    } catch {
      rtcConfig = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
    }
    return rtcConfig;
  }

  async function ensureLocal() {
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      vLocal.srcObject = localStream;
      return localStream;
    } catch (err) {
      console.error('getUserMedia failed', err);
      setStatus('Could not access camera/microphone.');
      return null;
    }
  }

  async function initPC() {
    const cfg = await getRTCConfig();
    pc = new RTCPeerConnection(cfg);

    pc.onicecandidate = (e) => {
      if (e.candidate && targetUserId) {
        socket.emit('rtc:candidate', { to: targetUserId, candidate: e.candidate });
      }
    };

    pc.ontrack = (e) => {
      vRemote.srcObject = e.streams[0];
    };

    // attach local tracks
    const ls = await ensureLocal();
    if (!ls) return false;
    ls.getTracks().forEach(t => pc.addTrack(t, ls));
    return true;
  }

  // ====== Outgoing ======
  async function startCall(toUserId) {
    if (!toUserId) return;
    targetUserId = toUserId;
    isCaller = true;
    openModal();
    setStatus('Starting…');

    const ok = await initPC();
    if (!ok) return;

    // Let callee know
    socket.emit('rtc:call', { to: targetUserId, meta: {} });

    // Create & send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc:offer', { to: targetUserId, sdp: offer });
    setStatus('Calling…');
  }

  // ====== Incoming ======
  socket.on('rtc:incoming', ({ from }) => {
    targetUserId = from;
    isCaller = false;
    openModal();
    setStatus('Incoming call…');
    incomingUI?.classList.remove('hidden');
    if (fromLbl) fromLbl.textContent = 'Incoming…';
  });

  btnAccept?.addEventListener('click', async () => {
    incomingUI?.classList.add('hidden');
    const ok = await initPC();
    if (!ok) return;
    setStatus('Connecting…');
  });

  btnDecline?.addEventListener('click', () => {
    incomingUI?.classList.add('hidden');
    endCall('declined');
  });

  // ====== SDP & ICE ======
  socket.on('rtc:offer', async ({ from, sdp }) => {
    targetUserId = from;
    if (!pc) {
      const ok = await initPC();
      if (!ok) return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('rtc:answer', { to: targetUserId, sdp: answer });
    setStatus('Answering…');
  });

  socket.on('rtc:answer', async ({ from, sdp }) => {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    setStatus('Connected');
  });

  socket.on('rtc:candidate', async ({ from, candidate }) => {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {
      console.warn('Bad ICE candidate', e);
    }
  });

  socket.on('rtc:end', ({ reason }) => {
    setStatus(reason || 'Ended');
    teardown();
    closeModal();
  });

  function teardown() {
    try { pc?.getSenders()?.forEach(s => s.track && s.track.stop()); } catch {}
    try { localStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    try { pc?.close(); } catch {}
    pc = null;
    localStream = null;
    targetUserId = null;
    isCaller = false;
  }

  function endCall(reason) {
    if (targetUserId) socket.emit('rtc:end', { to: targetUserId, reason: reason || 'hangup' });
    teardown();
    closeModal();
  }

  // ====== UI bindings ======
  btnsCall.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const to = btn.dataset.peerId || fixedPeerId;
      if (!to) return;
      startCall(to);
    });
  });

  btnEndAll?.forEach?.(b => b.addEventListener('click', () => endCall('hangup')));

  btnMute?.addEventListener('click', () => {
    const a = localStream?.getAudioTracks?.()[0];
    if (!a) return;
    a.enabled = !a.enabled;
    btnMute.classList.toggle('btn-active', !a.enabled);
    btnMute.textContent = a.enabled ? 'Mute' : 'Unmute';
  });

  btnVideo?.addEventListener('click', () => {
    const v = localStream?.getVideoTracks?.()[0];
    if (!v) return;
    v.enabled = !v.enabled;
    btnVideo.classList.toggle('btn-active', !v.enabled);
    btnVideo.textContent = v.enabled ? 'Video' : 'Video On';
  });

  // Close modal cleanup
  modal?.addEventListener('close', () => teardown());
})();
