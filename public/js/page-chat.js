// public/js/page-chat.js
(function () {
  // ----- DOM refs -----
  const me          = document.getElementById('currentUserId')?.value || '';
  const other       = document.getElementById('otherUserId')?.value || '';
  const otherName   = document.getElementById('otherUsername')?.value || '';
  const chatScroll  = document.getElementById('chatScroll');
  const chatForm    = document.getElementById('chatForm');
  const chatInput   = document.getElementById('chatInput');
  const typingDot   = document.getElementById('typingDot');

  // Bulk/select
  const bulkBar     = document.getElementById('bulkBar');
  const selCountEl  = document.getElementById('selCount');
  const btnDelSel   = document.getElementById('deleteSelected');
  const btnDelAll   = document.getElementById('deleteAll');
  const btnBlock    = document.getElementById('blockUser');
  const btnReport   = document.getElementById('reportUser');
  const btnCancel   = document.getElementById('cancelSelect');

  const socket = window.socket || (window.socket = io());

  // ----- selection state -----
  let selectMode = false;
  const selected = new Set();
  let holdTimer  = null;

  function setSelectMode(on){
    selectMode = !!on;
    bulkBar?.classList.toggle('hidden', !selectMode);
    chatScroll?.querySelectorAll('[data-id]').forEach(b => {
      const chk = b.querySelector('.chk');
      if (!chk) return;
      chk.classList.toggle('hidden', !selectMode);
      if (!selectMode) {
        chk.checked = false;
        b.classList.remove('ring','ring-offset-1','ring-primary');
      }
    });
    selected.clear();
    if (selCountEl) selCountEl.textContent = '0';
  }
  function toggleSelect(bubble){
    const id  = bubble.dataset.id;
    const chk = bubble.querySelector('.chk');
    const on  = !selected.has(id);
    if (on){ selected.add(id); chk.checked = true; bubble.classList.add('ring','ring-offset-1','ring-primary'); }
    else   { selected.delete(id); chk.checked = false; bubble.classList.remove('ring','ring-offset-1','ring-primary'); }
    if (selCountEl) selCountEl.textContent = String(selected.size);
  }

  chatScroll?.addEventListener('pointerdown', (e) => {
    const bubble = e.target.closest('[data-id]');
    if (!bubble) return;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { setSelectMode(true); toggleSelect(bubble); }, 450);
  });
  ['pointerup','pointercancel','pointerleave'].forEach(ev =>
    chatScroll?.addEventListener(ev, () => clearTimeout(holdTimer))
  );
  chatScroll?.addEventListener('click', (e) => {
    const bubble = e.target.closest('[data-id]');
    if (!bubble || !selectMode) return;
    e.preventDefault();
    toggleSelect(bubble);
  });
  btnCancel?.addEventListener('click', () => setSelectMode(false));

  btnDelSel?.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} message(s) for you?`)) return;
    try {
      const res = await fetch('/api/messages/bulk-delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] })
      });
      const data = await res.json();
      if (!data.ok) throw 0;
      [...selected].forEach(id => {
        const el = chatScroll.querySelector(`[data-id="${CSS.escape(id)}"]`);
        el?.parentElement?.remove();
      });
      setSelectMode(false);
    } catch { alert('Could not delete.'); }
  });

  btnDelAll?.addEventListener('click', async () => {
    if (!confirm('Delete ALL messages in this conversation for you?')) return;
    try {
      const res = await fetch(`/api/conversations/${other}`, { method: 'DELETE', credentials: 'same-origin' });
      const data = await res.json();
      if (!data.ok) throw 0;
      chatScroll.innerHTML = '<p class="text-sm text-gray-500 text-center py-6">Conversation cleared.</p>';
      setSelectMode(false);
    } catch { alert('Could not delete conversation.'); }
  });

  btnBlock?.addEventListener('click', async () => {
    if (!confirm(`Block @${otherName}? They won’t be able to contact you.`)) return;
    try {
      const r = await fetch(`/api/users/${other}/block`, { method: 'POST', credentials: 'same-origin' });
      const d = await r.json();
      if (!d.ok) throw 0;
      alert('User blocked.');
      location.href = '/messages';
    } catch { alert('Could not block.'); }
  });

  btnReport?.addEventListener('click', async () => {
    const reason = prompt('Describe the issue (spam, harassment, fake profile, etc.)');
    if (!reason) return;
    try {
      const r = await fetch('/api/report', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: other, reason })
      });
      const d = await r.json();
      if (!d.ok) throw 0;
      alert('Thanks for your report. We’ll review.');
    } catch { alert('Report failed.'); }
  });

  // ----- socket + read receipts -----
  socket.on('connect', () => {
    try { socket.emit('register_for_notifications', me); } catch(e){}
    fetch(`/api/messages/${other}/read`, { method:'POST', credentials:'same-origin' }).catch(()=>{});
  });

  // ensure scroll to bottom on load
  if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;

  // ----- send (HTTP only) with optimistic bubble -----
  let sending = false;
  chatForm && chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;
    const content = (chatInput.value || '').trim();
    if (!content) return;
    sending = true;

    const temp = {_id:'tmp_'+Date.now(), sender:me, recipient:other, content, createdAt:new Date().toISOString()};
    appendMessage(temp, true);
    chatInput.value = '';
    clearSeenMarker();

    try {
      const res = await fetch('/api/messages', {
        method: 'POST', credentials:'same-origin',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ to: other, content })
      });
      const data = await res.json();
      if (!data.ok) throw 0;
    } catch {
      removeTemp(temp._id);
      alert('Could not send.');
    } finally { sending = false; }
  });

  // ----- typing indicator -----
  let lastTypeAt = 0;
  chatInput && chatInput.addEventListener('input', () => {
    const now = Date.now();
    if (now - lastTypeAt > 900) {
      lastTypeAt = now;
      socket.emit('chat:typing', { to: other });
    }
  });
  socket.on('chat:typing', (p) => {
    if (!p || String(p.from) !== String(other)) return;
    if (typingDot) {
      typingDot.style.opacity = '1';
      setTimeout(() => typingDot.style.opacity = '0', 1200);
    }
  });

  // ----- incoming + read receipts -----
  function onIncoming(m){
    if (String(m.sender) !== String(other)) return;
    appendMessage(m, false);
    fetch(`/api/messages/${other}/read`, { method:'POST', credentials:'same-origin' }).catch(()=>{});
  }
  socket.on('chat:incoming', onIncoming);
  socket.on('new_message', onIncoming);

  socket.on('chat:read', (payload) => {
    if (!payload || String(payload.with) !== String(other)) return;
    updateSeenMarker(new Date(payload.until).getTime());
  });

  // ----- helpers -----
  function buildBubble(m){
    const mine = String(m.sender) === String(me);
    const ts   = new Date(m.createdAt || Date.now()).getTime();
    const wrap = document.createElement('div');
    wrap.className = 'flex ' + (mine ? 'justify-end' : 'justify-start');

    const bubble = document.createElement('div');
    bubble.className  = 'max-w-[80%] rounded-2xl px-3 py-2 ' + (mine ? 'bg-primary text-white' : 'bg-gray-100');
    bubble.dataset.ts   = String(ts);
    bubble.dataset.mine = mine ? '1' : '0';
    bubble.dataset.id   = m._id || '';
    bubble.innerHTML = `
      <input type="checkbox" class="checkbox checkbox-xs chk hidden mr-2">
      <div class="whitespace-pre-wrap break-words text-sm"></div>
      <div class="text-[10px] opacity-70 mt-1">
        ${new Date(ts).toLocaleString()}
        ${mine ? '<span class="ml-1 delivery">✓</span>' : ''}
      </div>`;
    bubble.querySelector('div.whitespace-pre-wrap').textContent = m.content || '';
    wrap.appendChild(bubble);
    return wrap;
  }
  function appendMessage(m, isTemp){
    const el = buildBubble(m);
    if (isTemp) el.querySelector('[data-id]')?.setAttribute('data-temp-id', m._id);
    chatScroll.appendChild(el);
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }
  function removeTemp(tempId){
    const el = chatScroll.querySelector('[data-temp-id="'+ tempId +'"]');
    if (el) el.parentElement?.remove();
  }

  function updateSeenMarker(untilTs){
    const mine = [...chatScroll.querySelectorAll('[data-mine="1"]')];
    if (!mine.length) return;
    let target = null;
    for (const b of mine) {
      const ts = Number(b.dataset.ts || 0);
      if (ts <= untilTs) target = b;
    }
    if (!target) return;
    clearSeenMarker();
    const mark = target.querySelector('.delivery');
    if (mark) mark.textContent = '✓✓';
    const seenRow = document.createElement('div');
    seenRow.id = 'seenRow';
    seenRow.className = 'text-[11px] text-gray-500 mt-1 text-right';
    seenRow.textContent = 'Seen';
    target.parentElement.appendChild(seenRow);
  }
  function clearSeenMarker(){
    chatScroll.querySelectorAll('[data-mine="1"] .delivery').forEach(el => el.textContent = '✓');
    const row = document.getElementById('seenRow'); if (row) row.remove();
  }

  // ----- infinite scroll up -----
  let loadingOlder = false;
  let oldest = (() => {
    const first = chatScroll.querySelector('[data-ts]');
    return first ? new Date(Number(first.getAttribute('data-ts'))).toISOString() : null;
  })();
  chatScroll?.addEventListener('scroll', async () => {
    if (chatScroll.scrollTop > 40 || loadingOlder) return;
    loadingOlder = true;
    const before = oldest || new Date().toISOString();
    try {
      const res = await fetch(`/api/messages/${other}?before=${encodeURIComponent(before)}&limit=30`, { credentials:'same-origin' });
      const data = await res.json();
      if (Array.isArray(data.items) && data.items.length) {
        const prevHeight = chatScroll.scrollHeight;
        const frag = document.createDocumentFragment();
        const batch = data.items.slice().reverse();
        batch.forEach(m => frag.appendChild(buildBubble(m)));
        chatScroll.insertBefore(frag, chatScroll.firstChild);
        chatScroll.scrollTop = chatScroll.scrollHeight - prevHeight;
        oldest = new Date(batch[0].createdAt || Date.now()).toISOString();
      }
    } catch {}
    loadingOlder = false;
  });
})();

// ========== RTC (Video chat) block — safe to append ==========
(function () {
  const modal   = document.querySelector('#rtc-modal');
  const vLocal  = document.querySelector('#rtc-local');
  const vRemote = document.querySelector('#rtc-remote');
  const startBtn = document.querySelector('.video-call-btn');

  if (!modal || !vLocal || !vRemote || !startBtn) return;

  const socket   = window.socket || (window.socket = io());
  const myUserId = document.getElementById('currentUserId')?.value || '';
  const peerId   = startBtn?.dataset?.peerId || document.getElementById('otherUserId')?.value || '';

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
