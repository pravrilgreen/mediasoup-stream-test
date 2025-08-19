# requires -Version 5.1
# Save as: ingest.ps1
# Run   : powershell -ExecutionPolicy Bypass -File .\ingest.ps1

# ==============================
# Config (EDIT HERE)
# ==============================
$ServerUrl = "http://127.0.0.1:3000"

# Video quality
$VideoBitrateKbps = 8000
$Fps = 30
$GopSeconds = 1
$ProfileLevelId = "42e01f"

# Payload type & SSRC
$VideoPT = 96
$AudioPT = 97
$BaseVideoSSRC = 222222
$BaseAudioSSRC = 111111

# Audio control: 1 = no audio, 0 = include audio
$NoAudio = 0  

# Video list
$VideoList = @(
  "../test/le-luu-ly.mp4",
  "https://www.youtube.com/watch?v=yyhCLsO1wos",
  "https://www.youtube.com/watch?v=QTXgnZDQ9o4",
  "https://www.youtube.com/watch?v=qwQ21DlNiEM"
)

# ==============================
# Helpers
# ==============================
function Die($msg) {
  Write-Error "ERROR: $msg"
  exit 1
}

function Get-SafeName([string]$name) {
  $safe = $name -replace '[^\w\.\- ]', ''
  $safe = $safe -replace ' +', ' '
  return ($safe -replace ' ', '_')
}

# Track ffmpeg PIDs globally for cleanup
$Global:FFmpegPids = [System.Collections.Concurrent.ConcurrentBag[int]]::new()

function Stop-MyFfmpeg {
  param(
    [Parameter(Mandatory = $true)][string]$ServerHost,
    [int[]]$PortsToMatch = @()
  )
  try {
    foreach ($pid in $Global:FFmpegPids) {
      try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch {}
    }
    $ffList = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^ffmpeg(\.exe)?$' }
    foreach ($p in $ffList) {
      $cl = $p.CommandLine
      if ($cl -and $cl -match [Regex]::Escape($ServerHost)) {
        if ($PortsToMatch.Count -eq 0 -or ($PortsToMatch | Where-Object { $cl -match "\b$_\b" })) {
          try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
        }
      }
    }
  }
  catch {}
}

# ==============================
# Preflight
# ==============================
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Die "ffmpeg is required in PATH." }
if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) { Write-Warning "yt-dlp not found. YouTube entries will fail."; }

$scriptRoot = (Resolve-Path ".").Path
$testDir = Join-Path $scriptRoot "..\test"
if (-not (Test-Path $testDir)) { New-Item -ItemType Directory -Path $testDir | Out-Null }

try {
  $uri = [System.Uri]$ServerUrl
  $serverHost = $uri.DnsSafeHost
}
catch {
  Die "Invalid ServerUrl: $ServerUrl"
}

$gop = [int]($Fps * $GopSeconds)

# Register exit handler
Unregister-Event -SourceIdentifier PowerShell.Exiting -ErrorAction SilentlyContinue | Out-Null
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
  try { Stop-MyFfmpeg -ServerHost $using:serverHost } catch {}
} | Out-Null

