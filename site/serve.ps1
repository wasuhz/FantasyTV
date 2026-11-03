# Serves this folder at http://localhost:8790/ to preview fantasytvapp.com (like GitHub Pages: /remote -> remote/index.html,
# /privacy -> privacy.html).
$root = $PSScriptRoot
$http = New-Object Net.HttpListener
$http.Prefixes.Add('http://localhost:8790/')
$http.Start()
$types = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.js' = 'text/javascript' }
while ($http.IsListening) {
    $c = $http.GetContext()
    $p = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath).TrimStart('/')
    $file = Join-Path $root $p
    if (Test-Path $file -PathType Container) { $file = Join-Path $file 'index.html' }
    elseif (-not (Test-Path $file) -and (Test-Path "$file.html")) { $file = "$file.html" }
    if (Test-Path $file -PathType Leaf) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $c.Response.ContentType = $types[[IO.Path]::GetExtension($file)]
    } else { $c.Response.StatusCode = 404; $bytes = [Text.Encoding]::UTF8.GetBytes('Not found') }
    $c.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $c.Response.Close()
}
