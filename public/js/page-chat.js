// public/js/page-chat.js
(function () {
  const me        = document.getElementById('currentUserId')?.value || '';
  const chatScroll= document.getElementById('chatScroll');
  const chatForm  = document.getElementById('chatForm');
  const chatInput = document.getElementById('chatInput');
  const typingDot = document.getElementById('typingDot');

  const btnBlock  = document.getElementById('blockUser');
  const btnReport = document.getElementById('reportUser');
  const videoBtn  = document.querySelector('.video-call-btn');

  // Robust peer id resolution
  function pathPeer() {
    const m = location.pathname.match(/\/chat\/([a-f0-9]{24})/i);
    return m ? m[1] : '';
  }
  function getPeerId() {
    return (
      document.getElementById('otherUserId')?.value ||
      videoBtn?.dataset?.peerId ||
      document.body?.dataset?.peerId ||
      pathPeer() ||
      ''
    );
  }
  function isMongoId(s) { return /^[a-f0-9]{24}$/i.test(String(s || '')); }

  const other = getPeerId();
  const otherName = document.getElementById('otherUsername')?.value || '';

  const socket = window.__navSocket || window.socket || (window.socket = io());

  // Scroll to bottom on load
  if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;

  // ========= Send (HTTP) =========
  let sending = false;
  chatForm && chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;

    const to = getPeerId();
    if (!isMongoId(to)) return alert('Cannot send: recipient id missing.');

    const content = (chatInput.value || '').trim();
    if (!content) return;

    sending = true;
    const temp = {_id:'tmp_'+Date.now(), sender:me, recipient:to, content, createdAt:new Date().toISOString()};
    appendMessage(temp, true);
    chatInput.value = '';
    clearSeenMarker();

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        credentials:'same-origin',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ to, content })
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok || data.ok === false) {
        const msg = Array.isArray(data.errors) && data.errors[0]?.msg ? data.errors[0].msg : 'Send failed';
        throw new Error(msg);
      }
    } catch (err) {
      removeTemp(temp._id);
      alert(err?.message || 'Could not send.');
    } finally { sending = false; }
  });

  // ========= Typing =========
  let lastTypeAt = 0;
  chatInput && chatInput.addEventListener('input', () => {
    const to = getPeerId();
    if (!isMongoId(to)) return;
    const now = Date.now();
    if (now - lastTypeAt > 900) {
      lastTypeAt = now;
      socket.emit('chat:typing', { to });
    }
  });
  socket.on('chat:typing', (p) => {
    if (!p || String(p.from) !== String(getPeerId())) return;
    if (typingDot) {
      typingDot.style.opacity = '1';
      setTimeout(() => typingDot.style.opacity = '0', 1200);
    }
  });

  // ========= Incoming & receipts =========
  function onIncoming(m){
    if (String(m.sender) !== String(getPeerId())) return;
    appendMessage(m, false);
    const to = getPeerId();
    if (isMongoId(to)) fetch(`/api/messages/${encodeURIComponent(to)}/read`, { method:'POST', credentials:'same-origin' }).catch(()=>{});
  }
  socket.on('chat:incoming', onIncoming);
  socket.on('new_message',  onIncoming);

  socket.on('connect', () => {
    try { if (me) socket.emit('register_for_notifications', me); } catch(e){}
    const to = getPeerId();
    if (isMongoId(to)) fetch(`/api/messages/${encodeURIComponent(to)}/read`, { method:'POST', credentials:'same-origin' }).catch(()=>{});
  });

  socket.on('chat:read', (payload) => {
    const to = getPeerId();
    if (!payload || String(payload.with) !== String(to)) return;
    updateSeenMarker(new Date(payload.until).getTime());
  });

  // ========= Block / Report =========
  btnBlock?.addEventListener('click', async () => {
    const to = getPeerId();
    if (!isMongoId(to)) return alert('User id is missing.');
    if (!confirm(`Block @${otherName || 'this user'}? They won’t be able to contact you.`)) return;
    try {
      const r = await fetch(`/api/users/${encodeURIComponent(to)}/block`, { method: 'POST', credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw 0;
      alert('User blocked.');
      location.href = '/messages';
    } catch { alert('Could not block.'); }
  });

  btnReport?.addEventListener('click', async () => {
    const to = getPeerId();
    if (!isMongoId(to)) return alert('User id is missing.');
    const reason = prompt('Describe the issue (spam, harassment, fake profile, etc.)');
    if (!reason) return;
    try {
      const r = await fetch('/api/report', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: to, reason })
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw 0;
      alert('Thanks for your report. We’ll review.');
    } catch { alert('Report failed.'); }
  });

  // ========= Helpers =========
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
        ${mine ? '<span class="delivery">✓</span>' : ''}
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
})();


