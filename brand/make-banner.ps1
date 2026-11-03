# Draws the Android TV banner (1280×720, the 320×180 dp banner at xxxhdpi): the FantasyTV symbol and wordmark, large
# and centred on navy, readable at tile size. Writes brand/FantasyTV-TV-Banner-1280x720.png and the app's banner.png.
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot
$W = 1280; $H = 720
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAliasGridFit'

# Navy, a little lighter in the middle.
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0B1428'))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(-200, -260, $W + 400, $H + 520)
$glow = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
$glow.CenterColor = [System.Drawing.ColorTranslator]::FromHtml('#15295A')
$glow.SurroundColors = @([System.Drawing.ColorTranslator]::FromHtml('#0B1428'))
$g.FillPath($glow, $path)

# The symbol, cropped to the TV shape (its artwork spans about x 110–914, y 160–872 of 1024).
$sym = [System.Drawing.Image]::FromFile("$root\brand\kit\FantasyTV-Symbol-Transparent-1024.png")
$src = New-Object System.Drawing.Rectangle 110, 160, 804, 712
$symH = 255; $symW = [int]($symH * 804 / 712)

# The wordmark: "Fantasy" white, "TV" cyan, heavy and big.
$fontName = @('Segoe UI Black', 'Arial Black', 'Segoe UI') | ? { (New-Object System.Drawing.FontFamily($_)).Name -eq $_ } | Select -First 1
$font = New-Object System.Drawing.Font($fontName, 128, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = [System.Drawing.StringFormat]::GenericTypographic
$wF = $g.MeasureString('Fantasy', $font, 2000, $fmt).Width
$wT = $g.MeasureString('TV', $font, 2000, $fmt).Width
$gap = 38
$total = $symW + $gap + $wF + 14 + $wT
$x = [int](($W - $total) / 2)
$y = [int](($H - $symH) / 2)
$g.DrawImage($sym, (New-Object System.Drawing.Rectangle $x, $y, $symW, $symH), $src, 'Pixel')
$textY = $H / 2 - $font.GetHeight($g) / 2 - 6
$g.DrawString('Fantasy', $font, [System.Drawing.Brushes]::White, ($x + $symW + $gap), $textY, $fmt)
$cyan = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#24C8F4'))
$g.DrawString('TV', $font, $cyan, ($x + $symW + $gap + $wF + 14), $textY, $fmt)

$out = "$root\brand\FantasyTV-TV-Banner-1280x720.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Copy-Item $out "$root\android\app\src\main\res\drawable-xxxhdpi\banner.png"
$g.Dispose(); $bmp.Dispose(); $sym.Dispose()
"banner written with font $fontName"
