// public/js/page-messages.js
(function () {
  // ----- DOM refs / state -----
  const myId       = document.getElementById('currentUserId')?.value || '';
  const peerId     = document.getElementById('peerId')?.value || '';
  const threadUl   = document.getElementById('threadList');
  const chatScroll = document.getElementById('chatScroll');
  const socket     = window.__navSocket || window.socket || (window.socket = io()); // reuse navbar socket if present

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

// ========== RTC (Video chat) block — safe to append ==========
(function () {
  const modal   = document.querySelector('#rtc-modal');
  const vLocal  = document.querySelector('#rtc-local');
  const vRemote = document.querySelector('#rtc-remote');
  const startBtn = document.querySelector('.video-call-btn');

  if (!modal || !vLocal || !vRemote || !startBtn) return;

  const socket = window.socket || (window.socket = io());
  const myUserId = document.getElementById('currentUserId')?.value || '';
  const peerId   = startBtn?.dataset?.peerId || document.getElementById('peerId')?.value || '';

  const iceServers = window.RTC_ICE_SERVERS || [{ urls: 'stun:stun.l.google.com:19302' }];

  let pc = null;
  let localStream = null;
  let remoteStream = null;

  async function ensureLocal() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    vLocal.srcObject = localStream;
    return localStream;
  }
  function createPeer() {
    pc = new RTCPeerConnection({ iceServers });
    remoteStream = new MediaStream();
    vRemote.srcObject = remoteStream;

    pc.ontrack = (e) => e.streams[0]?.getTracks().forEach(t => remoteStream.addTrack(t));
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('rtc:candidate', { to: peerId, from: myUserId, cand: e.candidate });
    };
    return pc;
  }
  async function startCall() {
    if (!peerId) return;
    const r = await fetch(`/api/call/request/${encodeURIComponent(peerId)}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }
    });
    if (r.status === 402) return alert('Video chat is an Elite feature.');
    if (r.status === 429) return alert('Please wait before trying again.');
    if (!r.ok)            return alert('Could not start video chat.');

    await ensureLocal();
    pc = createPeer();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc:offer', { to: peerId, from: myUserId, sdp: offer });
    modal.showModal();
  }
  function endCall() {
    try { pc?.getSenders()?.forEach(s => s.track?.stop()); } catch {}
    try { localStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    try { pc?.close(); } catch {}
    pc = null; localStream = null; remoteStream = null;
    modal.close();
  }

  // Incoming
  socket.on('rtc:offer', async ({ from, sdp }) => {
    if (String(from) !== String(peerId)) return;
    await ensureLocal();
    pc = createPeer();
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('rtc:answer', { to: from, from: myUserId, sdp: answer });
    modal.showModal();
  });
  socket.on('rtc:answer', async ({ sdp }) => {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });
  socket.on('rtc:candidate', async ({ cand, from }) => {
    if (!pc || String(from) !== String(peerId) || !cand) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
  });
  socket.on('rtc:hangup', endCall);
  socket.on('rtc:decline', endCall);

  // UI
  document.addEventListener('click', (e) => {
    if (e.target.closest('.video-call-btn')) { e.preventDefault(); startCall(); }
    if (e.target.closest('.rtc-hangup')) {
      socket.emit('rtc:hangup', { to: peerId, from: myUserId });
      endCall();
    }
    if (e.target.closest('.rtc-mute')) {
      const t = localStream?.getAudioTracks?.()[0]; if (t) t.enabled = !t.enabled;
      e.target.textContent = (t && !t.enabled) ? 'Unmute' : 'Mute';
    }
    if (e.target.closest('.rtc-video')) {
      const t = localStream?.getVideoTracks?.()[0]; if (t) t.enabled = !t.enabled;
      e.target.textContent = (t && !t.enabled) ? 'Video On' : 'Video';
    }
  });
})();