// ========== RTC (Video chat) ==========
(function () {
  const modal      = document.getElementById('rtc-modal');
  const vRemote    = document.getElementById('rtc-remote');
  const vLocal     = document.getElementById('rtc-local');
  const statusEl   = document.getElementById('rtc-status');
  const incomingUI = document.getElementById('rtc-incoming');

  const btnCall    = document.querySelector('.video-call-btn');
  const btnMute    = modal?.querySelector('.rtc-mute');
  const btnVideo   = modal?.querySelector('.rtc-video');
  const btnEndAll  = modal?.querySelectorAll('.rtc-hangup');
  const btnAccept  = modal?.querySelector('.rtc-accept');
  const btnDecline = modal?.querySelector('.rtc-decline');

  if (!modal || !vLocal || !vRemote || !btnCall) return;

  const socket   = window.__navSocket || window.socket || (window.socket = io());
  function pathPeer() {
    const m = location.pathname.match(/\/chat\/([a-f0-9]{24})/i);
    return m ? m[1] : '';
  }
  function getPeerId() {
    return (
      document.getElementById('otherUserId')?.value ||
      btnCall?.dataset?.peerId ||
      document.body?.dataset?.peerId ||
      pathPeer() ||
      ''
    );
  }
  function isMongoId(s) { return /^[a-f0-9]{24}$/i.test(String(s || '')); }

  socket.on('connect_error', (err) => {
    if (String(err?.message).includes('upgrade-required')) {
      window.location.href = '/upgrade?reason=video';
    }
  });

  function openModal() { try { modal.showModal(); } catch {} }
  function closeModal(){ try { modal.close(); } catch {} }
  function setStatus(txt){ if (statusEl) statusEl.textContent = txt; }

  let pc = null, localStream = null, targetUserId = null, rtcConfig = null;

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
    pc.onicecandidate = (e) => { if (e.candidate && targetUserId) socket.emit('rtc:candidate', { to: targetUserId, candidate: e.candidate }); };
    pc.ontrack = (e) => { vRemote.srcObject = e.streams[0]; };
    const ls = await ensureLocal(); if (!ls) return false;
    ls.getTracks().forEach(t => pc.addTrack(t, ls));
    return true;
  }

  async function startCall(toUserId) {
    if (!isMongoId(toUserId)) return alert('Cannot call: user id missing.');
    targetUserId = toUserId;
    openModal(); setStatus('Starting…');
    const ok = await initPC(); if (!ok) return;
    socket.emit('rtc:call', { to: targetUserId, meta: {} });
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.emit('rtc:offer', { to: targetUserId, sdp: offer });
    setStatus('Calling…');
  }

  socket.on('rtc:incoming', ({ from }) => {
    targetUserId = from; openModal(); setStatus('Incoming call…'); incomingUI?.classList.remove('hidden');
  });

  btnAccept?.addEventListener('click', async () => {
    incomingUI?.classList.add('hidden');
    const ok = await initPC(); if (!ok) return; setStatus('Connecting…');
  });
  btnDecline?.addEventListener('click', () => { incomingUI?.classList.add('hidden'); endCall('declined'); });

  socket.on('rtc:offer', async ({ from, sdp }) => {
    targetUserId = from; if (!pc) { const ok = await initPC(); if (!ok) return; }
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    socket.emit('rtc:answer', { to: targetUserId, sdp: answer });
    setStatus('Answering…');
  });

  socket.on('rtc:answer', async ({ sdp }) => {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    setStatus('Connected');
  });

  socket.on('rtc:candidate', async ({ candidate }) => {
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  });

  socket.on('rtc:end', ({ reason }) => { setStatus(reason || 'Ended'); teardown(); closeModal(); });

  function teardown() {
    try { pc?.getSenders()?.forEach(s => s.track && s.track.stop()); } catch {}
    try { localStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    try { pc?.close(); } catch {}
    pc = null; localStream = null; targetUserId = null;
  }
  function endCall(reason) {
    if (targetUserId) socket.emit('rtc:end', { to: targetUserId, reason: reason || 'hangup' });
    teardown(); closeModal();
  }

  btnCall.addEventListener('click', (e) => { e.preventDefault(); startCall(getPeerId()); });
  btnEndAll?.forEach?.(b => b.addEventListener('click', () => endCall('hangup')));
  btnMute?.addEventListener('click', () => {
    const t = localStream?.getAudioTracks?.()[0]; if (!t) return;
    t.enabled = !t.enabled; btnMute.classList.toggle('btn-active', !t.enabled); btnMute.textContent = t.enabled ? 'Mute' : 'Unmute';
  });
  btnVideo?.addEventListener('click', () => {
    const t = localStream?.getVideoTracks?.()[0]; if (!t) return;
    t.enabled = !t.enabled; btnVideo.classList.toggle('btn-active', !t.enabled); btnVideo.textContent = t.enabled ? 'Video' : 'Video On';
  });

  modal?.addEventListener('close', () => teardown());
})();
