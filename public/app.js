// Browser client (ESM). Loads mediasoup-client from CDN (esm.sh).
// Subscribes to both video and audio tracks, forces keyframe and autoplay.
// ĐÃ FIX: chống nhân đôi player, thêm Stop/cleanup, requestKeyFrame nhiều lần.

import * as mediasoupClient from 'https://esm.sh/mediasoup-client@3.14.2';

const API = (p, o) => fetch(p, o);

let device = null;
let recvTransport = null;

// Registry tránh trùng player & quản lý cleanup
// cameraId -> { el, consumers, mediaStream, videoEl, pollTimer }
const players = new Map();

async function loadDevice() {
  const routerRtpCapabilities = await (await API('/rtpCapabilities')).json();
  device = new mediasoupClient.Device();
  await device.load({ routerRtpCapabilities });
  console.log('[Client] Device loaded');
}

async function createRecvTransport() {
  const data = await (await API('/createWebRtcTransport', { method: 'POST' })).json();

  recvTransport = device.createRecvTransport({
    id: data.id,
    iceParameters: data.iceParameters,
    iceCandidates: data.iceCandidates,
    dtlsParameters: data.dtlsParameters
  });

  recvTransport.on('connect', async ({ dtlsParameters }, cb, errb) => {
    try {
      await API('/connectWebRtcTransport', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transportId: recvTransport.id, dtlsParameters })
      });
      cb();
    } catch (e) { errb(e); }
  });

  recvTransport.on('connectionstatechange', s => console.log('[Client] recvTransport state:', s));
  console.log('[Client] RecvTransport created');
}

async function refreshList() {
  const list = await (await API('/streams')).json();
  const sel = document.querySelector('#streamSel');
  sel.innerHTML = '';
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.name} ${s.hasVideo ? '🎥' : ''}${s.hasAudio ? '🔊' : ''}`;
    sel.appendChild(opt);
  }
  console.log('[Client] streams:', list);

  // Gỡ player không còn trong danh sách nữa
  const aliveIds = new Set(list.map(s => s.id));
  for (const id of Array.from(players.keys())) {
    if (!aliveIds.has(id)) stopOne(id);
  }

  return list;
}

async function playOne(cameraId) {
  // Đã có player cho cam này => không tạo thêm
  if (players.has(cameraId)) {
    const { el } = players.get(cameraId);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('blink');
    setTimeout(() => el.classList.remove('blink'), 500);
    console.log('[Client] already playing', cameraId);
    return;
  }

  const prods = await (await API(`/cameras/${cameraId}/producers`)).json();
  if (!prods.videoProducerId && !prods.audioProducerId) {
    alert('No producers for this camera. Start FFmpeg and call /produce.');
    return;
  }

  const mediaStream = new MediaStream();
  const consumers = [];

  // ---- VIDEO ----
  if (prods.videoProducerId) {
    const cv = await (await API('/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transportId: recvTransport.id,
        producerId: prods.videoProducerId,
        rtpCapabilities: device.rtpCapabilities
      })
    })).json();

    if (!cv.error) {
      const consumerV = await recvTransport.consume({
        id: cv.id,
        producerId: cv.producerId,
        kind: cv.kind,
        rtpParameters: cv.rtpParameters
      });
      consumers.push(consumerV);

      try {
        await consumerV.resume();
        console.log('[Client] video consumer resumed');
      } catch (e) {
        console.warn('[Client] video resume failed:', e);
      }

      // Yêu cầu keyframe 3 lần
      try {
        if (typeof consumerV.requestKeyFrame === 'function') {
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 500));
            console.log(`[Client] requesting keyframe ${i}`);
            await consumerV.requestKeyFrame();
          }
        }
      } catch (e) {
        console.warn('video requestKeyFrame failed:', e);
      }

      mediaStream.addTrack(consumerV.track);

      // Debug thêm: bytes nhận
      setTimeout(async () => {
        try {
          const st = await consumerV.getStats();
          let bytes = 0;
          st.forEach(r => {
            if (r.type === 'inbound-rtp' && !r.isRemote) bytes += (r.bytesReceived || 0);
          });
          console.log('[Client] inbound video bytesReceived=', bytes);
        } catch {}
      }, 3000);

    } else {
      console.warn('[Client] cannot consume video:', cv.error);
    }
  }

  // ---- AUDIO ----
  if (prods.audioProducerId) {
    const ca = await (await API('/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transportId: recvTransport.id,
        producerId: prods.audioProducerId,
        rtpCapabilities: device.rtpCapabilities
      })
    })).json();

    if (!ca.error) {
      const consumerA = await recvTransport.consume({
        id: ca.id,
        producerId: ca.producerId,
        kind: ca.kind,
        rtpParameters: ca.rtpParameters
      });
      consumers.push(consumerA);

      try { typeof consumerA.resume === 'function' && consumerA.resume(); } catch (e) {
        console.warn('audio resume failed:', e);
      }

      mediaStream.addTrack(consumerA.track);
    } else {
      console.warn('[Client] cannot consume audio:', ca.error);
    }
  }

  // ---- UI card ----
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <h4 class="row">
      <span>${cameraId}</span>
      <span>
        <button class="stopBtn" type="button" title="Stop & remove">Stop</button>
      </span>
    </h4>
    <video playsinline autoplay></video>
  `;
  document.querySelector('#grid').appendChild(el);
  const videoEl = el.querySelector('video');

  videoEl.muted = false; // allow autoplay
  videoEl.srcObject = mediaStream;

  // lưu registry trước khi play
  const pollTimer = setInterval(() => pollIngestStats(cameraId), 5000);
  players.set(cameraId, { el, consumers, mediaStream, videoEl, pollTimer });

  try {
    await videoEl.play();
    attachVideoDebug(videoEl, cameraId);
  } catch (e) {
    console.warn('Autoplay blocked, click the video to start', e);
    videoEl.controls = true;
  }

  // Stop button
  el.querySelector('.stopBtn').onclick = () => stopOne(cameraId);

  console.log('[Client] playing camera', cameraId);
}

