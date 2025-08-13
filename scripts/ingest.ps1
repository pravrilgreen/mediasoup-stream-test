param(
  [string]$ServerUrl = "http://127.0.0.1:3000",
  [string]$CamName   = "MP4 Demo",
  [string]$Mp4Path   = "le-luu-ly.mp4",
  [int]$VideoBitrateKbps = 2500,
  [int]$Fps = 25,
  [int]$GopSeconds = 1,
  [int]$VideoPT = 96,
  [int]$AudioPT = 97,    # Opus PT = 97 to match server
  [int]$VideoSSRC = 222222,
  [int]$AudioSSRC = 111111,
  [string]$ProfileLevelId = "42e01f",
  [switch]$NoAudio
)

function Die($msg) { Write-Error $msg; exit 1 }

Write-Host "==> Creating PlainRTP..."
try {
  $resp = Invoke-RestMethod -Method Post -Uri "$ServerUrl/cameras/createPlainRtp" -ContentType "application/json" -Body (@{ name = $CamName } | ConvertTo-Json)
} catch {
  Die "Cannot call /cameras/createPlainRtp : $($_.Exception.Message)"
}

$camId = $resp.id
$serverHost = ([Uri]$ServerUrl).Host

$videoRtpPort  = $resp.video.rtpPort
$videoRtcpPort = $resp.video.rtcpPort
$audioRtpPort  = $resp.audio.rtpPort
$audioRtcpPort = $resp.audio.rtcpPort

Write-Host ("CAMERA_ID      : {0}" -f $camId)
Write-Host ("VIDEO RTP/RTCP : {0}:{1} / {0}:{2}" -f $serverHost, $videoRtpPort, $videoRtcpPort)
Write-Host ("AUDIO RTP/RTCP : {0}:{1} / {0}:{2}" -f $serverHost, $audioRtpPort, $audioRtcpPort)

if (-not (Test-Path $Mp4Path)) { Die ("MP4 not found: {0}" -f $Mp4Path) }

$gop = $Fps * $GopSeconds

# Build RTP URLs using format strings
$uriVideo = "rtp://{0}:{1}?rtcpport={2}&pkt_size=1200&ssrc={3}&payload_type={4}" -f $serverHost, $videoRtpPort, $videoRtcpPort, $VideoSSRC, $VideoPT
$uriAudio = "rtp://{0}:{1}?rtcpport={2}&pkt_size=1200&ssrc={3}&payload_type={4}" -f $serverHost, $audioRtpPort, $audioRtcpPort, $AudioSSRC, $AudioPT

# FFmpeg:
# - realtime (-re), infinite loop (-stream_loop -1)
# - scale to 1280 width để nhẹ (bỏ -vf nếu muốn kích thước gốc)
# - H264 baseline + zerolatency, short GOP, repeat headers on IDR, level 3.1
$ffArgs = @(
  "-re", "-stream_loop", "-1", "-i", "`"$Mp4Path`"",
  "-vf", "scale=1920:-2",
  "-map", "0:v:0",
  "-c:v", "libx264",
  "-tune", "zerolatency",
  "-preset", "ultrafast",
  "-pix_fmt", "yuv420p",
  "-profile:v", "baseline",
  "-level:v", "3.1",
  "-g", "$gop",
  "-x264-params", ("repeat-headers=1:keyint={0}:min-keyint={0}:scenecut=0" -f $gop),
  "-b:v", ("{0}k" -f $VideoBitrateKbps),
  #"-crf", "18"
  "-an", "-f", "rtp",
  "-ssrc", "$VideoSSRC",
  $uriVideo
)

if (-not $NoAudio) {
  $ffArgs += @(
    "-map", "0:a:0",
    "-c:a", "libopus", "-b:a", "64k",
    #"-c:a", "libopus", "-b:a", "192k",
    "-application", "lowdelay",
    "-frame_duration", "20",
    "-payload_type", "$AudioPT",
    "-ssrc", "$AudioSSRC",
    "-vn", "-f", "rtp",
    $uriAudio
  )
}

Write-Host "==> Starting FFmpeg..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "ffmpeg"
$psi.Arguments = ($ffArgs -join " ")
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError = $false
$psi.UseShellExecute = $true
$proc = [System.Diagnostics.Process]::Start($psi)

Start-Sleep -Seconds 2

Write-Host "==> Calling /produce..."
$bodyObj = @{
  video = @{ payloadType = $VideoPT; ssrc = $VideoSSRC; profileLevelId = $ProfileLevelId }
  audio = @{ payloadType = $AudioPT; ssrc = $AudioSSRC }
}
if ($NoAudio) { $bodyObj.Remove('audio') | Out-Null }

try {
  $prodResp = Invoke-RestMethod -Method Post -Uri "$ServerUrl/cameras/$camId/produce" -ContentType "application/json" -Body ($bodyObj | ConvertTo-Json)
} catch {
  try { $proc.Kill() } catch {}
  Die "Cannot call /produce : $($_.Exception.Message)"
}

$prodResp | ConvertTo-Json -Depth 5 | Write-Host

Write-Host ""
Write-Host ("DONE. Playing {0} to '{1}' (ID: {2})." -f $Mp4Path, $CamName, $camId)
Write-Host ("Open {0} -> Refresh -> Play Selected." -f $ServerUrl)
Write-Host "Stop: close FFmpeg window or stop this script."
