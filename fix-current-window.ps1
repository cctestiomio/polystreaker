# fix-current-window.ps1
# - Adds Discord webhook alert for N>=5 streaks in /api/stats
# - Adds/updates Vercel cron job for /api/stats (every 5 minutes)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-FileUtf8NoBom([string]$Path, [string]$Content) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# ----------------------------
# 1) Patch api/stats.js
# ----------------------------
$apiPath = ".\api\stats.js"
if (!(Test-Path $apiPath)) { throw "api\stats.js not found. Run from repo root." }

$api = Get-Content $apiPath -Raw

if ($api -notmatch "Discord webhook helper") {
  $hookHelper = @'
// Discord webhook helper
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1467216362962161727/qDTCrFMNtUUaTIhw7jrr3z7W2FmyfNq6BaDHfvE2l3M9djE-oKRzSLlYVqX0_zjq0kxM";

async function sendDiscordAlert(message) {
  try {
    if (!DISCORD_WEBHOOK_URL) return;
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message })
    });
  } catch (e) {
    console.error("Discord webhook failed", e);
  }
}

'@
  $api = $api -replace '(export const config = \{ runtime: "nodejs" \};\s*)', "`$1`n$hookHelper"
}

$oldCall = @'
    const baseSlug = (url.searchParams.get("baseSlug") ?? "").trim();
    const count = Number(url.searchParams.get("count") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 1);
    const minStreak = Number(url.searchParams.get("minStreak") ?? 2);
    const maxStreak = Number(url.searchParams.get("maxStreak") ?? 8);
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
    const concurrency = Number(url.searchParams.get("concurrency") ?? 3);
    const stripCount = Number(url.searchParams.get("stripCount") ?? 12);
    const signalsLimit = Number(url.searchParams.get("signalsLimit") ?? 25);

    const result = await runBacktest({ baseSlug, count, offset, minStreak, maxStreak, roundSeconds, concurrency, stripCount, signalsLimit });
    res.status(result?.error ? 500 : 200).json(result);
'@

$newCall = @'
    const baseSlug = (url.searchParams.get("baseSlug") ?? "").trim();
    const useLatest = url.searchParams.get("useLatest") === "1";
    const count = Number(url.searchParams.get("count") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 1);
    const minStreak = Number(url.searchParams.get("minStreak") ?? 2);
    const maxStreak = Number(url.searchParams.get("maxStreak") ?? 8);
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
    const concurrency = Number(url.searchParams.get("concurrency") ?? 3);
    const stripCount = Number(url.searchParams.get("stripCount") ?? 12);
    const signalsLimit = Number(url.searchParams.get("signalsLimit") ?? 25);

    const result = await runBacktest({ baseSlug, useLatest, count, offset, minStreak, maxStreak, roundSeconds, concurrency, stripCount, signalsLimit });

    // Discord alert: if any streak signal with N >= 5 exists, alert the most recent one.
    try {
      const vis = result?.visual;
      const signals = Array.isArray(vis?.recentSignals) ? vis.recentSignals : [];
      const interesting = signals.filter(s => s.n >= 5);
      if (interesting.length > 0) {
        const best = interesting.slice().sort((a,b) => b.ts - a.ts)[0];
        const dir = best.prevDir === "Up" ? "Up" : (best.prevDir === "Down" ? "Down" : "Unknown");
        const predict = best.prediction || "Unknown";
        const ts = best.ts || 0;
        const msg = `Streak alert: last ${best.n} rounds were ${dir}. Rule says: predict ${predict} next. ts=${ts}, slug=${best.slug}`;
        await sendDiscordAlert(msg);
      }
    } catch (e) {
      console.error("discord alert logic failed", e);
    }

    res.status(result?.error ? 500 : 200).json(result);
'@

if ($api -notmatch 'useLatest') {
  $api2 = $api.Replace($oldCall, $newCall)
  if ($api2 -eq $api) { throw "Could not patch api/stats.js: expected handler block not found." }
  $api = $api2
}

Write-FileUtf8NoBom $apiPath $api
Write-Host "Patched api/stats.js (useLatest + Discord webhook alert)."

