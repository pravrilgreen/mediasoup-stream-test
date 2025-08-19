import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3.14.2';

const API = (p, o) => fetch(p, o);

let device = null, recvTransport = null;
const players = new Map();
let currentStreams = [];
let focus = { id: null, placeholder: null };

const gridEl = document.querySelector('#grid');
const filterEl = document.querySelector('#filter');
const countStreamsEl = document.querySelector('#countStreams');
const countPlayersEl = document.querySelector('#countPlayers');
const toastHost = document.querySelector('#toastHost');
const focusEl = document.querySelector('#focus');
const focusHost = document.querySelector('#focusHost');

function toast(msg, type = 'info', timeout = 2200) {
  const t = document.createElement('div');
  t.style.background = 'var(--panel)'; t.style.border = 'var(--border)';
  t.style.borderLeft = '4px solid ' + (type === 'err' ? 'var(--danger)' : type === 'warn' ? '#ffb547' : 'var(--blue)');
  t.style.padding = '10px 14px'; t.style.borderRadius = '8px'; t.style.maxWidth = '60ch';
  t.style.whiteSpace = 'pre-wrap';
  t.textContent = msg;
  toastHost.appendChild(t); setTimeout(() => t.remove(), timeout);
}

// Theme + view mode
const themeBtn = document.querySelector('#toggleTheme');
(() => { const saved = localStorage.getItem('theme') || 'dark'; document.body.dataset.theme = saved; })();
themeBtn.onclick = () => { const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark'; document.body.dataset.theme = next; localStorage.setItem('theme', next); themeBtn.innerText = (next === 'dark' ? '🌗 Theme' : '🌞 Theme'); };

const modeBtns = { grid: document.querySelector('#viewGrid'), theater: document.querySelector('#viewTheater'), list: document.querySelector('#viewList') };
function setView(mode) {
  document.body.classList.remove('view--grid', 'view--theater', 'view--list');
  document.body.classList.add(`view--${mode}`);
  Object.entries(modeBtns).forEach(([k, btn]) => btn.setAttribute('aria-pressed', k === mode ? 'true' : 'false'));
  localStorage.setItem('view', mode);
}
setView(localStorage.getItem('view') || 'grid');
modeBtns.grid.onclick = () => setView('grid');
modeBtns.theater.onclick = () => setView('theater');
modeBtns.list.onclick = () => setView('list');

window.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes((e.target.tagName || ''))) return;
  if (e.key === 'g' || e.key === 'G') setView('grid');
  if (e.key === 't' || e.key === 'T') setView('theater');
  if (e.key === 'l' || e.key === 'L') setView('list');
  if (e.key === 'r' || e.key === 'R') refreshList();
  if (e.key === 'm' || e.key === 'M') muteAll();
  if (e.key === 'Escape') { exitFocusMode(); Chat.close(); }
});

async function loadDevice() {
  if (device) return;
  const routerRtpCapabilities = await (await API('/rtpCapabilities')).json();
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities });
}
async function createRecvTransport() {
  if (recvTransport) return;
  const data = await (await API('/createWebRtcTransport', { method: 'POST' })).json();
  recvTransport = device.createRecvTransport({
    id: data.id, iceParameters: data.iceParameters, iceCandidates: data.iceCandidates, dtlsParameters: data.dtlsParameters
  });
  recvTransport.on('connect', async ({ dtlsParameters }, cb, errb) => {
    try {
      await API('/connectWebRtcTransport', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transportId: recvTransport.id, dtlsParameters }) });
      cb();
    } catch (e) { errb(e); }
  });
}

async function refreshList() {
  const list = await (await API('/streams')).json();
  currentStreams = list;
  countStreamsEl.textContent = `${list.length} online`;

  const alive = new Set(list.map(s => s.id));
  if (focus.id && !alive.has(focus.id)) { toast('Focused stream is offline', 'warn', 4000); exitFocusMode(); }

  if (focus.id) {
    list.filter(s => s.id !== focus.id).forEach(s => { if (!players.has(s.id)) playOne(s.id, s); });
    Array.from(players.keys()).forEach(id => { if (id !== focus.id && !alive.has(id)) removeCard(id); });
    // update viewer badges
    for (const s of list) {
      const p = players.get(s.id);
      if (p) {
        const vc = p.el.querySelector('[data-viewers]');
        if (vc) vc.innerText = `👁 ${s.viewerCount || 0}`;
      }
    }
    updateCounters();
    return;
  }

  for (const s of list) if (!players.has(s.id)) await playOne(s.id, s);
  for (const id of Array.from(players.keys())) if (!alive.has(id)) removeCard(id);

  // update viewer badges
  for (const s of list) {
    const p = players.get(s.id);
    if (p) {
      const vc = p.el.querySelector('[data-viewers]');
      if (vc) vc.innerText = `👁 ${s.viewerCount || 0}`;
    }
  }
  renderGrid(list, filterEl.value.trim().toLowerCase());
}
function renderGrid(list, q = '') {
  const filteredIds = new Set(list.filter(s => (s.name + s.id).toLowerCase().includes(q)).map(s => s.id));
  for (const [id, player] of players) player.el.style.display = filteredIds.has(id) ? '' : 'none';
  countStreamsEl.textContent = `${filteredIds.size}/${list.length} online`;
  updateCounters();
}
filterEl.addEventListener('input', () => renderGrid(currentStreams, filterEl.value.trim().toLowerCase()));

