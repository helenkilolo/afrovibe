// public/js/page-chat.js
(function () {
  const $ = (s) => document.querySelector(s);

  const currentUserId = ($('#currentUserId')?.value || '').trim();
  const otherUserId   = ($('#otherUserId')?.value   || '').trim();

  const isMongoId = (s) => /^[a-f0-9]{24}$/i.test(String(s || '').trim());

  const form  = $('#chatForm');
  const input = $('#chatInput');
  const list  = $('#chatScroll');
  const typingDot = $('#typingDot');
  const btnBlock  = $('#blockUser');
  const btnReport = $('#reportUser');
  const videoBtn  = document.querySelector('.video-call-btn');

  // Socket (singleton made by socket-helper.js)
  const socket = window.__appSocket || window.socket;

  // Scroll to bottom on load
  if (list) list.scrollTop = list.scrollHeight;

  if (!form || !input || !list) return;

  if (!isMongoId(otherUserId)) {
    console.warn('[chat] invalid otherUserId, disabling composer');
    input.disabled = true;
    form.querySelector('button')?.setAttribute('disabled', 'disabled');
    return;
  }

  function appendBubble({ _id, sender, content, createdAt }) {
    const mine = String(sender) === String(currentUserId);
    const wrap = document.createElement('div');
    wrap.className = `flex ${mine ? 'justify-end' : 'justify-start'}`;

    const bubble = document.createElement('div');
    bubble.className = `max-w-[85%] md:max-w-[75%] rounded-2xl px-3 py-2 ${
      mine ? 'bg-primary text-white' : 'bg-gray-100'
    }`;
    bubble.dataset.id = _id || '';
    bubble.dataset.mine = mine ? '1' : '0';
    const ts = new Date(createdAt || Date.now());
    bubble.dataset.ts = String(ts.getTime());

    const text = document.createElement('div');
    text.className = 'whitespace-pre-wrap break-words text-sm';
    text.textContent = content;

    const meta = document.createElement('div');
    meta.className = 'text-[10px] opacity-70 mt-1';
    meta.innerHTML = mine ? `${ts.toLocaleString()} <span class="delivery">✓</span>`
                          : ts.toLocaleString();

    bubble.appendChild(text);
    bubble.appendChild(meta);
    wrap.appendChild(bubble);
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
  }

  function removeTemp(tempId) {
    const node = list.querySelector(`[data-id="${tempId}"]`);
    node?.parentElement?.remove();
  }

  function updateSeenMarker(untilTs) {
    const mine = [...list.querySelectorAll('[data-mine="1"]')];
    if (!mine.length) return;
    let target = null;
    for (const b of mine) {
      const ts = Number(b.dataset.ts || 0);
      if (ts <= untilTs) target = b;
    }
    if (!target) return;
    list.querySelectorAll('[data-mine="1"] .delivery').forEach(el => el.textContent = '✓');
    document.getElementById('seenRow')?.remove();
    const mark = target.querySelector('.delivery');
    if (mark) mark.textContent = '✓✓';
    const seenRow = document.createElement('div');
    seenRow.id = 'seenRow';
    seenRow.className = 'text-[11px] text-gray-500 mt-1 text-right';
    seenRow.textContent = 'Seen';
    target.parentElement.appendChild(seenRow);
  }

  // submit
  let sending = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (sending) return;

    let content = (input.value || '').trim();
    if (!content) return;

    const to = otherUserId; // from hidden input
    if (!isMongoId(to)) {
      alert('Sorry, this chat cannot send right now (invalid user id).');
      return;
    }

    sending = true;
    const tempId = 'tmp_' + Math.random().toString(36).slice(2);
    appendBubble({ _id: tempId, sender: currentUserId, content, createdAt: Date.now() });
    input.value = '';

    try {
      const res = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ to, recipient: to, content })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        removeTemp(tempId);
        const msg = json?.message || json?.error ||
                    (Array.isArray(json?.errors) && json.errors[0]?.msg) ||
                    'Failed to send.';
        alert(msg);
        return;
      }
      // final bubble arrives via socket events
    } catch (err) {
      removeTemp(tempId);
      alert('Network error sending message.');
    } finally {
      sending = false;
    }
  });

  // typing (throttled in socket-helper via window.emitTyping if you want)
  let lastTypeAt = 0;
  input.addEventListener('input', () => {
    const now = Date.now();
    if (now - lastTypeAt > 900) {
      lastTypeAt = now;
      socket?.emit?.('chat:typing', { to: otherUserId });
    }
  });
  socket?.on?.('chat:typing', (p) => {
    if (!p || String(p.from) !== String(otherUserId)) return;
    if (typingDot) { typingDot.style.opacity = '1'; setTimeout(() => typingDot.style.opacity = '0', 1200); }
  });

  // incoming
  function onIncoming(m) {
    if (String(m.sender) !== String(otherUserId)) return;
    appendBubble(m);
    fetch(`/api/messages/${encodeURIComponent(otherUserId)}/read`, { method:'POST', credentials:'include' }).catch(()=>{});
  }
  socket?.on?.('chat:incoming', onIncoming);
  socket?.on?.('new_message',  onIncoming);

  socket?.on?.('connect', () => {
    if (currentUserId) socket.emit('register_for_notifications', currentUserId);
    fetch(`/api/messages/${encodeURIComponent(otherUserId)}/read`, { method:'POST', credentials:'include' }).catch(()=>{});
  });

  socket?.on?.('chat:read', (payload) => {
    if (!payload || String(payload.with) !== String(currentUserId)) return;
    const t = new Date(payload.until).getTime();
    updateSeenMarker(t);
  });

  // Block / Report
  btnBlock?.addEventListener('click', async () => {
    if (!confirm('Block this user? They won’t be able to contact you.')) return;
    try {
      const r = await fetch(`/api/users/${encodeURIComponent(otherUserId)}/block`, { method: 'POST', credentials: 'include' });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw 0;
      alert('User blocked.'); location.href = '/messages';
    } catch { alert('Could not block.'); }
  });

  btnReport?.addEventListener('click', async () => {
    const reason = prompt('Describe the issue (spam, harassment, fake profile, etc.)');
    if (!reason) return;
    try {
      const r = await fetch('/api/report', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: otherUserId, reason })
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw 0;
      alert('Thanks for your report. We’ll review.');
    } catch { alert('Report failed.'); }
  });
  // ========== RTC (Video chat) ==========