# ----------------------------
# 2) Patch lib/backtest-core.js (useLatest support)
# ----------------------------
$libPath = ".\lib\backtest-core.js"
if (!(Test-Path $libPath)) { throw "lib\backtest-core.js not found." }
$lib = Get-Content $libPath -Raw

if ($lib -notmatch 'useLatest = false') {
  $lib = $lib -replace 'export async function runBacktest\(\{\s*baseSlug,', 'export async function runBacktest({ baseSlug, useLatest = false,'
}

$oldBase = @'
  let resolvedBaseSlug = String(baseSlug ?? "").trim();
  if (!resolvedBaseSlug){
    const latest = await getLatestSlugs({ prefix:"btc-updown-5m-", roundSeconds: rs, lookbackSteps: 240 });
    resolvedBaseSlug = latest.latestResolvedSlug || latest.latestExistingSlug;
    if (!resolvedBaseSlug){
      return { error:"Could not determine a baseSlug (no markets found in lookback window).", latest };
    }
  }
'@

$newBase = @'
  let resolvedBaseSlug = String(baseSlug ?? "").trim();
  if (!resolvedBaseSlug || useLatest){
    const latest = await getLatestSlugs({ prefix:"btc-updown-5m-", roundSeconds: rs, lookbackSteps: 240 });
    resolvedBaseSlug = latest.latestResolvedSlug || latest.latestExistingSlug;
    if (!resolvedBaseSlug){
      return { error:"Could not determine a baseSlug (no markets found in lookback window).", latest };
    }
  }
'@

if ($lib -notmatch 'useLatest\)') {
  $lib2 = $lib.Replace($oldBase, $newBase)
  if ($lib2 -eq $lib) { throw "Could not patch baseSlug logic in lib/backtest-core.js." }
  $lib = $lib2
}

Write-FileUtf8NoBom $libPath $lib
Write-Host "Patched lib/backtest-core.js (useLatest support)."

# ----------------------------
# 3) Patch vercel.json (cron)
# ----------------------------
$vercelPath = ".\vercel.json"
if (Test-Path $vercelPath) {
  $vjRaw = Get-Content $vercelPath -Raw
  $vj = $vjRaw | ConvertFrom-Json

  if (-not $vj.functions) {
    $vj | Add-Member -NotePropertyName functions -NotePropertyValue (@{}) -Force
  }
  if (-not $vj.functions.'api/latest.js') {
    $vj.functions.'api/latest.js' = @{ maxDuration = 30 }
  }
  if (-not $vj.functions.'api/stats.js') {
    $vj.functions.'api/stats.js'  = @{ maxDuration = 60 }
  }

  $cronPath = "/api/stats?useLatest=1&count=100&offset=1&minStreak=2&maxStreak=8&roundSeconds=300&concurrency=3&stripCount=12&signalsLimit=25"

  if (-not $vj.crons) {
    $vj | Add-Member -NotePropertyName crons -NotePropertyValue @() -Force
  }

  # Normalize to array
  $crons = @()
  if ($vj.crons -is [System.Collections.IEnumerable]) {
    $crons = @($vj.crons)
  } elseif ($vj.crons) {
    $crons = @($vj.crons)
  }

  $existing = $crons | Where-Object { $_.path -eq $cronPath }

  if (-not $existing -or $existing.Count -eq 0) {
    $cronObj = [pscustomobject]@{
      path     = $cronPath
      schedule = "*/2 * * * *"
    }
    $crons += $cronObj
  } else {
    foreach ($c in $existing) { $c.schedule = "*/2 * * * *" }
  }

  $vj.crons = $crons

  ($vj | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 $vercelPath
  Write-Host "Updated vercel.json with cron job hitting $cronPath every 5 minutes."
} else {
  Write-Host "vercel.json not found; skipping cron setup."
}

Write-Host ""
Write-Host "Done. Now run:"
Write-Host "  git add api\stats.js lib\backtest-core.js vercel.json"
Write-Host "  git commit -m `"Discord alerts + Vercel cron`""
Write-Host "  git push"
