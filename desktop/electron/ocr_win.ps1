param([string]$Path = "", [int]$Scale = 200, [int]$Left = 0, [int]$Top = 0, [int]$Width = 0, [int]$Height = 0, [int]$Pre = 1)
# Windows built-in OCR (Windows.Media.Ocr). No third-party deps.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ocr_win.ps1 -Path x.jpg [-Scale 200] [-Left L -Top T -Width W -Height H] [-Pre 1]
# Output: single-line UTF-8 JSON { ok, text, lines:[{text,x,y,w,h}], ms }
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Out-Json($obj) {
  # cleanup the preprocessed temp png (created by -Pre 1)
  try {
    if ($full -and ((Split-Path $full -Leaf) -like "ocrpre-*")) {
      Remove-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    }
  } catch { }
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  [Console]::Out.Write($json)
  exit 0
}

if (-not $Path -or -not (Test-Path -LiteralPath $Path)) {
  Out-Json @{ ok = $false; error = "image not found" }
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($op, $type) {
    $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $t.Wait(-1) | Out-Null
    $t.Result
  }

  [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

  $full = (Resolve-Path -LiteralPath $Path).Path

  # ---- preprocessing: auto-invert dark bubbles + grayscale + linear contrast stretch, save lossless PNG ----
  # Chat apps often use dark bubbles (white text on dark bg) that OCR reads poorly;
  # JPEG sources also blur small text. Preprocess fixes both, output is lossless PNG.
  $preInvert = $false; $preMs = 0; $preErr = ""
  if ($Pre -eq 1) {
    $psw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      Add-Type -AssemblyName System.Drawing | Out-Null
      $srcBmp = New-Object System.Drawing.Bitmap($full)
      # sample luminance on a sparse grid (~10k points) to find mean/min/max
      $min = 255.0; $max = 0.0; $sum = 0.0; $n = 0
      $step = [Math]::Max(1, [int]([Math]::Min($srcBmp.Width, $srcBmp.Height) / 100))
      for ($yy = 0; $yy -lt $srcBmp.Height; $yy += $step) {
        for ($xx = 0; $xx -lt $srcBmp.Width; $xx += $step) {
          $c = $srcBmp.GetPixel($xx, $yy)
          $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
          if ($lum -lt $min) { $min = $lum }
          if ($lum -gt $max) { $max = $lum }
          $sum += $lum; $n++
        }
      }
      $mean = $sum / [Math]::Max(1, $n)
      $preInvert = ($mean -lt 110)
      # linear stretch: new = (old - min) * 255 / (max - min); invert flips it
      $rng = [Math]::Max(40.0, $max - $min)
      $k = 255.0 / $rng
      $b = -($min * $k)
      if ($preInvert) { $diag = -($k); $off = (255.0 - $b) / 255.0 } else { $diag = $k; $off = $b / 255.0 }
      $cm = New-Object System.Drawing.Imaging.ColorMatrix
      $cm.Matrix00 = $diag; $cm.Matrix11 = $diag; $cm.Matrix22 = $diag; $cm.Matrix33 = 1.0
      $cm.Matrix40 = $off; $cm.Matrix41 = $off; $cm.Matrix42 = $off
      $ia = New-Object System.Drawing.Imaging.ImageAttributes
      $ia.SetColorMatrix($cm)
      $outBmp = New-Object System.Drawing.Bitmap($srcBmp.Width, $srcBmp.Height)
      $gfx = [System.Drawing.Graphics]::FromImage($outBmp)
      $rect = New-Object System.Drawing.Rectangle(0, 0, $srcBmp.Width, $srcBmp.Height)
      $gfx.DrawImage($srcBmp, $rect, 0, 0, $srcBmp.Width, $srcBmp.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
      $gfx.Dispose()
      $tmpPng = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($full), ("ocrpre-" + [System.IO.Path]::GetFileNameWithoutExtension($full) + ".png"))
      $outBmp.Save($tmpPng, [System.Drawing.Imaging.ImageFormat]::Png)
      $outBmp.Dispose(); $srcBmp.Dispose()
      $full = $tmpPng
      $psw.Stop(); $preMs = $psw.ElapsedMilliseconds
    } catch { $preInvert = $false; $preMs = -1; $preErr = $_.Exception.Message }  # preprocessing must never break OCR
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $iw = [int]$decoder.PixelWidth
  $ih = [int]$decoder.PixelHeight

  # crop to a region (e.g. the subtitle band) when requested
  $cx = 0; $cy = 0; $cw = $iw; $ch = $ih
  if ($Width -gt 0 -and $Height -gt 0) {
    $cx = [Math]::Max(0, [Math]::Min($Left, $iw - 1))
    $cy = [Math]::Max(0, [Math]::Min($Top, $ih - 1))
    $cw = [Math]::Min($Width, $iw - $cx)
    $ch = [Math]::Min($Height, $ih - $cy)
  }

  $tb = New-Object Windows.Graphics.Imaging.BitmapTransform
  $tb.Bounds = New-Object Windows.Graphics.Imaging.BitmapBounds
  $tb.Bounds.X = $cx; $tb.Bounds.Y = $cy
  $tb.Bounds.Width = $cw; $tb.Bounds.Height = $ch
  if ($Scale -gt 100) {
    $nw = [int]($cw * $Scale / 100); $nh = [int]($ch * $Scale / 100)
    if ($nw -le 6000 -and $nh -le 6000) {
      $tb.ScaledWidth = $nw; $tb.ScaledHeight = $nh
      $tb.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
    }
  }

  $bmp = Await ($decoder.GetSoftwareBitmapAsync(
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
      [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
      $tb,
      [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
      [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
    )) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language("zh-Hans-CN")))
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { Out-Json @{ ok = $false; error = "no ocr language pack" } }

  $result = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])

  $lines = @()
  foreach ($ln in $result.Lines) {
    $w = @($ln.Words)
    $x = 0; $y = 0; $ww = 0; $hh = 0
    if ($w.Count -gt 0) {
      $x = [int]$w[0].BoundingRect.X
      $y = [int]$w[0].BoundingRect.Y
      $last = $w[$w.Count - 1]
      $ww = [int]($last.BoundingRect.X + $last.BoundingRect.Width - $x)
      $hh = [int]$w[0].BoundingRect.Height
    }
    $lines += [pscustomobject]@{ text = $ln.Text; x = $x; y = $y; w = $ww; h = $hh }
  }
  $sw.Stop()
  Out-Json @{
    ok = $true; text = ($result.Text); lines = $lines; count = $lines.Count
    crop = @{ x = $cx; y = $cy; w = $cw; h = $ch }; scale = $Scale; ms = $sw.ElapsedMilliseconds
    pre = @{ invert = $preInvert; ms = $preMs; err = $preErr }
  }
}
catch {
  Out-Json @{ ok = $false; error = ($_.Exception.Message); ms = $sw.ElapsedMilliseconds }
}
