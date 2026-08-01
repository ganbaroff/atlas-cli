# Atlas screen_capture helper (Phase 3, READ-ONLY). ASCII-only.
# Captures PRIMARY display to PNG (+ optional JPEG thumb). Paths via env.
# Invoked by screen-capture.ts via -EncodedCommand (Windows AMSI blocks -File).
$ErrorActionPreference = 'Stop'
$OutPng = $env:ATLAS_CAP_OUT
$OutThumb = $env:ATLAS_CAP_THUMB
$ThumbW = 1024
if (-not $OutPng) { throw 'ATLAS_CAP_OUT required' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()
$dir = Split-Path -Parent $OutPng
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
if ($OutThumb) {
  $ratio = [Math]::Min(1.0, $ThumbW / $screen.Width)
  $tw = [int]($screen.Width * $ratio)
  $th = [int]($screen.Height * $ratio)
  $scaled = New-Object System.Drawing.Bitmap $tw, $th
  $gs = [System.Drawing.Graphics]::FromImage($scaled)
  $gs.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gs.DrawImage($bmp, 0, 0, $tw, $th)
  $gs.Dispose()
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]60)
  $scaled.Save($OutThumb, $enc, $ep)
  $scaled.Dispose()
}
$bmp.Dispose()
@{ width = $screen.Width; height = $screen.Height } | ConvertTo-Json -Compress