function stopOne(cameraId) {
  const p = players.get(cameraId);
  if (!p) return;
  try {
    if (p.pollTimer) clearInterval(p.pollTimer);
    for (const c of p.consumers) { try { c.close?.(); } catch {} }
    if (p.mediaStream) {
      for (const tr of p.mediaStream.getTracks()) tr.stop();
    }
  } finally {
    p.videoEl.srcObject = null;
    p.el.remove();
    players.delete(cameraId);
    console.log('[Client] stopped', cameraId);
  }
}

// Debug readyState, frames, ingest
function attachVideoDebug(videoEl, cameraId) {
  const logRS = (tag='') => console.log(
    `[Video${tag}] id=${cameraId} t=${videoEl.currentTime.toFixed(2)}s ` +
    `RS=${videoEl.readyState} ${videoEl.videoWidth}x${videoEl.videoHeight}`
  );
  ['loadedmetadata','loadeddata','canplay','play','playing','pause','stalled','waiting','suspend','ended']
    .forEach(ev => videoEl.addEventListener(ev, () => logRS(`:${ev}`)));
  videoEl.addEventListener('error', e => console.error('[Video:error]', e));
  setInterval(() => logRS(), 2000);

  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const cb = (_ts, meta) => {
      console.log(`[RVFC] frames=${meta.presentedFrames} ${meta.width}x${meta.height}`);
      videoEl.requestVideoFrameCallback(cb);
    };
    videoEl.requestVideoFrameCallback(cb);
  }
}

async function pollIngestStats(cameraId) {
  try {
    const s = await (await fetch(`/debug/cameras/${cameraId}/stats`)).json();
    console.log('[Ingest]', cameraId, 'video.bytes=', s.videoPlain?.bytesReceived, 'audio.bytes=', s.audioPlain?.bytesReceived);
  } catch (e) {
    console.warn('pollIngestStats error', e);
  }
}

// UI bindings
document.querySelector('#refresh').onclick = refreshList;
document.querySelector('#play').onclick = async () => {
  const sel = document.querySelector('#streamSel');
  const cameraId = sel.value;
  if (!cameraId) return alert('No stream');
  if (!device) await loadDevice();
  if (!recvTransport) await createRecvTransport();
  await playOne(cameraId);
};

// Auto-refresh list
refreshList();
setInterval(refreshList, 5000);
