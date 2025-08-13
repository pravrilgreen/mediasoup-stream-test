#!/usr/bin/env bash
set -euo pipefail

# ==== Defaults (override via flags) ====
SERVER_URL="http://127.0.0.1:3000"
CAM_NAME="MP4 Demo"
MP4_PATH="le-luu-ly.mp4"

VIDEO_BITRATE_KBPS=2500
FPS=25
GOP_SECONDS=1
VIDEO_PT=96
AUDIO_PT=97         # Opus PT must match server
VIDEO_SSRC=222222
AUDIO_SSRC=111111
PROFILE_LEVEL_ID="42e01f"
NO_AUDIO=0          # 1 = disable audio
AUDIO_BITRATE_BPS=64000

usage() {
  cat <<EOF
Usage: $0 [-s server_url] [-n name] [-m mp4_path]
          [-b video_kbps] [-f fps] [-g gop_seconds]
          [-V video_pt] [-A audio_pt] [-S video_ssrc] [-T audio_ssrc]
          [-L profile_level_id] [-x (disable audio)]
Example: $0 -s http://127.0.0.1:3000 -n "MP4 Demo" -m le-luu-ly.mp4
EOF
}

# ==== Parse flags ====
while getopts ":s:n:m:b:f:g:V:A:S:T:L:xh" opt; do
  case "$opt" in
    s) SERVER_URL="$OPTARG" ;;
    n) CAM_NAME="$OPTARG" ;;
    m) MP4_PATH="$OPTARG" ;;
    b) VIDEO_BITRATE_KBPS="$OPTARG" ;;
    f) FPS="$OPTARG" ;;
    g) GOP_SECONDS="$OPTARG" ;;
    V) VIDEO_PT="$OPTARG" ;;
    A) AUDIO_PT="$OPTARG" ;;
    S) VIDEO_SSRC="$OPTARG" ;;
    T) AUDIO_SSRC="$OPTARG" ;;
    L) PROFILE_LEVEL_ID="$OPTARG" ;;
    x) NO_AUDIO=1 ;;
    h) usage; exit 0 ;;
    \?) echo "Invalid option: -$OPTARG" >&2; usage; exit 1 ;;
  case esac
done

# ==== Dependencies & inputs ====
for cmd in curl jq gst-launch-1.0; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing command: $cmd"; exit 1; }
done
[ -f "$MP4_PATH" ] || { echo "MP4 not found: $MP4_PATH"; exit 1; }

GOP=$(( FPS * GOP_SECONDS ))

# Extract host from SERVER_URL
SERVER_HOST="$(echo "$SERVER_URL" | sed -E 's#^[a-zA-Z]+://##; s#/.*$##' | cut -d: -f1)"

echo "==> Creating PlainRTP..."
CREATE_JSON=$(curl -sS -X POST "$SERVER_URL/cameras/createPlainRtp" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$CAM_NAME\"}") || { echo "POST /cameras/createPlainRtp failed"; exit 1; }

CAM_ID=$(echo "$CREATE_JSON" | jq -r '.id')
VIDEO_RTP_PORT=$(echo "$CREATE_JSON" | jq -r '.video.rtpPort')
VIDEO_RTCP_PORT=$(echo "$CREATE_JSON" | jq -r '.video.rtcpPort')
AUDIO_RTP_PORT=$(echo "$CREATE_JSON" | jq -r '.audio.rtpPort')
AUDIO_RTCP_PORT=$(echo "$CREATE_JSON" | jq -r '.audio.rtcpPort')

echo "CAMERA_ID      : $CAM_ID"
echo "VIDEO RTP/RTCP : $SERVER_HOST:$VIDEO_RTP_PORT / $SERVER_HOST:$VIDEO_RTCP_PORT"
if [ "$NO_AUDIO" -eq 0 ]; then
  echo "AUDIO RTP/RTCP : $SERVER_HOST:$AUDIO_RTP_PORT / $SERVER_HOST:$AUDIO_RTCP_PORT"
else
  echo "AUDIO          : disabled"
fi

