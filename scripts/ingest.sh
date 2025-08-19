#!/bin/bash
 
# === Config ===
ServerUrl="http://127.0.0.1:3000"
VideoBitrateKbps=6000
Fps=24
GopSeconds=1
VideoPT=96
AudioPT=97
VideoSSRC=222222
AudioSSRC=111111
ProfileLevelId="42e01f"
NoAudio=0 # 1 = no audio, 0 = with audio
 
# === Video list ===
VideoList=(
  "../test/le-luu-ly.mp4"
  "https://www.youtube.com/watch?v=yyhCLsO1wos"
  "https://www.youtube.com/watch?v=QTXgnZDQ9o4"
  "https://www.youtube.com/watch?v=qwQ21DlNiEM"
)
 
function Die() {
  echo "ERROR: \$1" >&2
  exit 1
}
 
for idx in "${!VideoList[@]}"; do
(
  VideoPath="${VideoList[$idx]}"
  CamName="Video-test-$((idx+1))"
  TmpVideoPath=""
  # To avoid SSRC collision, offset by index
  VideoSSRC=$((222222 + idx))
  AudioSSRC=$((111111 + idx))
 
  if [[ "$VideoPath" =~ ^https?://(www\.)?(youtube\.com|youtu\.be)/ ]]; then
    command -v yt-dlp >/dev/null 2>&1 || Die "yt-dlp is required!"
    echo "==> Getting YouTube video title..."
    VideoTitle=$(yt-dlp --get-title "$VideoPath")
    [ -z "$VideoTitle" ] && Die "Cannot get YouTube title: $VideoPath"
 
    SafeTitle=$(echo "$VideoTitle" | tr -cd '[:alnum:] _-' | tr ' ' '_' )
    TmpVideoPath="../test/${SafeTitle}.mp4"
 
    if [ -f "$TmpVideoPath" ]; then
      echo "==> Found existing video file: $TmpVideoPath"
    else
      echo "==> Downloading YouTube video as $TmpVideoPath ..."
      yt-dlp -f "bv*[height<=480]+ba" --merge-output-format mp4 "$VideoPath" -o "$TmpVideoPath"
      [ $? -ne 0 ] && Die "Cannot download YouTube video: $VideoPath"
      [ ! -f "$TmpVideoPath" ] && Die "Downloaded file not found: $TmpVideoPath"
    fi
    VideoPath="$TmpVideoPath"
  else
    [ -f "$VideoPath" ] || Die "Video file not found: $VideoPath"
  fi
 
  echo "==> Creating PlainRTP with camera name: $CamName ..."
  resp=$(curl -s -X POST "$ServerUrl/cameras/createPlainRtp" -H "Content-Type: application/json" \
    -d "{\"name\": \"$CamName\"}")
 
  if [ -z "$resp" ] || [ "$(echo "$resp" | jq -r '.id')" == "null" ]; then
    Die "Cannot call /cameras/createPlainRtp: $resp"
  fi
 
  camId=$(echo "$resp" | jq -r '.id')
  serverHost=$(echo "$ServerUrl" | sed -E 's~http[s]?://([^:/]+).*~\1~')
 
  videoRtpPort=$(echo "$resp" | jq -r '.video.rtpPort')
  videoRtcpPort=$(echo "$resp" | jq -r '.video.rtcpPort')
  audioRtpPort=$(echo "$resp" | jq -r '.audio.rtpPort')
  audioRtcpPort=$(echo "$resp" | jq -r '.audio.rtcpPort')
 
  echo "CAMERA_ID      : $camId"
  echo "VIDEO RTP/RTCP : $serverHost:$videoRtpPort / $serverHost:$videoRtcpPort"
  echo "AUDIO RTP/RTCP : $serverHost:$audioRtpPort / $serverHost:$audioRtcpPort"
 
  gop=$((Fps * GopSeconds))
 
  uriVideo="rtp://$serverHost:$videoRtpPort?rtcpport=$videoRtcpPort&pkt_size=1200&ssrc=$VideoSSRC&payload_type=$VideoPT"
  uriAudio="rtp://$serverHost:$audioRtpPort?rtcpport=$audioRtcpPort&pkt_size=1200&ssrc=$AudioSSRC&payload_type=$AudioPT"
 
  # ==== FFmpeg arguments ====
  ffArgs=(
    -re -stream_loop -1 -i "$VideoPath"
    -vf scale=1920:-2
    -map 0:v:0
    -c:v libx264
    -tune zerolatency
    -preset ultrafast
    -pix_fmt yuv420p
    -profile:v baseline
    -level:v 4.0
    -g "$gop"
    -x264-params "repeat-headers=1:keyint=${gop}:min-keyint=${gop}:scenecut=0"
    -b:v "${VideoBitrateKbps}k"
    -an -f rtp
    -ssrc "$VideoSSRC"
    "$uriVideo"
  )
 
  if [ "$NoAudio" -eq 0 ]; then
    ffArgs+=(
      -map 0:a:0
      -c:a libopus -b:a 64k
      -application lowdelay
      -frame_duration 20
      -payload_type "$AudioPT"
      -ssrc "$AudioSSRC"
      -vn -f rtp
      "$uriAudio"
    )
  fi
 
  echo "==> Starting FFmpeg..."
  ffmpeg "${ffArgs[@]}" &
  ff_pid=$!
 
  sleep 2
 
  echo "==> Calling /produce..."
 
  if [ "$NoAudio" -eq 0 ]; then
    bodyObj=$(jq -n \
      --argjson videoPT "$VideoPT" \
      --argjson videoSSRC "$VideoSSRC" \
      --arg profileLevelId "$ProfileLevelId" \
      --argjson audioPT "$AudioPT" \
      --argjson audioSSRC "$AudioSSRC" \
      '{
        video: {payloadType: $videoPT, ssrc: $videoSSRC, profileLevelId: $profileLevelId},
        audio: {payloadType: $audioPT, ssrc: $audioSSRC}
      }')
  else
    bodyObj=$(jq -n \
      --argjson videoPT "$VideoPT" \
      --argjson videoSSRC "$VideoSSRC" \
      --arg profileLevelId "$ProfileLevelId" \
      '{
        video: {payloadType: $videoPT, ssrc: $videoSSRC, profileLevelId: $profileLevelId}
      }')
  fi
 
  prodResp=$(curl -s -X POST "$ServerUrl/cameras/$camId/produce" \
    -H "Content-Type: application/json" \
    -d "$bodyObj")
 
  if [ -z "$prodResp" ] || [ "$(echo "$prodResp" | jq -r '.error')" != "null" ]; then
    echo "ERROR: Cannot call /produce: $prodResp" >&2
    kill $ff_pid 2>/dev/null
    exit 1
  fi
 
  echo "$prodResp" | jq
 
  echo ""
  echo "DONE. Streaming $VideoPath to '$CamName' (ID: $camId)."
  echo "Open $ServerUrl -> Refresh -> Play Selected."
  echo "Stop: Press Ctrl+C to stop ffmpeg and exit."
 
  wait $ff_pid
 
  echo "==> Finished streaming $VideoPath"
  echo "========================================"
) &
done
 
wait