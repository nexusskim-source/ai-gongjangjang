$ErrorActionPreference = "Stop"
$token = $env:NANO_KEY
$outDir = $env:OUTDIR

$scenes = @(
  @{ id = "S1"; prompt = "A cozy classroom interior, daytime, cold atmosphere with fluorescent lights, a young woman with a backpack entering the door, simple flat illustration style" },
  @{ id = "S2"; prompt = "A young woman focused on taking notes during a class, AI presentation slides on a screen, classroom interior, simple flat illustration style" },
  @{ id = "S3"; prompt = "A young woman with a backpack leaving a classroom through the door, warm hallway light, simple flat illustration style" },
  @{ id = "S4"; prompt = "A young woman standing at a bus stop in the evening, checking her phone, city street, simple flat illustration style" },
  @{ id = "S5"; prompt = "A young woman sitting by the window inside a bus at evening, city lights outside, simple flat illustration style" },
  @{ id = "S6"; prompt = "A young woman opening her home front door at night, warm light from inside, gentle smile, simple flat illustration style" }
)

$endpoint = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent"
$headers = @{ "x-goog-api-key" = $token; "Content-Type" = "application/json" }

foreach ($s in $scenes) {
  Write-Output "Generating $($s.id)..."
  $body = @{ contents = @(@{ parts = @(@{ text = $s.prompt }) }) } | ConvertTo-Json -Depth 10
  try {
    $resp = Invoke-RestMethod -Uri $endpoint -Method Post -Headers $headers -Body $body
    $parts = $resp.candidates[0].content.parts
    $saved = $false
    foreach ($p in $parts) {
      if ($p.inlineData -and $p.inlineData.data) {
        $bytes = [System.Convert]::FromBase64String($p.inlineData.data)
        $path = Join-Path $outDir "$($s.id).png"
        [System.IO.File]::WriteAllBytes($path, $bytes)
        Write-Output "  Saved: $($s.id).png ($($bytes.Length) bytes)"
        $saved = $true
      }
    }
    if (-not $saved) { Write-Output "  No image data for $($s.id)" }
  } catch {
    $m = $_.Exception.Message; if ($m.Length -gt 200) { $m = $m.Substring(0,200) }
    Write-Output "  ERROR $($s.id): $m"
  }
}
Write-Output "DONE"