(function () {
  const modal      = document.getElementById('rtc-modal');
  const vRemote    = document.getElementById('rtc-remote');
  const vLocal     = document.getElementById('rtc-local');
  const statusEl   = document.getElementById('rtc-status');
  const incomingUI = document.getElementById('rtc-incoming');

  const btnCall = document.querySelector('.video-call-btn');
const getPeerId = () =>
  document.getElementById('otherUserId')?.value ||
  btnCall?.dataset?.peerId || '';

btnCall?.addEventListener('click', (e) => {
  e.preventDefault();
  const peer = getPeerId();
  if (!/^[a-f0-9]{24}$/i.test(peer)) {
    alert('Cannot start call: missing user id.');
    return;
  }
  startCall(to); 
});

  const btnMute    = modal?.querySelector('.rtc-mute');
  const btnVideo   = modal?.querySelector('.rtc-video');
  const btnEndAll  = modal?.querySelectorAll('.rtc-hangup');
  const btnAccept  = modal?.querySelector('.rtc-accept');
  const btnDecline = modal?.querySelector('.rtc-decline');

  if (!modal || !vLocal || !vRemote || !btnCall) return;

 // inside your page-chat.js (video section)
const socket = window.__appSocket || window.socket;
if (!socket) {
  console.warn('[rtc] socket not ready (did /socket.io/socket.io.js load?)');
}
  const currentUserId = (document.getElementById('currentUserId')?.value || '').trim();
  const targetUserId  = (document.querySelector('.video-call-btn')?.dataset?.peerId || '').trim();

  function isMongoId(s){ return /^[a-f0-9]{24}$/i.test(String(s||'')); }
  if (!isMongoId(targetUserId)) return;

  socket?.on?.('connect_error', (err) => {
    if (String(err?.message).includes('upgrade-required')) {
      window.location.href = '/upgrade?reason=video';
    }
  });

  function openModal(){ try { modal.showModal(); } catch{} }
  function closeModal(){ try { modal.close(); } catch{} }
  function setStatus(t){ if (statusEl) statusEl.textContent = t; }

  let pc=null, localStream=null, peerId=null, rtcCfg=null;

  async function getRTC(){
    if (rtcCfg) return rtcCfg;
    try {
      const r = await fetch('/api/rtc/config', { credentials: 'include' });
      const j = await r.json();
      rtcCfg = j?.rtc || { iceServers:[{ urls:['stun:stun.l.google.com:19302'] }] };
    } catch {
      rtcCfg = { iceServers:[{ urls:['stun:stun.l.google.com:19302'] }] };
    }
    return rtcCfg;
  }
  async function ensureLocal(){
    if (localStream) return localStream;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio:true, video:true });
      vLocal.srcObject = localStream;
      return localStream;
    } catch(e){
      setStatus('Camera/mic blocked.');
      return null;
    }
  }
  async function initPC(){
    const cfg = await getRTC();
    pc = new RTCPeerConnection(cfg);
    pc.onicecandidate = (e) => { if (e.candidate && peerId) socket.emit('rtc:candidate', { to: peerId, candidate: e.candidate }); };
    pc.ontrack = (e) => { vRemote.srcObject = e.streams[0]; };
    const ls = await ensureLocal(); if (!ls) return false;
    ls.getTracks().forEach(t => pc.addTrack(t, ls));
    return true;
  }
  async function startCall(){
    if (!isMongoId(targetUserId)) return;
    peerId = targetUserId;
    openModal(); setStatus('Starting…');
    const ok = await initPC(); if (!ok) return;
    socket.emit('rtc:call', { to: peerId, meta:{} });
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    socket.emit('rtc:offer', { to: peerId, sdp: offer });
    setStatus('Calling…');
  }

  socket.on('rtc:incoming', ({ from }) => {
    if (String(from) !== String(targetUserId)) return;
    peerId = from;
    openModal(); setStatus('Incoming call…'); incomingUI?.classList.remove('hidden');
  });

  btnAccept?.addEventListener('click', async () => {
    incomingUI?.classList.add('hidden');
    const ok = await initPC(); if (!ok) return;
    setStatus('Connecting…');
  });
  btnDecline?.addEventListener('click', () => {
    incomingUI?.classList.add('hidden');
    endCall('declined');
  });

  socket.on('rtc:offer', async ({ from, sdp }) => {
    if (String(from) !== String(targetUserId)) return;
    peerId = from;
    if (!pc) { const ok = await initPC(); if (!ok) return; }
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
    socket.emit('rtc:answer', { to: peerId, sdp: answer });
    setStatus('Answering…');
  });

  socket.on('rtc:answer', async ({ from, sdp }) => {
    if (String(from) !== String(targetUserId)) return;
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    setStatus('Connected');
  });

  socket.on('rtc:candidate', async ({ from, candidate }) => {
    if (String(from) !== String(targetUserId)) return;
    if (!pc || !candidate) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  });

  socket.on('rtc:end', ({ from, reason }) => {
    if (String(from) !== String(targetUserId)) return;
    setStatus(reason || 'Ended'); teardown(); closeModal();
  });

  socket.on('rtc:error', (e) => {
  if (String(e?.code) === 'upgrade-required') {
    window.location.href = '/upgrade?reason=video';
  } else {
    alert(e?.message || 'Video call is not available.');
  }
});