# ==============================
# Main Loop
# ==============================
for ($idx = 0; $idx -lt $VideoList.Count; $idx++) {
  $VideoPath = $VideoList[$idx]
  $CamName = "Video-test-$($idx + 1)"
  $VideoSSRC = $BaseVideoSSRC + $idx
  $AudioSSRC = $BaseAudioSSRC + $idx

  try {
    # --- Download YouTube if needed ---
    if ($VideoPath -match '^https?://(www\.)?(youtube\.com|youtu\.be)/') {
      if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
        Write-Warning "Skipping $VideoPath (yt-dlp not installed)."
        continue
      }
      Write-Host "==> Getting YouTube metadata for $VideoPath ..."
      $fmt = "bv*[height=480]+ba/bv*[height=360]+ba/b[height<=480]"
      $print = yt-dlp --print "%(title)s|%(height)s" -f $fmt "$VideoPath" 2>$null
      if (-not $print) {
        Write-Warning "Skipping $VideoPath (metadata not available)."
        continue
      }
      $parts = $print -split '\|'
      $ytTitle = $parts[0]
      $ytHeight = if ($parts.Count -ge 2 -and $parts[1]) { $parts[1] } else { "unknown" }
      $safeTitle = Get-SafeName $ytTitle
      $fileName = "youtube_video_{0}-{1}p.mp4" -f $safeTitle, $ytHeight
      $TmpVideoPath = Join-Path $testDir $fileName
      if (-not (Test-Path $TmpVideoPath)) {
        Write-Host "==> Downloading YouTube video to $TmpVideoPath ..."
        yt-dlp -f $fmt --merge-output-format mp4 -o $TmpVideoPath "$VideoPath"
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $TmpVideoPath)) {
          Write-Warning "Skipping $VideoPath (download failed)."
          continue
        }
      }
      else {
        Write-Host "==> Found existing video file: $TmpVideoPath"
      }
      $VideoPath = $TmpVideoPath
    }
    else {
      if (-not (Test-Path $VideoPath)) {
        Write-Warning "Skipping $VideoPath (file not found)."
        continue
      }
    }

    # --- Create PlainRTP ---
    Write-Host "==> Creating PlainRTP for $CamName ..."
    $resp = Invoke-RestMethod -Method Post -Uri "$ServerUrl/cameras/createPlainRtp" -ContentType "application/json" -Body (@{ name = $CamName } | ConvertTo-Json)
    if (-not $resp -or -not $resp.id -or -not $resp.video -or -not $resp.audio) {
      Write-Warning "Skipping $CamName (bad API response)."
      continue
    }

    $camId = $resp.id
    $videoRtpPort = $resp.video.rtpPort
    $videoRtcpPort = $resp.video.rtcpPort
    $audioRtpPort = $resp.audio.rtpPort
    $audioRtcpPort = $resp.audio.rtcpPort

    Write-Host ("CAMERA_ID      : {0}" -f $camId)
    Write-Host ("VIDEO RTP/RTCP : {0}:{1} / {0}:{2}" -f $serverHost, $videoRtpPort, $videoRtcpPort)
    Write-Host ("AUDIO RTP/RTCP : {0}:{1} / {0}:{2}" -f $serverHost, $audioRtpPort, $audioRtcpPort)

    $uriVideo = "rtp://${serverHost}:${videoRtpPort}?rtcpport=${videoRtcpPort}`&pkt_size=1200`&ssrc=${VideoSSRC}`&payload_type=${VideoPT}"
    $uriAudio = "rtp://${serverHost}:${audioRtpPort}?rtcpport=${audioRtcpPort}`&pkt_size=1200`&ssrc=${AudioSSRC}`&payload_type=${AudioPT}"

    # --- FFmpeg Args ---
    $ffArgs = @(
      "-hide_banner",
      "-loglevel", "warning",
      "-nostats",
      "-re", "-stream_loop", "-1", "-i", $VideoPath,
      "-vf", "scale=1920:-2",
      "-map", "0:v:0",
      "-c:v", "libx264",
      "-tune", "zerolatency",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-profile:v", "baseline",
      "-level:v", "4.0",
      "-g", "$gop",
      "-x264-params", "repeat-headers=1:keyint=$($gop):min-keyint=$($gop):scenecut=0",
      "-b:v", "${VideoBitrateKbps}k",
      "-an", "-f", "rtp",
      "-ssrc", "$VideoSSRC",
      $uriVideo
    )
    if ($NoAudio -eq 0) {
      $ffArgs += @(
        "-map", "0:a:0?",
        "-c:a", "libopus", "-b:a", "64k",
        "-application", "lowdelay",
        "-frame_duration", "20",
        "-payload_type", "$AudioPT",
        "-ssrc", "$AudioSSRC",
        "-vn", "-f", "rtp",
        $uriAudio
      )
    }

    # --- Start FFmpeg ---
    Write-Host "==> Starting FFmpeg for $CamName ..."
    $ffProc = Start-Process -FilePath "ffmpeg" -ArgumentList $ffArgs -NoNewWindow -PassThru
    if ($ffProc -and $ffProc.Id) { [void]$Global:FFmpegPids.Add($ffProc.Id) }

    Start-Sleep -Seconds 2
    if ($ffProc.HasExited) {
      Write-Warning "FFmpeg exited immediately for $CamName."
      continue
    }

    # --- Call /produce ---
    Write-Host "==> Calling /produce ..."
    if ($NoAudio -eq 0) {
      $bodyObj = @{
        video = @{
          payloadType    = [int]$VideoPT
          ssrc           = [int]$VideoSSRC
          profileLevelId = $ProfileLevelId
        }
        audio = @{
          payloadType = [int]$AudioPT
          ssrc        = [int]$AudioSSRC
        }
      }
    }
    else {
      $bodyObj = @{
        video = @{
          payloadType    = [int]$VideoPT
          ssrc           = [int]$VideoSSRC
          profileLevelId = $ProfileLevelId
        }
      }
    }

    $prodResp = Invoke-RestMethod -Method Post -Uri "$ServerUrl/cameras/$camId/produce" -ContentType "application/json" -Body ($bodyObj | ConvertTo-Json -Depth 5)
    if ($prodResp.error) {
      Write-Warning "Produce failed for ${CamName}: $($prodResp | ConvertTo-Json -Depth 5)"
      continue
    }

    $prodResp | ConvertTo-Json -Depth 8 | Write-Host
    Write-Host "DONE. Streaming $VideoPath to '$CamName' (ID: $camId)."
    Write-Host "Open $ServerUrl -> Refresh -> Play Selected."
    Write-Host "========================================"

  }
  catch {
    Write-Warning "Skipping $CamName due to error: $_"
    continue
  }
}

Write-Host "All videos started."
Write-Host "Press Ctrl+C to stop all ffmpeg processes."

while ($true) {
  Start-Sleep -Seconds 1
}
