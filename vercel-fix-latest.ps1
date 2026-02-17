# vercel-fix-latest.ps1
# Patches repo to work on Vercel:
# - Static index.html at /
# - /api/latest returns latest existing slug (probes Gamma API)
# - /api/stats runs backtest; if baseSlug blank uses latest slug
# - Adds timeouts + better error surfacing
# Run: powershell.exe -ExecutionPolicy Bypass -File .\vercel-fix-latest.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-FileUtf8NoBom([string]$Path, [string]$Content) {
  $dir = Split-Path -Parent $Path
  if ($dir -and !(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# --------------------------
# index.html (static homepage)
# --------------------------
$indexHtml = @'
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Polystreaker</title>
    <style>
      body { font-family: system-ui, Arial; margin: 24px; }
      code { background: #f3f3f3; padding: 2px 6px; border-radius: 6px; }
      table { border-collapse: collapse; margin-top: 12px; }
      th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: right; }
      th:first-child, td:first-child { text-align: center; }
      .row { margin: 10px 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      input { padding: 6px 8px; }
      button { padding: 7px 10px; cursor: pointer; }
      #status { white-space: pre-wrap; }
    </style>
  </head>
  <body>
    <h1>Polymarket streak backtest</h1>

    <div class="row">
      <label>Base slug:</label>
      <input id="baseSlug" style="width: 360px" placeholder="(auto: latest btc-updown-5m-...)" />
      <label>Count:</label>
      <input id="count" style="width: 80px" value="40" />
      <button id="run">Run</button>
    </div>

    <pre id="status"></pre>
    <div id="out"></div>

    <script type="module">
      const statusEl = document.querySelector("#status");
      const outEl = document.querySelector("#out");
      const baseSlugEl = document.querySelector("#baseSlug");
      const countEl = document.querySelector("#count");

      function pct(x) { return (x == null) ? "n/a" : (x * 100).toFixed(2) + "%"; }

      function renderError(msg, extra="") {
        statusEl.textContent = "ERROR: " + msg + (extra ? ("\n\n" + extra) : "");
        outEl.innerHTML = "";
      }

      async function loadLatest() {
        statusEl.textContent = "Loading latest slug…";
        outEl.innerHTML = "";

        let res, text;
        try {
          res = await fetch(`/api/latest?prefix=btc-updown-5m-&roundSeconds=300`, { headers: { "accept": "application/json" } });
          text = await res.text();
        } catch (e) {
          renderError("Failed to call /api/latest", String(e?.message ?? e));
          return;
        }

        if (!res.ok) {
          renderError(`Latest slug HTTP ${res.status}`, text.slice(0, 2000));
          return;
        }

        let j;
        try { j = JSON.parse(text); } catch { renderError("Latest slug JSON parse failed", text.slice(0, 2000)); return; }

        if (!j.latestSlug) {
          renderError("No latestSlug returned", JSON.stringify(j, null, 2));
          return;
        }

        baseSlugEl.value = j.latestSlug;
        statusEl.textContent =
          `Latest slug: ${j.latestSlug}\n` +
          (j.nextSlug ? `Next slug:   ${j.nextSlug}\n` : "") +
          (j.latestTs ? `Latest ts:   ${j.latestTs}\n` : "");
      }

      async function run() {
        outEl.innerHTML = "";
        statusEl.textContent = "Running…";

        const baseSlug = baseSlugEl.value.trim(); // can be blank; API will default to latest
        const count = countEl.value.trim();

        const qs = new URLSearchParams({
          baseSlug,
          count,
          minStreak: "3",
          maxStreak: "8",
          roundSeconds: "300",
          concurrency: "4"
        });

        const url = `/api/stats?${qs.toString()}`;

        let res, text;
        try {
          res = await fetch(url, { headers: { "accept": "application/json" } });
          text = await res.text();
        } catch (e) {
          renderError("Request failed", String(e?.message ?? e));
          return;
        }

        if (!res.ok) {
          renderError(`HTTP ${res.status}`, text.slice(0, 4000));
          return;
        }

        let j;
        try { j = JSON.parse(text); } catch { renderError("Could not parse JSON", text.slice(0, 4000)); return; }

        if (j.error) {
          renderError("API error", JSON.stringify(j, null, 2).slice(0, 4000));
          return;
        }

        statusEl.textContent =
          `Using baseSlug: ${j.input?.baseSlug}\n` +
          `Resolved rounds: ${j.totals?.resolvedRounds}/${j.totals?.rounds}\n` +
          `Signals: ${j.totals?.signals}\n` +
          `API: ${url}`;

        const byN = j.byN || {};
        const ns = Object.keys(byN).sort((a,b) => Number(a)-Number(b));
        const rows = ns.map(n => {
          const b = byN[n];
          return `<tr><td>${n}</td><td>${b.signals}</td><td>${b.wins}</td><td>${pct(b.winRate)}</td></tr>`;
        }).join("");

        const next = j.nextPrediction?.suggestions?.map(s =>
          `<li>N=${s.n}: previous were ${s.prevDir} ⇒ predict <b>${s.predictNext}</b> (nextTs=${s.nextTs})</li>`
        ).join("") ?? "";

        outEl.innerHTML = `
          <h2>Win rates</h2>
          <table>
            <thead><tr><th>N</th><th>Signals</th><th>Wins</th><th>Win rate</th></tr></thead>
            <tbody>${rows || ""}</tbody>
          </table>

          <h2>Next-round suggestions</h2>
          <ul>${next || "<li>No current 3–8 streak detected (or not enough resolved rounds).</li>"}</ul>

          <p>Raw JSON: <a href="${url}" target="_blank" rel="noreferrer"><code>${url}</code></a></p>
        `;
      }

      document.querySelector("#run").addEventListener("click", run);
      await loadLatest();
      await run();
    </script>
  </body>
</html>
'@

# --------------------------------------------
# lib/backtest-core.js (shared logic for APIs)
# --------------------------------------------
$backtestCore = @'
// lib/backtest-core.js
const gammaBase = "https://gamma-api.polymarket.com";
const clobBase = "https://clob.polymarket.com";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function parseBaseSlug(slug) {
  const parts = slug.split("-");
  const last = parts[parts.length - 1];
  const ts = Number(last);
  if (!Number.isFinite(ts)) throw new Error("baseSlug must end with a unix timestamp, got: " + slug);
  const prefix = parts.slice(0, -1).join("-") + "-";
  return { prefix, ts };
}

function buildSlugs(baseSlug, count, roundSeconds) {
  const { prefix, ts } = parseBaseSlug(baseSlug);
  return Array.from({ length: count }, (_, i) => {
    const t = ts - i * roundSeconds;
    return { slug: prefix + String(t), ts: t };
  });
}

async function fetchJson(url, { retries = 3, backoffMs = 250, timeoutMs = 8000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          accept: "application/json",
          "user-agent": "polystreaker-vercel/1.0"
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(backoffMs * (2 ** i));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

export async function marketExistsBySlug(slug) {
  const u = `${gammaBase}/markets/slug/${encodeURIComponent(slug)}`;
  try {
    await fetchJson(u, { retries: 1, timeoutMs: 6000 });
    return true;
  } catch {
    return false;
  }
}

export async function getLatestExistingSlug({ prefix = "btc-updown-5m-", roundSeconds = 300, lookbackSteps = 24 } = {}) {
  const nowTs = Math.floor(Date.now() / 1000);
  // Align to the 5-minute boundary.
  let t = Math.floor(nowTs / roundSeconds) * roundSeconds;

  const attempted = [];
  for (let i = 0; i <= lookbackSteps; i++) {
    const slug = prefix + String(t);
    attempted.push(slug);
    if (await marketExistsBySlug(slug)) {
      return {
        latestSlug: slug,
        latestTs: t,
        nextSlug: prefix + String(t + roundSeconds),
        attempted
      };
    }
    t -= roundSeconds;
  }

  return { latestSlug: null, latestTs: null, nextSlug: null, attempted };
}

async function fetchMarketBySlug(slug) {
  const u1 = `${gammaBase}/markets/slug/${encodeURIComponent(slug)}`;
  return await fetchJson(u1, { retries: 2, timeoutMs: 8000 });
}

function mapOutcomeToTokenId(market) {
  const outcomes = market?.outcomes ?? market?.market?.outcomes;
  const clobTokenIds = market?.clobTokenIds ?? market?.clob_token_ids ?? market?.market?.clobTokenIds;

  if (!Array.isArray(outcomes) || !Array.isArray(clobTokenIds) || outcomes.length !== clobTokenIds.length) {
    throw new Error("Market missing outcomes/clobTokenIds mapping.");
  }

  const pairs = outcomes.map((o, i) => ({ outcome: String(o), tokenId: String(clobTokenIds[i]) }));
  const up = pairs.find(x => /^up$/i.test(x.outcome) || /\bup\b/i.test(x.outcome));
  const down = pairs.find(x => /^down$/i.test(x.outcome) || /\bdown\b/i.test(x.outcome));
  if (!up || !down) throw new Error("Could not find Up/Down outcomes in: " + JSON.stringify(outcomes));

  return { upTokenId: up.tokenId, downTokenId: down.tokenId };
}

async function fetchPricesHistory(tokenId, startTs, endTs) {
  const paramsA = new URLSearchParams({ tokenId: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
  const urlA = `${clobBase}/prices-history?${paramsA.toString()}`;
  try {
    return await fetchJson(urlA, { retries: 2, timeoutMs: 8000 });
  } catch {
    const paramsB = new URLSearchParams({ token_id: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
    const urlB = `${clobBase}/prices-history?${paramsB.toString()}`;
    return await fetchJson(urlB, { retries: 2, timeoutMs: 8000 });
  }
}

function lastPriceFromHistory(j) {
  const hist = j?.history ?? j?.data ?? j?.prices ?? j?.priceHistory;
  if (!Array.isArray(hist) || hist.length === 0) return null;
  const last = hist[hist.length - 1];
  const p = Number(last?.p ?? last?.price ?? last?.[1]);
  return Number.isFinite(p) ? p : null;
}

async function inferResolvedOutcomeFromPrices(upTokenId, downTokenId, approxEndTs) {
  const startTs = approxEndTs - 1800; // 30m before
  const endTs = approxEndTs + 5400;   // 90m after

  const [upHist, downHist] = await Promise.all([
    fetchPricesHistory(upTokenId, startTs, endTs),
    fetchPricesHistory(downTokenId, startTs, endTs)
  ]);

  const upLast = lastPriceFromHistory(upHist);
  const downLast = lastPriceFromHistory(downHist);

  if (upLast == null || downLast == null) return { outcome: null, upLast, downLast };
  return { outcome: (upLast >= downLast) ? "Up" : "Down", upLast, downLast };
}

async function withPool(items, worker, max) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

function opposite(x) { return x === "Up" ? "Down" : x === "Down" ? "Up" : null; }

function computeSignals(rounds, minStreak, maxStreak) {
  const signals = [];
  for (let i = 0; i < rounds.length; i++) {
    const actual = rounds[i].resolvedOutcome;
    if (actual !== "Up" && actual !== "Down") continue;

    for (let n = minStreak; n <= maxStreak; n++) {
      if (i - n < 0) continue;
      const prev = rounds.slice(i - n, i);
      if (prev.some(r => r.resolvedOutcome !== "Up" && r.resolvedOutcome !== "Down")) continue;

      const allUp = prev.every(r => r.resolvedOutcome === "Up");
      const allDown = prev.every(r => r.resolvedOutcome === "Down");
      if (!allUp && !allDown) continue;

      const prevDir = allUp ? "Up" : "Down";
      const prediction = opposite(prevDir);
      const correct = prediction === actual;

      signals.push({ n, ts: rounds[i].ts, slug: rounds[i].slug, prevDir, prediction, actual, correct });
    }
  }
  return signals;
}

function summarize(signals, minStreak, maxStreak) {
  const byN = {};
  for (let n = minStreak; n <= maxStreak; n++) byN[n] = { signals: 0, wins: 0, winRate: null };

  for (const s of signals) {
    const b = byN[s.n];
    b.signals++;
    if (s.correct) b.wins++;
  }
  for (let n = minStreak; n <= maxStreak; n++) {
    const b = byN[n];
    b.winRate = b.signals ? (b.wins / b.signals) : null;
  }
  return byN;
}

function latestNextPrediction(rounds, minStreak, maxStreak, roundSeconds) {
  const resolved = rounds.filter(r => r.resolvedOutcome === "Up" || r.resolvedOutcome === "Down");
  if (!resolved.length) return null;

  const last = resolved[resolved.length - 1];
  const tail = resolved.map(r => r.resolvedOutcome);

  const suggestions = [];
  for (let n = minStreak; n <= maxStreak; n++) {
    if (tail.length < n) continue;
    const window = tail.slice(-n);
    const allUp = window.every(x => x === "Up");
    const allDown = window.every(x => x === "Down");
    if (!allUp && !allDown) continue;

    const prevDir = allUp ? "Up" : "Down";
    suggestions.push({ n, prevDir, predictNext: opposite(prevDir), nextTs: last.ts + roundSeconds });
  }
  return suggestions.length ? { lastResolvedSlug: last.slug, lastResolvedTs: last.ts, suggestions } : null;
}

export async function runBacktest({ baseSlug, count, minStreak, maxStreak, roundSeconds, concurrency = 4 }) {
  // safety clamps for Vercel
  const minS = clampInt(minStreak, 3, 20, 3);
  const maxS = clampInt(maxStreak, minS, 20, 8);
  const cnt = clampInt(count, 2, 120, 40);
  const conc = clampInt(concurrency, 1, 8, 4);
  const rs = clampInt(roundSeconds, 60, 3600, 300);

  let resolvedBaseSlug = baseSlug?.trim();
  if (!resolvedBaseSlug) {
    const latest = await getLatestExistingSlug({ prefix: "btc-updown-5m-", roundSeconds: rs, lookbackSteps: 48 });
    if (!latest.latestSlug) {
      return { error: "Could not find latest existing slug", latestProbe: latest };
    }
    resolvedBaseSlug = latest.latestSlug;
  }

  const slugs = buildSlugs(resolvedBaseSlug, cnt, rs);

  const rounds = await withPool(slugs, async ({ slug, ts }) => {
    try {
      const market = await fetchMarketBySlug(slug);
      const { upTokenId, downTokenId } = mapOutcomeToTokenId(market);
      const inferred = await inferResolvedOutcomeFromPrices(upTokenId, downTokenId, ts);
      return { slug, ts, upTokenId, downTokenId, upFinalPrice: inferred.upLast, downFinalPrice: inferred.downLast, resolvedOutcome: inferred.outcome };
    } catch (e) {
      return { slug, ts, resolvedOutcome: null, error: String(e?.message ?? e) };
    }
  }, conc);

  rounds.sort((a, b) => a.ts - b.ts);

  const signals = computeSignals(rounds, minS, maxS);
  const byN = summarize(signals, minS, maxS);
  const nextPrediction = latestNextPrediction(rounds, minS, maxS, rs);

  return {
    input: { baseSlug: resolvedBaseSlug, count: cnt, minStreak: minS, maxStreak: maxS, roundSeconds: rs, concurrency: conc },
    totals: {
      rounds: rounds.length,
      resolvedRounds: rounds.filter(r => r.resolvedOutcome === "Up" || r.resolvedOutcome === "Down").length,
      signals: signals.length
    },
    byN,
    nextPrediction
  };
}
'@

# ------------------------
# Vercel API: /api/latest
# ------------------------
$apiLatest = @'
// api/latest.js
import { getLatestExistingSlug } from "../lib/backtest-core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    const url = new URL(req.url, "http://localhost");
    const prefix = url.searchParams.get("prefix") ?? "btc-updown-5m-";
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);

    const result = await getLatestExistingSlug({ prefix, roundSeconds, lookbackSteps: 48 });
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
}
'@

# -----------------------
# Vercel API: /api/stats
# -----------------------
$apiStats = @'
// api/stats.js
import { runBacktest } from "../lib/backtest-core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try {
    const url = new URL(req.url, "http://localhost");

    const baseSlug = (url.searchParams.get("baseSlug") ?? "").trim(); // blank => auto-latest
    const count = Number(url.searchParams.get("count") ?? 40);
    const minStreak = Number(url.searchParams.get("minStreak") ?? 3);
    const maxStreak = Number(url.searchParams.get("maxStreak") ?? 8);
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
    const concurrency = Number(url.searchParams.get("concurrency") ?? 4);

    const result = await runBacktest({ baseSlug, count, minStreak, maxStreak, roundSeconds, concurrency });
    res.status(result?.error ? 500 : 200).json(result);
  } catch (e) {
    res.status(500).json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
}
'@

# -------------
# vercel.json
# -------------
$vercelJson = @'
{
  "functions": {
    "api/latest.js": { "maxDuration": 30 },
    "api/stats.js":  { "maxDuration": 60 }
  }
}
'@

# Write/overwrite files
Write-FileUtf8NoBom ".\index.html" $indexHtml
Write-FileUtf8NoBom ".\lib\backtest-core.js" $backtestCore
Write-FileUtf8NoBom ".\api\latest.js" $apiLatest
Write-FileUtf8NoBom ".\api\stats.js" $apiStats
Write-FileUtf8NoBom ".\vercel.json" $vercelJson

# Ensure package.json is Vercel-friendly (Node 20, ESM)
if (Test-Path ".\package.json") {
  $pkg = Get-Content ".\package.json" -Raw | ConvertFrom-Json

  if (-not $pkg.engines) { $pkg | Add-Member -NotePropertyName engines -NotePropertyValue (@{}) }
  $pkg.engines.node = "20.x"

  # Ensure "type":"module" so our ESM imports work
  if (-not $pkg.type) { $pkg | Add-Member -NotePropertyName type -NotePropertyValue "module" }

  ($pkg | ConvertTo-Json -Depth 50) | Set-Content -Encoding UTF8 ".\package.json"
}

Write-Host "Patched repo for Vercel."
Write-Host "Now run:"
Write-Host "  git add ."
Write-Host "  git commit -m `"Vercel fix: latest slug + stats API + UI`""
Write-Host "  git push"
Write-Host ""
Write-Host "After redeploy, test:"
Write-Host "  https://<your-app>.vercel.app/api/latest"
Write-Host "  https://<your-app>.vercel.app/api/stats"
Write-Host "  https://<your-app>.vercel.app/"