# ==== Build GStreamer pipeline ====
# Video path:
#   filesrc -> qtdemux -> decode -> scale/framerate ->
#   x264enc (baseline, zerolatency, fixed GOP, repeat headers) ->
#   h264parse -> rtph264pay (pt/ssrc) -> rtpbin -> UDP sinks (RTP/RTCP)
PIPE_VIDEO="
  filesrc location=\"$MP4_PATH\" !
  qtdemux name=demux

  demux.video_0 !
  queue !
  decodebin !
  videoconvert !
  videoscale !
  video/x-raw,framerate=${FPS}/1,width=1920 !
  x264enc tune=zerolatency speed-preset=ultrafast bitrate=$VIDEO_BITRATE_KBPS \
          key-int-max=$GOP byte-stream=true aud=true bframes=0 \
          option-string=\"scenecut=0:keyint=$GOP:min-keyint=$GOP:repeat-headers=1:ref=1\" !
  video/x-h264,profile=baseline,level=\"3.1\" !
  h264parse !
  rtph264pay pt=$VIDEO_PT ssrc=$VIDEO_SSRC config-interval=1 name=payv !
  rtpbin.send_rtp_sink_0

  rtpbin.send_rtp_src_0 !
  udpsink host=$SERVER_HOST port=$VIDEO_RTP_PORT

  rtpbin.send_rtcp_src_0 !
  udpsink host=$SERVER_HOST port=$VIDEO_RTCP_PORT

  udpsrc port=0 !
  rtpbin.recv_rtcp_sink_0
"

# Optional audio path (Opus @ 64 kbps, 20 ms)
PIPE_AUDIO=""
if [ "$NO_AUDIO" -eq 0 ]; then
  PIPE_AUDIO="
    demux.audio_0 !
    queue !
    decodebin !
    audioconvert !
    audioresample !
    audio/x-raw,rate=48000,channels=2 !
    opusenc bitrate=$AUDIO_BITRATE_BPS frame-size=20 hard-cbr=true !
    rtpopuspay pt=$AUDIO_PT ssrc=$AUDIO_SSRC name=paya !
    rtpbin.send_rtp_sink_1

    rtpbin.send_rtp_src_1 !
    udpsink host=$SERVER_HOST port=$AUDIO_RTP_PORT

    rtpbin.send_rtcp_src_1 !
    udpsink host=$SERVER_HOST port=$AUDIO_RTCP_PORT

    udpsrc port=0 !
    rtpbin.recv_rtcp_sink_1
  "
fi

GST_PIPELINE="rtpbin name=rtpbin $PIPE_VIDEO $PIPE_AUDIO"

run_once() {
  gst-launch-1.0 -e -v $GST_PIPELINE
}

echo "==> Starting GStreamer..."
(set -m; run_once &) ; GST_PID=$!

sleep 2

echo "==> Calling /produce..."
if [ "$NO_AUDIO" -eq 1 ]; then
  PRODUCE_BODY=$(jq -n \
    --argjson vpt "$VIDEO_PT" \
    --argjson vssrc "$VIDEO_SSRC" \
    --arg pli "$PROFILE_LEVEL_ID" \
    '{video: {payloadType: $vpt, ssrc: $vssrc, profileLevelId: $pli}}')
else
  PRODUCE_BODY=$(jq -n \
    --argjson vpt "$VIDEO_PT" \
    --argjson vssrc "$VIDEO_SSRC" \
    --arg pli "$PROFILE_LEVEL_ID" \
    --argjson apt "$AUDIO_PT" \
    --argjson assrc "$AUDIO_SSRC" \
    '{video: {payloadType: $vpt, ssrc: $vssrc, profileLevelId: $pli},
      audio: {payloadType: $apt, ssrc: $assrc}}')
fi

PROD_JSON=$(curl -sS -X POST "$SERVER_URL/cameras/$CAM_ID/produce" \
  -H "Content-Type: application/json" -d "$PRODUCE_BODY") || {
    kill "$GST_PID" 2>/dev/null || true
    echo "POST /produce failed"; exit 1;
  }

echo "$PROD_JSON" | jq .

echo
echo "DONE. Streaming $MP4_PATH to '$CAM_NAME' (ID: $CAM_ID)."
echo "Open $SERVER_URL -> Refresh -> Play Selected."
echo "Stop: Ctrl+C."

# Loop forever: when the file hits EOS, restart the pipeline
trap 'echo; echo "Stopping..."; kill $GST_PID 2>/dev/null || true; exit 0' INT TERM
wait $GST_PID || true
while true; do
  echo "==> Restarting GStreamer loop..."
  (set -m; run_once &) ; GST_PID=$!
  wait $GST_PID || true
done