async function playOne(id, streamInfo) {
  if (players.has(id)) { players.get(id).el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  if (!device) await loadDevice();
  if (!recvTransport) await createRecvTransport();

  const prods = await (await API(`/cameras/${id}/producers`)).json();
  if (!prods.videoProducerId && !prods.audioProducerId) { toast('No producers for this camera. Start FFmpeg and call /produce.', 'warn', 4000); return; }

  const card = createCard(id, streamInfo);
  gridEl.appendChild(card.el);
  players.set(id, { el: card.el, consumers: [], mediaStream: new MediaStream(), videoEl: card.video, timers: {}, lastStats: {}, slider: card.slider });
  updateCounters();

  // Video
  if (prods.videoProducerId) {
    const cv = await (await API('/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transportId: recvTransport.id, producerId: prods.videoProducerId, rtpCapabilities: device.rtpCapabilities }) })).json();
    if (!cv.error) {
      const cV = await recvTransport.consume({ id: cv.id, producerId: cv.producerId, kind: cv.kind, rtpParameters: cv.rtpParameters });
      players.get(id).consumers.push(cV);
      try { await cV.resume(); } catch { }
      players.get(id).mediaStream.addTrack(cV.track);
    } else { toast(`Failed to subscribe video: ${cv.error}`, 'err', 4000); }
  }
  // Audio
  if (prods.audioProducerId) {
    const ca = await (await API('/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transportId: recvTransport.id, producerId: prods.audioProducerId, rtpCapabilities: device.rtpCapabilities }) })).json();
    if (!ca.error) {
      const cA = await recvTransport.consume({ id: ca.id, producerId: ca.producerId, kind: ca.kind, rtpParameters: ca.rtpParameters });
      players.get(id).consumers.push(cA);
      try { cA.resume?.(); } catch { }
      players.get(id).mediaStream.addTrack(cA.track);
    } else { toast(`Failed to subscribe audio: ${ca.error}`, 'warn', 3500); }
  }

  const p = players.get(id);
  p.videoEl.muted = true; p.videoEl.volume = 1; p.videoEl.srcObject = p.mediaStream;

  try { await p.videoEl.play(); card.onVideoReady(); attachRVFC(p.videoEl); }
  catch { card.showTapToPlay(() => p.videoEl.play().catch(() => { })); }

  p.timers.stats = setInterval(() => updateStats(id), 1000);
}

function removeCard(id) {
  const p = players.get(id); if (!p) return;
  try {
    if (p.timers.stats) clearInterval(p.timers.stats);
    for (const c of p.consumers) { try { c.close?.(); } catch { } }
    if (p.mediaStream) { for (const tr of p.mediaStream.getTracks()) tr.stop(); }
  } finally {
    p.videoEl.srcObject = null;
    if (focus.id === id) exitFocusMode();
    p.el.remove();
    players.delete(id);
    updateCounters();
  }
}
function updateCounters() { countPlayersEl.textContent = `${players.size} playing`; }

function createCard(id, streamInfo) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = id;

  let audioControlsHtml = '';
  if (streamInfo.hasAudio) {
    audioControlsHtml = `
<div class="audio-control-group" style="display:inline-block;position:relative;">
  <button class="btn" data-mute title="Toggle Volume">🔊</button>
</div>`;
  }

  const camName = streamInfo.name || id;

  el.innerHTML = `
<div class="card__hd">
  <div class="title">
    <span>📡</span>
    <span class="cam-name" title="${escapeHtml(camName)}\nID: ${id}" style="font-size:16px;font-weight:600;user-select: none;">
      ${escapeHtml(camName)}
    </span>
    <span class="badge" style="margin-left:8px;">
      ${streamInfo.hasVideo ? '🎥 Video' : ''} ${streamInfo.hasAudio ? '🔊 Audio' : ''}
    </span>
  </div>
  <div style="display:flex; align-items:center; gap:8px;">
    <button class="badge viewer" data-viewers title="Viewers">👁 0</button>
    <span class="badge liveText" title="Live only (no replay)">LIVE</span>
  </div>
</div>
<div class="videoWrap">
  <div class="skeleton" data-skel></div>
  <video playsinline autoplay></video>
  <div class="overlay">
    <div class="controls" title="Player controls">
      ${audioControlsHtml}
      <button class="btn" data-snap title="Screenshot (PNG)">📸</button>
      <button class="btn" data-pip title="Picture-in-Picture">PiP</button>
      <button class="btn" data-fs title="Fullscreen">⛶</button>
      <button class="toggle" data-stats-toggle title="Show/Hide status" aria-pressed="true">Status</button>
    </div>
    <div class="stats" data-stats>
      <span data-bitrate>0 kbps</span><span>|</span>
      <span data-fps>0 fps</span><span>|</span>
      <span data-size>0×0</span><span>|</span>
      <span data-pl>0.0% loss</span>
    </div>
  </div>
</div>
<div class="meters no-select">
  <div class="meter" title="Video bitrate">
    <span class="meterText" data-meter-v-text>0 kbps</span>
    <span data-meter-v></span>
    <span class="label">Video</span>
  </div>
  <div class="meter" title="Audio bitrate">
    <span class="meterText" data-meter-a-text>0 kbps</span>
    <span data-meter-a></span>
    <span class="label">Audio</span>
  </div>
</div>`;

  const nameSpan = el.querySelector('.cam-name');
  if (nameSpan) {
    nameSpan.onclick = function () {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
        navigator.clipboard.writeText(id).then(() => { toast('Copied ID!', 'info', 1500); }).catch(() => { toast('Copy failed', 'err', 1500); });
      } else {
        const tmp = document.createElement("textarea");
        tmp.value = id; tmp.style.position = "fixed"; tmp.style.opacity = "0";
        document.body.appendChild(tmp); tmp.focus(); tmp.select();
        try { document.execCommand("copy"); toast('Copied ID!', 'info', 1500); }
        catch { toast('Copy failed', 'err', 1500); }
        document.body.removeChild(tmp);
      }
    };
  }

  const video = el.querySelector('video');
  const skel = el.querySelector('[data-skel]');
  const statsBox = el.querySelector('[data-stats]');
  const btnStats = el.querySelector('[data-stats-toggle]');
  const muteBtn = el.querySelector('[data-mute]');
  const viewerBtn = el.querySelector('[data-viewers]');
  let volSlider = null;

  if (viewerBtn) {
    viewerBtn.onclick = async () => {
      try {
        const r = await (await API(`/cameras/${id}/viewers`)).json();
        openViewerModal(id, r.ips || []);
      } catch { }
    };
  }

  if (muteBtn) {
    const audioGroup = muteBtn.parentElement;
    function showSlider() {
      if (volSlider) return;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'range vertical';
      slider.min = '0'; slider.max = '1'; slider.step = '0.01';
      slider.value = video.volume; slider.title = 'Volume';
      slider.style.position = 'absolute'; slider.style.left = '50%';
      slider.style.bottom = '160%'; slider.style.transform = 'translateX(-52%) rotate(-90deg)';
      slider.style.width = '80px'; slider.style.height = '32px'; slider.style.zIndex = '-10';
      audioGroup.style.position = 'relative';
      audioGroup.appendChild(slider);
      volSlider = slider;
      slider.oninput = () => { video.volume = Number(slider.value); if (video.volume > 0) video.muted = false; syncAudIcon(); };
      function hideSlider(e) {
        if (audioGroup.contains(e.relatedTarget)) return;
        if (volSlider) { audioGroup.removeChild(volSlider); volSlider = null; }
      }
      audioGroup.addEventListener('mouseleave', hideSlider);
      slider.addEventListener('blur', () => { if (volSlider) { audioGroup.removeChild(volSlider); volSlider = null; } });
      slider.focus();
    }
    muteBtn.addEventListener('mouseenter', showSlider);
    muteBtn.addEventListener('focus', showSlider);
    muteBtn.onclick = () => { video.muted = !video.muted; syncAudIcon(); };
  }

  el.querySelector('[data-pip]').onclick = async () => { if ('requestPictureInPicture' in video) { try { await video.requestPictureInPicture(); } catch { } } };
  el.querySelector('[data-fs]').onclick = () => { const wrap = el.querySelector('.videoWrap'); if (document.fullscreenElement) document.exitFullscreen(); else wrap.requestFullscreen?.(); };
  btnStats.onclick = () => {
    const hidden = statsBox.hasAttribute('hidden');
    if (hidden) statsBox.removeAttribute('hidden'); else statsBox.setAttribute('hidden', '');
    btnStats.setAttribute('aria-pressed', hidden ? 'true' : 'false');
  };
  el.querySelector('[data-snap]').onclick = () => downloadSnapshot(video, id);
  el.addEventListener('dblclick', () => enterFocusMode(id));

  function syncAudIcon() { if (muteBtn) muteBtn.textContent = (video.muted || video.volume === 0) ? '🔇' : '🔊'; }
  function onVideoReady() { skel.remove(); syncAudIcon(); }
  function showTapToPlay(handler) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.position = 'absolute';
    btn.style.left = '50%'; btn.style.top = '50%'; btn.style.transform = 'translate(-50%,-50%)';
    btn.textContent = 'Tap to play';
    btn.onclick = () => { handler(); btn.remove(); };
    el.querySelector('.videoWrap').appendChild(btn);
  }

  return { el, video, onVideoReady, showTapToPlay, slider: volSlider };
}

async function updateStats(id) {
  const p = players.get(id); if (!p) return;
  let vBytes = 0, aBytes = 0, lost = 0, rx = 0;
  try {
    for (const c of p.consumers) {
      const st = await c.getStats();
      st.forEach(r => {
        if (r.type === 'inbound-rtp' && !r.isRemote) {
          if (c.kind === 'video') { vBytes += (r.bytesReceived || 0); lost += (r.packetsLost || 0); rx += (r.packetsReceived || 0); }
          if (c.kind === 'audio') { aBytes += (r.bytesReceived || 0); }
        }
      });
    }
  } catch { return; }

  const now = performance.now(), last = p.lastStats || {};
  const dt = last.t ? (now - last.t) : 1000;
  const vb = Math.max(0, vBytes - (last.vBytes || 0));
  const ab = Math.max(0, aBytes - (last.aBytes || 0));
  const bitrateKbps = (vb * 8 / dt);
  const abitrateKbps = (ab * 8 / dt);
  const fps = getFps(p.videoEl);
  const vw = p.videoEl.videoWidth || 0, vh = p.videoEl.videoHeight || 0;
  const loss = (rx + lost) ? (lost / (rx + lost) * 100) : 0;

  p.lastStats = { t: now, vBytes, aBytes };

  const card = p.el;
  card.querySelector('[data-bitrate]').textContent = `${bitrateKbps.toFixed(0)} kbps`;
  card.querySelector('[data-fps]').textContent = `${fps.toFixed(0)} fps`;
  card.querySelector('[data-size]').textContent = `${vw}×${vh}`;
  card.querySelector('[data-pl]').textContent = `${loss.toFixed(1)}% loss`;

  const vPct = Math.min(100, bitrateKbps / 6000 * 100), aPct = Math.min(100, abitrateKbps / 320 * 100);
  card.querySelector('[data-meter-v]').style.width = `${vPct}%`;
  card.querySelector('[data-meter-a]').style.width = `${aPct}%`;

  const vTxt = card.querySelector('[data-meter-v-text]');
  const aTxt = card.querySelector('[data-meter-a-text]');
  if (vTxt) vTxt.textContent = `${Math.max(0, bitrateKbps).toFixed(0)} kbps`;
  if (aTxt) aTxt.textContent = `${Math.max(0, abitrateKbps).toFixed(0)} kbps`;
}

// FPS helpers
const rvfcMap = new Map();
function attachRVFC(video) {
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const meta = { frames0: 0, frames: 0, t0: performance.now() }; rvfcMap.set(video, meta);
    const cb = (_ts, m) => { meta.frames = m.presentedFrames; if (!meta.frames0) meta.frames0 = meta.frames; video.requestVideoFrameCallback(cb); };
    video.requestVideoFrameCallback(cb);
  }
}
function getFps(video) {
  const meta = rvfcMap.get(video); if (!meta) return 0;
  const dt = (performance.now() - meta.t0) / 1000;
  const frames = Math.max(0, (meta.frames || 0) - (meta.frames0 || 0));
  return dt > 0 ? frames / dt : 0;
}

function downloadSnapshot(video, id) {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) { toast('No video frame to capture', 'warn'); return; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  const url = c.toDataURL('image/png'); const a = document.createElement('a'); const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url; a.download = `${id}_${ts}.png`; document.body.appendChild(a); a.click(); a.remove();
  toast('Screenshot saved');
}

let hideControlsTimer = null;
function setupFocusPlayerAutoHide(id) {
  const p = players.get(id);
  if (!p) return;
  const wrap = p.el.querySelector('.videoWrap');
  if (!wrap) return;
  function showControls() { wrap.classList.remove('hide-controls'); resetTimer(); }
  function hideControls() { wrap.classList.add('hide-controls'); }
  function resetTimer() { if (hideControlsTimer) clearTimeout(hideControlsTimer); hideControlsTimer = setTimeout(hideControls, 1500); }
  wrap.addEventListener('mousemove', showControls);
  wrap.addEventListener('click', showControls);
  showControls();
  wrap._autoHideClean = () => {
    wrap.removeEventListener('mousemove', showControls);
    wrap.removeEventListener('click', showControls);
    if (hideControlsTimer) clearTimeout(hideControlsTimer);
    wrap.classList.remove('hide-controls');
  };
}

function enterFocusMode(id) {
  const p = players.get(id); if (!p) return;
  if (focus.id) exitFocusMode();

  focus.placeholder = document.createElement('div'); focus.placeholder.style.display = 'none';
  p.el.parentElement.insertBefore(focus.placeholder, p.el);

  const header = document.createElement('div');
  header.className = 'focusBar no-select';
  header.style.marginBottom = '10px';
  header.innerHTML = `
<div class="brand"><span class="logo"></span><span>Focus view</span></div>
<div><button id="exitFocus" class="btn exitFocus" title="Return to grid">Exit</button></div>`;
  header.querySelector('#exitFocus').onclick = exitFocusMode;

  p.el.insertBefore(header, p.el.firstChild);
  focusHost.appendChild(p.el);
  focus.id = id;
  p.el.classList.add('focusCard');
  document.getElementById('focus').classList.add('show');
  setupFocusPlayerAutoHide(id);
}

function exitFocusMode() {
  if (!focus.id) return;
  const p = players.get(focus.id);
  if (p && p.el) { p.el.querySelectorAll('.focusBar').forEach(bar => bar.remove()); }
  if (p && focus.placeholder && focus.placeholder.parentElement) {
    focus.placeholder.parentElement.insertBefore(p.el, focus.placeholder);
    focus.placeholder.remove();
  }
  if (p && p.el) p.el.classList.remove('focusCard');
  const wrap = p && p.el ? p.el.querySelector('.videoWrap') : null;
  if (wrap && wrap._autoHideClean) wrap._autoHideClean();
  focus.id = null; focus.placeholder = null;
  document.getElementById('focus').classList.remove('show');
}

document.addEventListener('click', function (e) {
  if (e.target.classList.contains('exitFocus')) exitFocusMode();
});
focusEl.addEventListener('dblclick', exitFocusMode);

function muteAll() {
  const allMuted = Array.from(players.values()).every(({ videoEl }) => videoEl.muted);
  players.forEach(({ videoEl }) => { videoEl.muted = !allMuted; });
}

/* ---------- Viewer Modal ---------- */
const viewerModal = document.getElementById('viewerModal');
const viewerModalBody = document.getElementById('viewerModalBody');
document.getElementById('viewerModalClose').onclick = () => viewerModal.setAttribute('hidden', '');
function openViewerModal(camId, ips = []) {
  viewerModalBody.innerHTML = `<div style="margin-bottom:8px">Camera ID: <code>${escapeHtml(camId)}</code></div>` +
    (ips.length ? ips.map(ip => `<div class="ip">• ${escapeHtml(ip)}</div>`).join('') : '<div class="ip">No viewers</div>');
  viewerModal.removeAttribute('hidden');
}

/* ---------- Lightbox (zoom/pan, no fullscreen) ---------- */
const lightbox = document.getElementById('lightbox');
const lightboxBody = document.getElementById('lightboxBody');
document.getElementById('lightboxClose').onclick = () => lightbox.setAttribute('hidden', '');

function openLightbox(url) {
  lightboxBody.innerHTML = '';

  // Videos keep default behavior
  if (/\.(mp4|webm|ogg)(\?|#|$)/i.test(url)) {
    const v = document.createElement('video');
    v.src = url; v.controls = true; v.autoplay = true;
    v.style.maxWidth = '100%'; v.style.maxHeight = '92vh';
    lightboxBody.appendChild(v);
    lightbox.removeAttribute('hidden');
    return;
  }

  // Images: zoom/pan with auto-center when zoomed out to min
  const wrap = document.createElement('div');
  wrap.className = 'zoomWrap';

  const img = document.createElement('img');
  img.className = 'zoomImg';
  img.src = url;
  img.alt = 'preview';

  wrap.appendChild(img);
  lightboxBody.appendChild(wrap);
  lightbox.removeAttribute('hidden');

  let scale = 1;
  let minScale = 1;
  const maxScale = 6;
  let tx = 0, ty = 0; // translate in CSS pixels
  let isPanning = false;
  let panStartX = 0, panStartY = 0;

  const EPS = 1e-3;

  function dims() {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const iw = img.naturalWidth || img.width || 1;
    const ih = img.naturalHeight || img.height || 1;
    return { W, H, iw, ih };
  }

  function centerInWrap() {
    const { W, H, iw, ih } = dims();
    tx = (W - iw * scale) / 2;
    ty = (H - ih * scale) / 2;
  }

  function fitOnce() {
    const { W, H, iw, ih } = dims();
    const s = Math.min(W / iw, H / ih);
    // Do not upscale initially
    scale = Math.min(1, s);
    minScale = scale;
    centerInWrap();
    applyTransform();
  }

  function applyTransform() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function onWheel(e) {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const prev = scale;
    const factor = Math.exp((-e.deltaY) * 0.0015); // smooth zoom
    scale = clamp(prev * factor, minScale, maxScale);

    if (Math.abs(scale - minScale) <= EPS) {
      // Snap back to centered when hitting min scale
      scale = minScale;
      centerInWrap();
    } else {
      // Keep cursor point stationary
      tx = mx - (mx - tx) * (scale / prev);
      ty = my - (my - ty) * (scale / prev);
    }

    applyTransform();
  }

  function onPointerDown(e) {
    e.preventDefault();
    isPanning = true;
    wrap.classList.add('grabbing');
    panStartX = e.clientX - tx;
    panStartY = e.clientY - ty;
    wrap.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    if (!isPanning) return;
    tx = e.clientX - panStartX;
    ty = e.clientY - panStartY;
    applyTransform();
  }
  function onPointerUp(e) {
    isPanning = false;
    wrap.classList.remove('grabbing');
    wrap.releasePointerCapture?.(e.pointerId);
  }

  function onDblClick(e) {
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (Math.abs(scale - minScale) <= EPS) {
      // Zoom in from min -> 2x around cursor
      const prev = scale;
      scale = Math.min(2, maxScale);
      tx = mx - (mx - tx) * (scale / prev);
      ty = my - (my - ty) * (scale / prev);
    } else {
      // Back to min and re-center
      scale = minScale;
      centerInWrap();
    }
    applyTransform();
  }

  function onResize() {
    // When resized, refit baseline; if currently at min scale, re-center at min
    const atMin = Math.abs(scale - minScale) <= EPS;
    fitOnce();
    if (!atMin) applyTransform();
  }

  img.addEventListener('load', fitOnce, { once: true });
  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointerleave', onPointerUp);
  wrap.addEventListener('dblclick', onDblClick);
  window.addEventListener('resize', onResize, { passive: true });

  // Clean up listeners on close
  const cleanup = () => {
    window.removeEventListener('resize', onResize);
    wrap.removeEventListener('wheel', onWheel);
    wrap.removeEventListener('pointerdown', onPointerDown);
    wrap.removeEventListener('pointermove', onPointerMove);
    wrap.removeEventListener('pointerup', onPointerUp);
    wrap.removeEventListener('pointerleave', onPointerUp);
    wrap.removeEventListener('dblclick', onDblClick);
  };
  const obs = new MutationObserver((muts) => {
    if (lightbox.hasAttribute('hidden')) { cleanup(); obs.disconnect(); }
  });
  obs.observe(lightbox, { attributes: true, attributeFilter: ['hidden'] });
}


/* ---------- Utils ---------- */
function escapeHtml(s = '') { return s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
refreshList();
setInterval(refreshList, 1000);

/* ======================= CHAT ======================= */
const Chat = (() => {
  const fab = document.getElementById('chatFab');
  const panel = document.getElementById('chatPanel');
  const btnClose = document.getElementById('chatClose');
  const list = document.getElementById('chatList');

  // Composer
  const form = document.getElementById('chatForm');
  const input = document.getElementById('chatInput'); // textarea
  const btnAttach = document.getElementById('chatAttach');
  const file = document.getElementById('chatFile');
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPanel = document.getElementById('emojiPanel');
  const attachPreview = document.getElementById('attachPreview');
  const attachPreviewMedia = document.querySelector('.attachPreview__media');
  const attachPreviewRemove = document.querySelector('.attachPreview__remove');

  const me = document.getElementById('chatMe');

  let es = null;
  let lastLoadedMinId = null;
  let myIP = '-';

  // Pending attachment (previewed until sending)
  /** @type {{file: File, url: string, kind: 'image'|'video'} | null} */
  let pendingAttachment = null;

  function isOpen() { return !panel.hasAttribute('hidden'); }
  function open() { panel.removeAttribute('hidden'); setTimeout(() => list.scrollTop = list.scrollHeight, 0); }
  function close() { panel.setAttribute('hidden', ''); hideEmoji(); }
  fab.onclick = () => open();
  btnClose.onclick = close;

  // ESC to close
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });

  // Click outside emoji popover closes it
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    if (!emojiPanel.hasAttribute('hidden') && !emojiPanel.contains(e.target) && e.target !== emojiBtn) hideEmoji();
  });

  async function whoami() {
    try { const r = await (await API('/whoami')).json(); myIP = r.ip || '-'; me.textContent = `You: ${myIP}`; }
    catch { me.textContent = `You: -`; }
  }

  function connectSSE() {
    if (es) { es.close(); es = null; }
    es = new EventSource(`/chat/stream`);
    es.onmessage = (e) => {
      const wasClosed = !isOpen();
      appendMsg(JSON.parse(e.data), true);
      if (wasClosed) showNotify();
    };
  }

  async function loadHistory(initial = false) {
    const q = new URLSearchParams({ limit: '60' });
    if (lastLoadedMinId) q.set('beforeId', String(lastLoadedMinId));
    const r = await (await API(`/chat/history?${q.toString()}`)).json();
    const msgs = r.messages || [];
    if (msgs.length) {
      lastLoadedMinId = msgs[msgs.length - 1].id;
      const before = list.scrollHeight;
      const frag = document.createDocumentFragment();
      for (let i = msgs.length - 1; i >= 0; i--) frag.appendChild(renderMsg(msgs[i]));
      list.prepend(frag);
      if (initial) list.scrollTop = list.scrollHeight; else list.scrollTop = list.scrollHeight - before;
    }
  }

  function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h >>> 0; }
  function avatarDataUrl(ip) {
    const h = hash(ip);
    const hue = h % 360;
    const fg = `hsl(${hue},70%,55%)`;
    const bg = `hsl(${(h + 180) % 360},30%,18%)`;
    const cells = [];
    for (let r = 0; r < 5; r++) {
      let rowBits = (h >> (r * 5)) & 31;
      const row = [];
      for (let c = 0; c < 3; c++) { row.push((rowBits >> c) & 1); }
      const mirror = [row[1], row[0]];
      cells.push([...row, ...mirror]);
    }
    let rects = '';
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) if (cells[r][c]) rects += `<rect x="${c}" y="${r}" width="1" height="1" rx="0.2" ry="0.2"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5 5"><rect width="5" height="5" fill="${bg}"/><g fill="${fg}">${rects}</g></svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  function emojify(text = '') {
    // Basic emoticon -> emoji replacements
    const rules = [
      [/(^|[\s])(:-?\))/g, "$1🙂"],
      [/(^|[\s])(:-?\()/g, "$1🙁"],
      [/(^|[\s]);-?\)/g, "$1😉"],
      [/(^|[\s])(:-?D)/gi, "$1😃"],
      [/(^|[\s])([xX]-?D)/g, "$1😆"],
      [/(^|[\s])(:-?[pP])/g, "$1😛"],
      [/(^|[\s])(:-?[oO])/g, "$1😮"],
      [/(^|[\s])(:-?\|)/g, "$1😐"],
      [/(^|[\s])(:'\()/g, "$1😢"],
      [/(^|[\s])(:-?\*)/g, "$1😘"],
      [/(^|[\s])<3/g, "$1❤️"],
      [/(^|[\s])(:-?\/)/g, "$1😕"],
    ];
    let out = text;
    for (const [re, rep] of rules) out = out.replace(re, rep);
    return out;
  }

  function renderMsg(m) {
    const el = document.createElement('div'); el.className = 'chat__msg';
    const mine = (m.ip || '') === myIP;
    if (mine) el.classList.add('me');

    const av = document.createElement('div'); av.className = 'avatar';
    const img = document.createElement('img'); img.src = avatarDataUrl(m.ip || '?'); img.alt = 'avatar';
    av.appendChild(img);

    const b = document.createElement('div'); b.className = 'bubble';
    const meta = document.createElement('div'); meta.className = 'meta';
    const d = new Date(m.ts || Date.now());
    meta.textContent = `${m.ip || '?'} • ${d.toLocaleTimeString()}`;
    const content = document.createElement('div'); content.className = 'content';
    if (m.text) content.textContent = emojify(m.text);

    b.appendChild(meta);
    if (m.text) b.appendChild(content);

    const mediaUrl = m.mediaUrl || m.imageUrl || null;
    if (mediaUrl) {
      if (/\.(mp4|webm|ogg)(\?|#|$)/i.test(mediaUrl) || (m.mediaType === 'video')) {
        const v = document.createElement('video'); v.className = 'media'; v.src = mediaUrl; v.controls = true;
        v.onclick = () => openLightbox(mediaUrl);
        b.appendChild(v);
      } else {
        const im = document.createElement('img'); im.className = 'media'; im.src = mediaUrl; im.alt = 'image';
        im.onclick = () => openLightbox(mediaUrl);
        b.appendChild(im);
      }
    }

    el.appendChild(av); el.appendChild(b);
    return el;
  }
  function appendMsg(m, scroll) {
    list.appendChild(renderMsg(m));
    if (scroll) list.scrollTop = list.scrollHeight;
  }

  // ========== Composer logic ==========
  function setPendingAttachment(fileObj) {
    pendingAttachment = fileObj;

    form.classList.toggle('has-attach', !!fileObj);

    if (!fileObj) {
      attachPreview.setAttribute('hidden', '');
      attachPreviewMedia.innerHTML = '';
      return;
    }
    attachPreviewMedia.innerHTML = '';
    if (fileObj.kind === 'video') {
      const v = document.createElement('video');
      v.src = fileObj.url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
      attachPreviewMedia.appendChild(v);
    } else {
      const im = document.createElement('img');
      im.src = fileObj.url; attachPreviewMedia.appendChild(im);
    }
    attachPreview.removeAttribute('hidden');
  }

  attachPreviewRemove.onclick = () => setPendingAttachment(null);

  // Attach button -> choose file (preview inside textbox, do NOT send)
  btnAttach.onclick = () => file.click();
  file.onchange = () => {
    const f = file.files?.[0]; if (!f) return;
    if (!(f.type.startsWith('image/') || f.type.startsWith('video/'))) { toast('Only image or video', 'warn'); return; }
    const kind = f.type.startsWith('video/') ? 'video' : 'image';
    const url = URL.createObjectURL(f);
    setPendingAttachment({ file: f, url, kind });
    file.value = '';
    input.focus();
  };

  // Paste: if file -> preview; otherwise allow normal text paste
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items || [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && (f.type.startsWith('image/') || f.type.startsWith('video/'))) {
          const kind = f.type.startsWith('video/') ? 'video' : 'image';
          const url = URL.createObjectURL(f);
          setPendingAttachment({ file: f, url, kind });
          e.preventDefault();
          return;
        }
      }
    }
  });

  // Enter to send (Shift+Enter = newline)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  async function uploadPending() {
    if (!pendingAttachment) return null;

    const src = pendingAttachment.file;
    const kind = pendingAttachment.kind; // 'image' | 'video'

    const nameGuess = (src && src.name) ? src.name :
      (kind === 'video' ? 'upload.mp4' : 'upload.png');
    const typeGuess = (src && src.type) ? src.type :
      (kind === 'video' ? 'video/mp4' : 'image/png');

    const fileToSend = (src instanceof File)
      ? src
      : new File([src], nameGuess, { type: typeGuess });

    const fd = new FormData();
    fd.append('file', fileToSend, fileToSend.name);

    const endpoint = `/chat/upload?type=${kind === 'video' ? 'video' : 'image'}`;
    const res = await fetch(endpoint, { method: 'POST', body: fd });

    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${raw.slice(0, 200)}`);
    }

    let data;
    try {
      data = ct.includes('application/json') ? JSON.parse(raw) : { url: raw };
    } catch {
      throw new Error(`Expected JSON, got: ${raw.slice(0, 200)}`);
    }

    if (!data.url) throw new Error(`Server response missing "url"`);
    return data.url;
  }


  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    const hasText = text.length > 0;
    const hasAtt = !!pendingAttachment;

    if (!hasText && !hasAtt) return;

    try {
      let url = null;
      let kind = null;
      if (hasAtt) { url = await uploadPending(); kind = pendingAttachment.kind; }
      await send(text, url, kind);
      // clear composer
      input.value = '';
      setPendingAttachment(null);
      hideEmoji();
    } catch (err) {
      toast('Send failed' + (err?.message ? `: ${err.message}` : ''), 'err');
    }
  };

  async function send(text, mediaUrl = null, mediaType = null) {
    const body = { text, mediaUrl, imageUrl: mediaUrl, mediaType }; // send both keys for compatibility
    const r = await (await API('/chat/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })).json();
    if (r.error) throw new Error(r.error);
    // message will arrive via SSE
  }

  // ========== Emoji ==========
  function showEmoji() { emojiPanel.removeAttribute('hidden'); }
  function hideEmoji() { emojiPanel.setAttribute('hidden', ''); }
  emojiBtn.onclick = () => { emojiPanel.hasAttribute('hidden') ? buildEmojiOnceAndShow() : hideEmoji(); };

  function insertEmoji(char) {
    // Insert into textarea at caret
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const v = input.value;
    input.value = v.slice(0, start) + char + v.slice(end);
    const pos = start + char.length;
    input.selectionStart = input.selectionEnd = pos;
    input.focus();
  }

  function buildEmojiOnceAndShow() {
    if (emojiPanel._built) { showEmoji(); return; }

    const EMOJIS = [
      "😀", "😃", "😄", "😁", "😆", "😂", "🤣", "😊", "😇", "🙂", "🙃",
      "😍", "🥰", "😘", "😗", "☺️", "😚", "😙", "🥲",
      "😋", "😛", "😜", "🤪", "😝", "🤑", "😉", "🤭", "🤫", "🤗", "🤔",
      "🤐", "🤨", "😐", "😑", "😶", "😴", "😪", "😮‍💨",
      "😮", "😯", "😲", "😳", "🥺", "😦", "😧", "😨", "😰", "😥", "😢", "😭",
      "😱", "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠",
      "🤒", "🤕", "🤢", "🤮", "🤧", "🥵", "🥶", "😷",
      "🤯", "🥳", "😎", "🤓", "🧐", "🤠", "🫡", "🫠", "🫥", "🫢", "🫣",
      "😈", "👿", "😇",
      "💋", "❤️‍🔥", "❤️‍🩹"
    ];

    const frag = document.createDocumentFragment();
    EMOJIS.forEach(e => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = e;
      b.onclick = () => insertEmoji(e);
      frag.appendChild(b);
    });
    emojiPanel.appendChild(frag);
    emojiPanel._built = true;
    showEmoji();
  }

  async function init() {
    await whoami();
    connectSSE();
    await loadHistory(true);
  }
  init();

  return { close };
})();
