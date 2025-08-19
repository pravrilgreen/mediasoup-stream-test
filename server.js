// Minimal mediasoup forwarder (CommonJS)
// PlainRTP (FFmpeg) -> WebRTC to browser (audio + video)
// + Chat (SQLite, SSE, image/video upload), viewer counting by IP,
// liveness monitor, auto-remove dead cameras.
// NOTE: English-only code & comments.

const express = require('express');
const cors = require('cors');
const mediasoup = require('mediasoup');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');
const debugConsumers = new Map();

// -------- Config --------
const LISTEN_IP = '0.0.0.0';
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '127.0.0.1';
const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);

const WORKER_RTC_MIN_PORT = 40000;
const WORKER_RTC_MAX_PORT = 49999;

const ROUTER_CODECS = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    rtcpFeedback: [{ type: 'transport-cc' }]
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'level-asymmetry-allowed': 1,
      'profile-level-id': '42e01f'
    },
    rtcpFeedback: [
      { type: 'nack' },
      { type: 'nack', parameter: 'pli' },
      { type: 'ccm', parameter: 'fir' },
      { type: 'goog-remb' },
      { type: 'transport-cc' }
    ]
  }
];

const WEBRTC_OPTS = {
  listenIps: [{ ip: LISTEN_IP, announcedIp: ANNOUNCED_IP }],
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  initialAvailableOutgoingBitrate: 800000,
  minimumAvailableOutgoingBitrate: 300000
};

// PT/SSRC defaults (matches FFmpeg script: video PT=96, audio PT=97)
const DEFAULTS = { videoPt: 96, audioPt: 97, videoSsrc: 222222, audioSsrc: 111111, h264ProfileLevelId: '42e01f' };

// Liveness monitor
const LIVENESS_CHECK_INTERVAL_MS = 1000;
const INACTIVE_TIMEOUT_MS = 1000;
const DEAD_REMOVE_TIMEOUT_MS = 1000;

// ---- Chat (SQLite): latest 10k queue (global) ----
const DB_PATH = path.join(__dirname, 'chat.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.prepare(`
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  room TEXT NOT NULL,
  ip TEXT NOT NULL,
  text TEXT,
  imageUrl TEXT
)
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room, id DESC)`).run();
const insertMsg = db.prepare(`INSERT INTO messages(ts, room, ip, text, imageUrl) VALUES (?,?,?,?,?)`);
const getHistory = db.prepare(`
  SELECT id, ts, room, ip, text, imageUrl
  FROM messages
  WHERE room = ? AND id < COALESCE(?, 9223372036854775807)
  ORDER BY id DESC
  LIMIT ?
`);
function trimMessages() {
  // Keep only the newest 10,000 rows globally (queue semantics).
  db.prepare(`
    DELETE FROM messages
    WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 10000)
  `).run();
}

// ---- Uploads (images & videos) ----
const uploadsDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '.bin').toLowerCase();
    cb(null, `${Date.now()}_${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 20MB
  fileFilter: (_req, file, cb) => {
    const ok = (file.mimetype || '').startsWith('image/') || (file.mimetype || '').startsWith('video/');
    if (ok) cb(null, true); else cb(new Error('Only images or videos are allowed'));
  }
});

