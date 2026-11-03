# Builds every icon and logo from the two source images in brand/:
#   FantasyTV-Icon-src.png  the square FTV icon (red border; its black fill becomes the theme navy)
#   FantasyTV-Logo-src.png  the FantasyTV logo on dark navy, 16:9 (the TV banner as is; cut out for the wordmark)
# Writes the Android launcher icons and TV banner, the TV/phone icons and wordmark (web/img), the website's (site/img),
# and brand/FantasyTV-Icon-2026.png, FantasyTV-Wordmark-2026.png, FantasyTV-TV-Banner-1280x720.png.
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging;
public static class Ftv {
  // The artwork's box: everything that isn't (nearly) transparent.
  public static Rectangle Trim(Bitmap b) {
    int minX = b.Width, minY = b.Height, maxX = -1, maxY = -1;
    for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++)
      if (b.GetPixel(x, y).A > 24) { minX = Math.Min(minX, x); maxX = Math.Max(maxX, x); minY = Math.Min(minY, y); maxY = Math.Max(maxY, y); }
    return Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
  }
  // Black turned into the theme's navy, keeping the edges smooth: each pixel gets navy in proportion to how dark it is.
  public static void Navy(Bitmap b, Color navy) {
    for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++) {
      Color c = b.GetPixel(x, y); if (c.A == 0) continue;
      double k = 1 - Math.Max(c.R, Math.Max(c.G, c.B)) / 255.0;
      b.SetPixel(x, y, Color.FromArgb(c.A, Math.Min(255, (int)(c.R + navy.R * k)), Math.Min(255, (int)(c.G + navy.G * k)), Math.Min(255, (int)(c.B + navy.B * k))));
    }
  }
  // The dark navy background taken out (the letters are bright red and white): how bright a pixel is decides how
  // see-through it is, and its colour is un-blended from the navy so the edges stay smooth on any background.
  public static Bitmap Cutout(Bitmap src, Color bg, int lo, int hi) {
    var b = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
    for (int y = 0; y < src.Height; y++) for (int x = 0; x < src.Width; x++) {
      Color c = src.GetPixel(x, y);
      double a = Math.Min(1.0, Math.Max(0, Math.Max(c.R, Math.Max(c.G, c.B)) - lo) / (double)(hi - lo));
      if (a <= 0) continue;
      Func<int, int, int> un = (v, k) => Math.Max(0, Math.Min(255, (int)Math.Round(k + (v - k) / a)));
      b.SetPixel(x, y, Color.FromArgb((int)(a * 255), un(c.R, bg.R), un(c.G, bg.G), un(c.B, bg.B)));
    }
    return b;
  }
  // The artwork scaled to fit wÃ—h (less pad on each side, as a share of the shorter side), centred, on bg.
  public static Bitmap Fit(Bitmap src, Rectangle box, int w, int h, float pad, Color bg) {
    var o = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(o)) using (var ia = new ImageAttributes()) {
      g.SmoothingMode = SmoothingMode.AntiAlias; g.InterpolationMode = InterpolationMode.HighQualityBicubic;
      g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.CompositingQuality = CompositingQuality.HighQuality;
      g.Clear(bg); ia.SetWrapMode(WrapMode.TileFlipXY);
      float p = Math.Min(w, h) * pad, s = Math.Min((w - 2 * p) / box.Width, (h - 2 * p) / box.Height);
      int dw = (int)Math.Round(box.Width * s), dh = (int)Math.Round(box.Height * s);
      g.DrawImage(src, new Rectangle((w - dw) / 2, (h - dh) / 2, dw, dh), box.X, box.Y, box.Width, box.Height, GraphicsUnit.Pixel, ia);
    }
    return o;
  }
}
'@

$root = Split-Path $PSScriptRoot
$res = "$root\android\app\src\main\res"
$clear = [System.Drawing.Color]::Transparent
$navy = [System.Drawing.ColorTranslator]::FromHtml("#021E42")   # the app's navy (web/css/app.css)
function Save($bmp, [string[]]$paths) { foreach ($p in $paths) { $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png) }; $bmp.Dispose() }

# Square icon: navy instead of black, the artwork edge to edge (its own rounded corners stay transparent)
$sq = New-Object System.Drawing.Bitmap "$PSScriptRoot\FantasyTV-Icon-src.png"
[Ftv]::Navy($sq, $navy)
$box = [Ftv]::Trim($sq)
$icon = { param($n) [Ftv]::Fit($sq, $box, $n, $n, 0.01, $clear) }
Save (& $icon 1024) "$PSScriptRoot\FantasyTV-Icon-2026.png"
@{ mdpi = 48; hdpi = 72; xhdpi = 96; xxhdpi = 144; xxxhdpi = 192 }.GetEnumerator() | % {
  Save (& $icon $_.Value) "$res\mipmap-$($_.Key)\ic_launcher.png" }
Save (& $icon 256) "$root\web\img\icon.png"
Save (& $icon 192) "$root\web\img\icon-192.png", "$root\site\img\icon-192.png"
Save (& $icon 32) "$root\web\img\icon-32.png", "$root\site\img\icon-32.png"
# favicon.ico: one 32 px PNG inside an ICO header
$png = [IO.File]::ReadAllBytes("$root\web\img\icon-32.png")
$ico = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter $ico
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
$w.Write([byte]32); $w.Write([byte]32); $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
$w.Write([uint32]$png.Length); $w.Write([uint32]22); $w.Write($png); $w.Flush()
[IO.File]::WriteAllBytes("$root\web\favicon.ico", $ico.ToArray())
$sq.Dispose()

# The logo (16:9, on dark navy): as it is, it's the Android TV banner (the 320×180 dp tile on the home screen); cut out
# of its background, trimmed and 1400 wide, it's the wordmark for the TV screens, the phone and the website.
$lg = New-Object System.Drawing.Bitmap "$PSScriptRoot\FantasyTV-Logo-src.png"
$all = New-Object System.Drawing.Rectangle 0, 0, $lg.Width, $lg.Height
Save ([Ftv]::Fit($lg, $all, 1280, 720, 0, $navy)) "$PSScriptRoot\FantasyTV-TV-Banner-1280x720.png", "$res\drawable-xxxhdpi\banner.png"
Save ([Ftv]::Fit($lg, $all, 640, 360, 0, $navy)) "$res\drawable-xhdpi\banner.png"
Save ([Ftv]::Fit($lg, $all, 320, 180, 0, $navy)) "$res\drawable-mdpi\banner.png"
$cut = [Ftv]::Cutout($lg, [System.Drawing.Color]::FromArgb(0, 6, 24), 52, 170)
$box = [Ftv]::Trim($cut)
$wmH = [int]($box.Height * 1400 / $box.Width)
Save ([Ftv]::Fit($cut, $box, 1400, $wmH, 0, $clear)) "$PSScriptRoot\FantasyTV-Wordmark-2026.png", "$root\web\img\wordmark.png", "$root\site\img\wordmark.png"
"wordmark 1400 x $wmH"
$cut.Dispose(); $lg.Dispose()