// If connect itself failed with the custom reason:
socket.on('connect_error', (err) => {
  if (String(err?.message || '').includes('upgrade-required')) {
    window.location.href = '/upgrade?reason=video';
  }
});

  function teardown(){
    try { pc?.getSenders()?.forEach(s => s.track && s.track.stop()); } catch {}
    try { localStream?.getTracks()?.forEach(t => t.stop()); } catch {}
    try { pc?.close(); } catch {}
    pc=null; localStream=null; peerId=null;
  }
  function endCall(reason){
    if (peerId) socket.emit('rtc:end', { to: peerId, reason: reason || 'hangup' });
    teardown(); closeModal();
  }

  btnCall.addEventListener('click', (e) => { e.preventDefault(); startCall(); });
  btnEndAll?.forEach?.(b => b.addEventListener('click', () => endCall('hangup')));
  btnMute?.addEventListener('click', () => {
    const t = localStream?.getAudioTracks?.()[0]; if (!t) return;
    t.enabled = !t.enabled;
    btnMute.classList.toggle('btn-active', !t.enabled);
    btnMute.textContent = t.enabled ? 'Mute' : 'Unmute';
  });
  btnVideo?.addEventListener('click', () => {
    const t = localStream?.getVideoTracks?.()[0]; if (!t) return;
    t.enabled = !t.enabled;
    btnVideo.classList.toggle('btn-active', !t.enabled);
    btnVideo.textContent = t.enabled ? 'Video' : 'Video On';
  });

  modal?.addEventListener('close', () => teardown());
})();

})();
