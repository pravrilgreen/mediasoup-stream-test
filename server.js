// Minimal mediasoup forwarder (CommonJS)
// PlainRTP ingest from FFmpeg -> WebRTC to browser (audio + video),
// với logging, liveness monitor, và auto-remove dead cameras.

const express = require('express');
const cors = require('cors');
const mediasoup = require('mediasoup');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const debugConsumers = new Map();

// -------- Config (local single-machine defaults) --------
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

// Payload types & SSRC defaults (khớp FFmpeg script: video PT=96, audio PT=97)
const DEFAULTS = {
  videoPt: 96,
  audioPt: 97,
  videoSsrc: 222222,
  audioSsrc: 111111,
  h264ProfileLevelId: '42e01f'
};

// Liveness monitor
const LIVENESS_CHECK_INTERVAL_MS = 5000;
const INACTIVE_TIMEOUT_MS = 5000;
const DEAD_REMOVE_TIMEOUT_MS = 3000;

async function main() {
  const app = express();

  // Basic HTTP logging
  app.use((req, _res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url}`);
    next();
  });

  app.use(cors());
  app.use(express.json());
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

  const router = await worker.createRouter({ mediaCodecs: ROUTER_CODECS });
  console.log('[MS] Router created with codecs');

  // State
  const webrtcTransports = new Map(); // id -> WebRTC RecvTransport
  const cameras = new Map();          // id -> { name, transports, producers, monitor }

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
        // video stats
        if (cam.transports.videoPlain) {
          const vs = await cam.transports.videoPlain.getStats().catch(() => []);
          const v0 = Array.isArray(vs) && vs[0] ? vs[0] : null;
          const vBytes = v0 && typeof v0.bytesReceived === 'number' ? v0.bytesReceived : 0;
          if (vBytes > cam.monitor.lastVideoBytes) {
            cam.monitor.lastVideoBytes = vBytes;
            cam.monitor.lastVideoAliveAt = Date.now();
          }
        }
        // audio stats
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

        // close producers when inactive
        if (cam.producers.video && now - cam.monitor.lastVideoAliveAt > INACTIVE_TIMEOUT_MS) {
          console.warn(`[LIVENESS] video inactive > ${INACTIVE_TIMEOUT_MS}ms on cam ${cam.id}; closing video producer`);
          try { await cam.producers.video.close(); } catch {}
          cam.producers.video = null;
        }
        if (cam.producers.audio && now - cam.monitor.lastAudioAliveAt > INACTIVE_TIMEOUT_MS) {
          console.warn(`[LIVENESS] audio inactive > ${INACTIVE_TIMEOUT_MS}ms on cam ${cam.id}; closing audio producer`);
          try { await cam.producers.audio.close(); } catch {}
          cam.producers.audio = null;
        }

        // auto-remove camera if both tracks dead for long enough
        const bothDead =
          !cam.producers.video && !cam.producers.audio &&
          (now - cam.monitor.lastVideoAliveAt > DEAD_REMOVE_TIMEOUT_MS) &&
          (now - cam.monitor.lastAudioAliveAt > DEAD_REMOVE_TIMEOUT_MS);

        if (bothDead) {
          console.warn(`[LIVENESS] removing camera ${cam.id} after ${DEAD_REMOVE_TIMEOUT_MS}ms inactivity`);
          try { if (cam.transports.videoPlain) await cam.transports.videoPlain.close(); } catch {}
          try { if (cam.transports.audioPlain) await cam.transports.audioPlain.close(); } catch {}
          stopMonitor(cam.id);
          cameras.delete(cam.id);
        }
      } catch (e) {
        console.error('[LIVENESS] poll error', e);
      }
    }

    if (cam.monitor.timer) clearInterval(cam.monitor.timer);
    cam.monitor.timer = setInterval(poll, LIVENESS_CHECK_INTERVAL_MS);
    console.log(`[LIVENESS] monitor started for cam ${camId}`);
  }

  function stopMonitor(camId) {
    const cam = cameras.get(camId);
    if (!cam || !cam.monitor) return;
    clearInterval(cam.monitor.timer);
    cam.monitor.timer = null;
    console.log(`[LIVENESS] monitor stopped for cam ${camId}`);
  }

  // ---- REST API ----
  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/rtpCapabilities', (_req, res) => {
    console.log('[API] GET /rtpCapabilities');
    res.json(router.rtpCapabilities);
  });

  app.post('/createWebRtcTransport', async (_req, res) => {
    try {
      const transport = await router.createWebRtcTransport(WEBRTC_OPTS);
      webrtcTransports.set(transport.id, transport);

      console.log('[API] POST /createWebRtcTransport ->', transport.id);
      transport.on('dtlsstatechange', (s) => console.log(`[WebRTC] ${transport.id} dtlsstate:`, s));
      transport.on('@close', () => console.log(`[WebRTC] ${transport.id} closed`));

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
      console.log('[API] POST /connectWebRtcTransport -> connected', transportId);
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
        hasAudio: !!cam.producers.audio
      });
    }
    console.log('[API] GET /streams ->', out.length);
    res.json(out);
  });

  app.post('/cameras/createPlainRtp', async (req, res) => {
    try {
      const { name } = req.body || {};
      const id = uuidv4();

      const common = {
        listenIp: { ip: LISTEN_IP, announcedIp: ANNOUNCED_IP },
        rtcpMux: false,
        comedia: true // passive; learn remote tuple from first RTP
      };

      const videoPlain = await router.createPlainTransport(common);
      const audioPlain = await router.createPlainTransport(common);

      videoPlain.on('tuple', (t) => console.log(`[Plain] video tuple cam=${id}`, t));
      audioPlain.on('tuple', (t) => console.log(`[Plain] audio tuple cam=${id}`, t));

      const cam = {
        id,
        name: name || `camera-${id.slice(0, 8)}`,
        transports: { videoPlain, audioPlain },
        producers: { video: null, audio: null },
        monitor: null
      };
      cameras.set(id, cam);
      startMonitor(id);

      console.log('[API] POST /cameras/createPlainRtp ->', id, cam.name);

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
        console.log(`[PRODUCE] video producer created cam=${cam.id} pid=${cam.producers.video.id}`);
        console.log('[DEBUG] video producer RTP params:',
          JSON.stringify(cam.producers.video.rtpParameters, null, 2));
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
        console.log(`[PRODUCE] audio producer created cam=${cam.id} pid=${cam.producers.audio.id}`);
        console.log('[DEBUG] audio producer RTP params:',
          JSON.stringify(cam.producers.audio.rtpParameters, null, 2));
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
    const out = {
      videoProducerId: cam.producers.video?.id || null,
      audioProducerId: cam.producers.audio?.id || null
    };
    console.log('[API] GET /cameras/:id/producers ->', cam.id, out);
    res.json(out);
  });

  app.post('/consume', async (req, res) => {
    try {
      const { transportId, producerId, rtpCapabilities } = req.body || {};
      const transport = webrtcTransports.get(transportId);
      if (!transport) return res.status(404).json({ error: 'transport not found' });

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        console.warn('[CONSUME] cannot consume', {
          producerId, codecs: rtpCapabilities?.codecs?.map(c => c.mimeType)
        });
        return res.status(400).json({ error: 'cannot consume' });
      }

      const consumer = await transport.consume({
        producerId,
        rtpCapabilities,
        paused: false
      });

      debugConsumers.set(consumer.id, consumer);
      consumer.on('@close', () => debugConsumers.delete(consumer.id));

      const ssrcs = (consumer.rtpParameters.encodings || []).map(e => e.ssrc).filter(Boolean);
      const codec = consumer.rtpParameters.codecs?.[0]?.mimeType || 'unknown';
      console.log(`[CONSUME] t=${transportId} kind=${consumer.kind} codec=${codec} ssrc=${ssrcs.join(',')}`);
      console.log('[DEBUG] consumer RTP params:',
        JSON.stringify(consumer.rtpParameters, null, 2));

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


  // Manual cleanup (optional)
  app.post('/cameras/:id/close', async (req, res) => {
    const cam = cameras.get(req.params.id);
    if (!cam) return res.status(404).json({ error: 'camera not found' });
    try {
      if (cam.producers.video) await cam.producers.video.close();
      if (cam.producers.audio) await cam.producers.audio.close();
      if (cam.transports.videoPlain) await cam.transports.videoPlain.close();
      if (cam.transports.audioPlain) await cam.transports.audioPlain.close();
    } catch {}
    stopMonitor(cam.id);
    cameras.delete(cam.id);
    console.log('[CLOSE] camera removed', req.params.id);
    res.json({ ok: true });
  });

  // ---- Debug endpoints ----
  app.get('/debug/cameras', async (_req, res) => {
    const out = [];
    for (const cam of cameras.values()) {
      out.push({
        id: cam.id,
        name: cam.name,
        hasVideo: !!cam.producers.video,
        hasAudio: !!cam.producers.audio
      });
    }
    res.json(out);
  });

  app.get('/debug/cameras/:id/stats', async (req, res) => {
    const cam = cameras.get(req.params.id);
    if (!cam) return res.status(404).json({ error: 'camera not found' });

    const vStats = await cam.transports.videoPlain.getStats().catch(() => []);
    const aStats = await cam.transports.audioPlain.getStats().catch(() => []);
    const v = Array.isArray(vStats) && vStats[0] ? vStats[0] : {};
    const a = Array.isArray(aStats) && aStats[0] ? aStats[0] : {};

    res.json({
      id: cam.id,
      name: cam.name,
      videoPlain: {
        bytesReceived: v.bytesReceived ?? null,
        packetsReceived: v.packetsReceived ?? null,
        tuple: cam.transports.videoPlain?.tuple ?? null
      },
      audioPlain: {
        bytesReceived: a.bytesReceived ?? null,
        packetsReceived: a.packetsReceived ?? null,
        tuple: cam.transports.audioPlain?.tuple ?? null
      },
      producers: {
        video: cam.producers.video ? cam.producers.video.id : null,
        audio: cam.producers.audio ? cam.producers.audio.id : null
      }
    });
  });

  app.get('/debug/webrtc/:id/stats', async (req, res) => {
    const t = webrtcTransports.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'transport not found' });
    const st = await t.getStats().catch(() => []);
    res.json(st);
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