// ---- Helpers ----
function getIP(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

async function main() {
  const app = express();
  app.set('trust proxy', true);

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- mediasoup bootstrap ----
  const worker = await mediasoup.createWorker({
    rtcMinPort: WORKER_RTC_MIN_PORT,
    rtcMaxPort: WORKER_RTC_MAX_PORT,
    logLevel: 'warn',
    logTags: ['info', 'ice', 'dtls', 'rtp', 'rtcp']
  });
  worker.on('died', () => {
    console.error('[MS] Worker died; exiting in 2s');
    setTimeout(() => process.exit(1), 2000);
  });
  console.log('[MS] Worker created');

  const router = await worker.createRouter({
    mediaCodecs: ROUTER_CODECS,
    rtpHeaderExtensions: [
      { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', id: 1, encrypt: false },
      { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', id: 4, encrypt: false },
      { uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level', id: 10, encrypt: false },
      { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay', id: 14, encrypt: false }
    ]
  });
  console.log('[MS] Router created');

  // State
  const webrtcTransports = new Map(); // id -> WebRTC RecvTransport
  const transportClients = new Map(); // transportId -> { ip, ua }
  const cameras = new Map();          // id -> { name, transports, producers, monitor }
  const viewers = new Map();          // camId -> Map<ip, refCount>
  const consumerIndex = new Map();    // consumerId -> { camId, ip }

  // ---- Liveness monitor helpers ----
  function startMonitor(camId) {
    const cam = cameras.get(camId);
    if (!cam) return;

    cam.monitor = cam.monitor || {
      lastVideoBytes: 0,
      lastAudioBytes: 0,
      lastVideoAliveAt: Date.now(),
      lastAudioAliveAt: Date.now(),
      timer: null
    };

    async function poll() {
      try {
        if (cam.transports.videoPlain) {
          const vs = await cam.transports.videoPlain.getStats().catch(() => []);
          const v0 = Array.isArray(vs) && vs[0] ? vs[0] : null;
          const vBytes = v0 && typeof v0.bytesReceived === 'number' ? v0.bytesReceived : 0;
          if (vBytes > cam.monitor.lastVideoBytes) {
            cam.monitor.lastVideoBytes = vBytes;
            cam.monitor.lastVideoAliveAt = Date.now();
          }
        }
        if (cam.transports.audioPlain) {
          const as = await cam.transports.audioPlain.getStats().catch(() => []);
          const a0 = Array.isArray(as) && as[0] ? as[0] : null;
          const aBytes = a0 && typeof a0.bytesReceived === 'number' ? a0.bytesReceived : 0;
          if (aBytes > cam.monitor.lastAudioBytes) {
            cam.monitor.lastAudioBytes = aBytes;
            cam.monitor.lastAudioAliveAt = Date.now();
          }
        }

        const now = Date.now();

        if (cam.producers.video && now - cam.monitor.lastVideoAliveAt > INACTIVE_TIMEOUT_MS) {
          console.warn(`[LIVENESS] video inactive > ${INACTIVE_TIMEOUT_MS}ms cam=${cam.id}; closing video`);
          try { await cam.producers.video.close(); } catch {}
          cam.producers.video = null;
        }
        if (cam.producers.audio && now - cam.monitor.lastAudioAliveAt > INACTIVE_TIMEOUT_MS) {
          console.warn(`[LIVENESS] audio inactive > ${INACTIVE_TIMEOUT_MS}ms cam=${cam.id}; closing audio`);
          try { await cam.producers.audio.close(); } catch {}
          cam.producers.audio = null;
        }

        const bothDead =
          !cam.producers.video && !cam.producers.audio &&
          (now - cam.monitor.lastVideoAliveAt > DEAD_REMOVE_TIMEOUT_MS) &&
          (now - cam.monitor.lastAudioAliveAt > DEAD_REMOVE_TIMEOUT_MS);

        if (bothDead) {
          console.warn(`[LIVENESS] removing camera ${cam.id} after inactivity`);
          try { if (cam.transports.videoPlain) await cam.transports.videoPlain.close(); } catch {}
          try { if (cam.transports.audioPlain) await cam.transports.audioPlain.close(); } catch {}
          clearInterval(cam.monitor.timer);
          cam.monitor.timer = null;
          cameras.delete(cam.id);
          viewers.delete(cam.id);
        }
      } catch (e) {
        console.error('[LIVENESS] poll error', e);
      }
    }

    if (cam.monitor.timer) clearInterval(cam.monitor.timer);
    cam.monitor.timer = setInterval(poll, LIVENESS_CHECK_INTERVAL_MS);
  }

  // Viewers helpers
  function addViewer(camId, ip, consumerId) {
    if (!ip) return;
    let m = viewers.get(camId);
    if (!m) { m = new Map(); viewers.set(camId, m); }
    m.set(ip, (m.get(ip) || 0) + 1);
    consumerIndex.set(consumerId, { camId, ip });
  }
  function removeByConsumer(consumerId) {
    const rec = consumerIndex.get(consumerId);
    if (!rec) return;
    const m = viewers.get(rec.camId);
    if (m) {
      const cnt = (m.get(rec.ip) || 1) - 1;
      if (cnt <= 0) m.delete(rec.ip); else m.set(rec.ip, cnt);
      if (m.size === 0) viewers.delete(rec.camId);
    }
    consumerIndex.delete(consumerId);
  }
  function findCamByProducerId(pid) {
    for (const cam of cameras.values()) {
      if (cam.producers.video && cam.producers.video.id === pid) return cam;
      if (cam.producers.audio && cam.producers.audio.id === pid) return cam;
    }
    return null;
  }

  // ---- REST API ----
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/whoami', (req, res) => res.json({ ip: getIP(req), ua: req.get('user-agent') || '' }));

  app.get('/rtpCapabilities', (_req, res) => res.json(router.rtpCapabilities));

  app.post('/createWebRtcTransport', async (req, res) => {
    try {
      const transport = await router.createWebRtcTransport(WEBRTC_OPTS);

      webrtcTransports.set(transport.id, transport);

      transport.on('dtlsstatechange', (s) => console.log(`[WebRTC] ${transport.id} dtlsstate:`, s));
      transport.on('@close', () => {
        console.log(`[WebRTC] ${transport.id} closed`);
        webrtcTransports.delete(transport.id);  
      });

      res.json({
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      });
    } catch (e) {
      console.error('createWebRtcTransport error', e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/connectWebRtcTransport', async (req, res) => {
    try {
      const { transportId, dtlsParameters } = req.body || {};
      const transport = webrtcTransports.get(transportId);
      if (!transport) return res.status(404).json({ error: 'transport not found' });

      await transport.connect({ dtlsParameters });
      res.json({ connected: true });
    } catch (e) {
      console.error('connectWebRtcTransport error', e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/streams', (_req, res) => {
    const out = [];
    for (const cam of cameras.values()) {
      out.push({
        id: cam.id,
        name: cam.name,
        hasVideo: !!cam.producers.video,
        hasAudio: !!cam.producers.audio,
        viewerCount: viewers.get(cam.id)?.size || 0
      });
    }
    res.json(out);
  });

  app.post('/cameras/createPlainRtp', async (req, res) => {
    try {
      const { name } = req.body || {};
      const id = uuidv4();

      const common = {
        listenIp: { ip: LISTEN_IP, announcedIp: ANNOUNCED_IP },
        rtcpMux: false,
        comedia: true
      };

      const videoPlain = await router.createPlainTransport(common);
      const audioPlain = await router.createPlainTransport(common);

      const cam = {
        id,
        name: name || `camera-${id.slice(0, 8)}`,
        transports: { videoPlain, audioPlain },
        producers: { video: null, audio: null },
        monitor: null
      };
      cameras.set(id, cam);
      startMonitor(id);

      res.json({
        id,
        name: cam.name,
        video: {
          ip: videoPlain.tuple.localIp,
          rtpPort: videoPlain.tuple.localPort,
          rtcpPort: videoPlain.rtcpTuple.localPort,
          payloadType: DEFAULTS.videoPt,
          ssrc: DEFAULTS.videoSsrc
        },
        audio: {
          ip: audioPlain.tuple.localIp,
          rtpPort: audioPlain.tuple.localPort,
          rtcpPort: audioPlain.rtcpTuple.localPort,
          payloadType: DEFAULTS.audioPt,
          ssrc: DEFAULTS.audioSsrc
        }
      });
    } catch (e) {
      console.error('createPlainRtp error', e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/cameras/:id/produce', async (req, res) => {
    try {
      const cam = cameras.get(req.params.id);
      if (!cam) return res.status(404).json({ error: 'camera not found' });

      const {
        video = { payloadType: DEFAULTS.videoPt, ssrc: DEFAULTS.videoSsrc, profileLevelId: DEFAULTS.h264ProfileLevelId },
        audio = { payloadType: DEFAULTS.audioPt, ssrc: DEFAULTS.audioSsrc }
      } = req.body || {};

      if (!cam.producers.video) {
        cam.producers.video = await cam.transports.videoPlain.produce({
          kind: 'video',
          rtpParameters: {
            mid: '0',
            codecs: [{
              mimeType: 'video/H264',
              clockRate: 90000,
              payloadType: video.payloadType,
              parameters: {
                'packetization-mode': 1,
                'level-asymmetry-allowed': 1,
                'profile-level-id': video.profileLevelId || DEFAULTS.h264ProfileLevelId
              }
            }],
            encodings: [{ ssrc: video.ssrc }]
          }
        });
      }

      if (!cam.producers.audio && audio) {
        cam.producers.audio = await cam.transports.audioPlain.produce({
          kind: 'audio',
          rtpParameters: {
            mid: '1',
            codecs: [{
              mimeType: 'audio/opus',
              clockRate: 48000,
              channels: 2,
              payloadType: audio.payloadType
            }],
            encodings: [{ ssrc: audio.ssrc }]
          }
        });
      }

      res.json({
        id: cam.id,
        producers: {
          videoId: cam.producers.video?.id || null,
          audioId: cam.producers.audio?.id || null
        }
      });
    } catch (e) {
      console.error('produce error', e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/cameras/:id/producers', (req, res) => {
    const cam = cameras.get(req.params.id);
    if (!cam) return res.status(404).json({ error: 'camera not found' });
    res.json({
      videoProducerId: cam.producers.video?.id || null,
      audioProducerId: cam.producers.audio?.id || null
    });
  });

  app.get('/cameras/:id/viewers', (req, res) => {
    const map = viewers.get(req.params.id);
    const ips = map ? Array.from(map.keys()) : [];
    res.json({ count: ips.length, ips });
  });

  app.post('/consume', async (req, res) => {
    try {
      const { transportId, producerId, rtpCapabilities } = req.body || {};
      const transport = webrtcTransports.get(transportId);
      if (!transport) return res.status(404).json({ error: 'transport not found' });

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return res.status(400).json({ error: 'cannot consume' });
      }

      const consumer = await transport.consume({ producerId, rtpCapabilities, paused: false });

      debugConsumers.set(consumer.id, consumer);
      consumer.on('@close', () => { debugConsumers.delete(consumer.id); removeByConsumer(consumer.id); });
      consumer.on('transportclose', () => { removeByConsumer(consumer.id); });

      const cam = findCamByProducerId(producerId);
      const ip = getIP(req);
      if (cam && ip) addViewer(cam.id, ip, consumer.id);

      res.json({
        id: consumer.id,
        producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters
      });
    } catch (e) {
      console.error('consume error', e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/cameras/:id/close', async (req, res) => {
    const cam = cameras.get(req.params.id);
    if (!cam) return res.status(404).json({ error: 'camera not found' });
    try {
      if (cam.producers.video) await cam.producers.video.close();
      if (cam.producers.audio) await cam.producers.audio.close();
      if (cam.transports.videoPlain) await cam.transports.videoPlain.close();
      if (cam.transports.audioPlain) await cam.transports.audioPlain.close();
    } catch {}
    clearInterval(cam.monitor?.timer);
    cameras.delete(cam.id);
    viewers.delete(cam.id);
    res.json({ ok: true });
  });

  // ---- Chat APIs ----

  // Upload image or video
  app.post('/chat/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const url = `/uploads/${path.basename(req.file.path)}`;
    res.json({ url });
  });

  // Send message (server stamps IP)
  app.post('/chat/send', (req, res) => {
    try {
      const room = 'global'; // global only
      const text = (req.body.text || '').slice(0, 4000);
      const imageUrl = req.body.imageUrl ? String(req.body.imageUrl).slice(0, 1024) : null;
      const ip = getIP(req);
      const ts = Date.now();

      const info = insertMsg.run(ts, room, ip, text.trim() || null, imageUrl);
      const message = { id: Number(info.lastInsertRowid), ts, room, ip, text: text || null, imageUrl: imageUrl || null };

      trimMessages();
      publish(room, message);
      res.json({ ok: true, message });
    } catch (e) {
      console.error('chat/send error', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // Load history (pagination by beforeId)
  app.get('/chat/history', (req, res) => {
    try {
      const room = 'global';
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
      const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;
      const rows = getHistory.all(room, beforeId, limit);
      res.json({ messages: rows });
    } catch (e) {
      console.error('chat/history error', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // SSE stream realtime
  const chatSubs = new Set(); // global only
  function publish(_room, msg) {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of chatSubs) res.write(data);
  }

  app.get('/chat/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive'
    });
    res.flushHeaders?.();

    res.write(':ok\n\n');
    chatSubs.add(res);

    const ping = setInterval(() => res.write(':ping\n\n'), 15000);

    req.on('close', () => {
      clearInterval(ping);
      chatSubs.delete(res);
    });
  });

  // ---- Debug ----
  app.get('/debug/cameras', async (_req, res) => {
    const out = [];
    for (const cam of cameras.values()) {
      out.push({
        id: cam.id,
        name: cam.name,
        hasVideo: !!cam.producers.video,
        hasAudio: !!cam.producers.audio,
        viewerCount: viewers.get(cam.id)?.size || 0
      });
    }
    res.json(out);
  });

  app.get('/debug/consumers', (_req, res) => {
    res.json(Array.from(debugConsumers.keys()));
  });

  app.get('/debug/consumers/:id/stats', async (req, res) => {
    const c = debugConsumers.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'consumer not found' });
    const st = await c.getStats().catch(() => []);
    res.json(st);
  });

  app.listen(WEB_PORT, () => {
    console.log(`HTTP on :${WEB_PORT} (UI at /)`);
    console.log(`PlainRTP UDP range ${WORKER_RTC_MIN_PORT}-${WORKER_RTC_MAX_PORT}`);
    console.log(`Announced IP: ${ANNOUNCED_IP}`);
  });
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
