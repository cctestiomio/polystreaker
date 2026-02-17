# vercel-polystreak-fix2.ps1
# Fixes:
# - resolvedRounds=0 by robustly parsing Gamma fields (arrays OR JSON-strings)
# - Uses Gamma resolved + outcomePrices to infer winner; falls back to CLOB /prices-history
# - Adds light mode default + dark toggle
# - Makes min/max streak editable (already) and supports any higher number
# Run: powershell.exe -ExecutionPolicy Bypass -File .\vercel-polystreak-fix2.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-FileUtf8NoBom([string]$Path, [string]$Content) {
  $dir = Split-Path -Parent $Path
  if ($dir -and !(Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# ----------------
# index.html (UI)
# ----------------
$indexHtml = @'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Polystreaker</title>
    <style>
      :root{
        /* Light default */
        --bg:#f6f7fb;
        --card:#ffffff;
        --card2:#ffffff;
        --text:#0e1222;
        --muted:#4b587a;
        --border:rgba(16,24,40,.14);
        --good:#0a8f3c;
        --bad:#d92d20;
        --warn:#b54708;
        --accent:#2563eb;
        --shadow: 0 10px 28px rgba(16,24,40,.08);
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      [data-theme="dark"]{
        --bg:#0b1020;
        --card:#101a33;
        --card2:#0f1730;
        --text:#e8ecff;
        --muted:#aab4e6;
        --border:rgba(255,255,255,.12);
        --good:#2ecc71;
        --bad:#ff4d4d;
        --warn:#ffcc66;
        --accent:#6ea8ff;
        --shadow: 0 12px 32px rgba(0,0,0,.35);
      }
      *{box-sizing:border-box}
      body{
        margin:0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        background: var(--bg);
        color:var(--text);
      }
      a{ color:var(--accent); text-decoration:none }
      a:hover{ text-decoration:underline }
      .wrap{ max-width:1120px; margin:26px auto; padding:0 16px; }
      .top{
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        margin-bottom:14px;
      }
      .title h1{ font-size:22px; margin:0; letter-spacing:.2px }
      .title .sub{ color:var(--muted); font-size:13px; margin-top:4px; }
      .card{
        background: linear-gradient(180deg, rgba(255,255,255,.65), rgba(255,255,255,.35));
        border:1px solid var(--border);
        border-radius:14px;
        padding:14px;
        box-shadow: var(--shadow);
      }
      [data-theme="dark"] .card{
        background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      }
      .grid{
        display:grid;
        grid-template-columns: 1.6fr 1fr 1fr 1fr 1fr 1fr 1fr;
        gap:10px;
      }
      label{ display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
      input{
        width:100%;
        background: rgba(255,255,255,.65);
        border:1px solid var(--border);
        color:var(--text);
        padding:9px 10px;
        border-radius:10px;
        outline:none;
      }
      [data-theme="dark"] input{
        background: rgba(0,0,0,.22);
      }
      input:focus{ border-color: rgba(37,99,235,.55); box-shadow:0 0 0 3px rgba(37,99,235,.12); }
      .btnrow{ display:flex; gap:10px; align-items:end; justify-content:flex-end; margin-top:10px; flex-wrap:wrap; }
      button{
        background: linear-gradient(180deg, rgba(37,99,235,.98), rgba(37,99,235,.78));
        border:0;
        color:white;
        font-weight:700;
        padding:10px 12px;
        border-radius:10px;
        cursor:pointer;
      }
      button.secondary{
        background: rgba(0,0,0,.02);
        color: var(--text);
        border:1px solid var(--border);
      }
      [data-theme="dark"] button.secondary{
        background: rgba(255,255,255,.08);
      }
      button:disabled{ opacity:.55; cursor:not-allowed; }
      .status{
        margin-top:12px;
        background: rgba(0,0,0,.02);
        border:1px solid var(--border);
        border-radius:14px;
        padding:12px;
        font-family: var(--mono);
        font-size:12px;
        color: var(--text);
        white-space: pre-wrap;
      }
      [data-theme="dark"] .status{ background: rgba(0,0,0,.18); }
      .row2{
        display:grid;
        grid-template-columns: 1.2fr 1fr;
        gap:12px;
        margin-top:12px;
      }
      table{
        width:100%;
        border-collapse:collapse;
        overflow:hidden;
        border-radius:14px;
        border:1px solid var(--border);
        background: rgba(255,255,255,.65);
      }
      [data-theme="dark"] table{ background: rgba(0,0,0,.14); }
      th,td{ padding:10px 10px; border-bottom:1px solid rgba(16,24,40,.08); text-align:right; }
      [data-theme="dark"] th,[data-theme="dark"] td{ border-bottom:1px solid rgba(255,255,255,.08); }
      th:first-child, td:first-child{ text-align:center; }
      th{ font-size:12px; color:var(--muted); font-weight:800; background: rgba(0,0,0,.02); }
      [data-theme="dark"] th{ background: rgba(255,255,255,.04); }
      tr:last-child td{ border-bottom:0; }
      .good{ color: var(--good); font-weight:900; }
      .bad{ color: var(--bad); font-weight:900; }
      .muted{ color: var(--muted); }
      .mono{ font-family: var(--mono); }
      ul{ margin:10px 0 0 18px; }
      .foot{ margin-top:10px; color: var(--muted); font-size:12px; }
      .toggle{
        display:flex; align-items:center; gap:10px;
        padding:8px 10px;
        border:1px solid var(--border);
        border-radius:999px;
        background: rgba(255,255,255,.55);
        box-shadow: var(--shadow);
      }
      [data-theme="dark"] .toggle{ background: rgba(255,255,255,.06); box-shadow:none; }
      .switch{
        width:42px; height:24px; border-radius:999px;
        background: rgba(16,24,40,.18);
        position:relative;
        cursor:pointer;
      }
      [data-theme="dark"] .switch{ background: rgba(255,255,255,.18); }
      .knob{
        width:18px; height:18px; border-radius:50%;
        background: white;
        position:absolute; top:3px; left:3px;
        transition: left .18s ease;
        box-shadow: 0 6px 14px rgba(0,0,0,.18);
      }
      [data-theme="dark"] .knob{ left:21px; background:#e8ecff; }
      @media (max-width: 1060px){
        .grid{ grid-template-columns: 1fr 1fr; }
        .row2{ grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body data-theme="light">
    <div class="wrap">
      <div class="top">
        <div class="title">
          <h1>Polymarket streak backtest</h1>
          <div class="sub">Backtests: if previous N rounds were all Up (or all Down), predict the opposite next round.</div>
        </div>
        <div class="toggle" id="themeToggle" title="Toggle dark mode">
          <span class="mono" style="font-size:12px;">Light/Dark</span>
          <div class="switch"><div class="knob"></div></div>
        </div>
      </div>

      <div class="card">
        <div class="grid">
          <div>
            <label>Base slug (current round)</label>
            <input id="baseSlug" placeholder="Auto (latest resolved)" />
          </div>
          <div>
            <label>Count (lookback slugs)</label>
            <input id="count" value="100" />
          </div>
          <div>
            <label>Offset (slugs back)</label>
            <input id="offset" value="1" />
          </div>
          <div>
            <label>Min streak</label>
            <input id="minStreak" value="2" />
          </div>
          <div>
            <label>Max streak</label>
            <input id="maxStreak" value="8" />
          </div>
          <div>
            <label>Round seconds</label>
            <input id="roundSeconds" value="300" />
          </div>
          <div>
            <label>Concurrency</label>
            <input id="concurrency" value="3" />
          </div>
        </div>

        <div class="btnrow">
          <button class="secondary" id="btnLatest">Use latest resolved</button>
          <button id="btnRun">Run</button>
        </div>

        <div class="status" id="status">Loading latest slug…</div>
      </div>

      <div class="row2">
        <div class="card">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:var(--muted); letter-spacing:.2px;">Win rates</h3>
          <div id="winrates"></div>
        </div>
        <div class="card">
          <h3 style="margin:0 0 10px 0; font-size:14px; color:var(--muted); letter-spacing:.2px;">Next-round suggestions</h3>
          <div id="next"></div>
          <div class="foot">
            Raw JSON: <a class="mono" id="raw" href="#" target="_blank" rel="noreferrer">/api/stats</a>
          </div>
        </div>
      </div>

      <div class="foot">
        If you still see <span class="mono">resolvedRounds: 0</span>, open the Raw JSON link and look at <span class="mono">diagnostics.sampleErrors</span>.
      </div>
    </div>

    <script type="module">
      const statusEl = document.querySelector("#status");
      const baseSlugEl = document.querySelector("#baseSlug");
      const rawEl = document.querySelector("#raw");
      const winratesEl = document.querySelector("#winrates");
      const nextEl = document.querySelector("#next");
      const btnRun = document.querySelector("#btnRun");
      const btnLatest = document.querySelector("#btnLatest");
      const themeToggle = document.querySelector("#themeToggle");

      function pct(x){ return (x==null) ? "n/a" : (x*100).toFixed(2) + "%"; }
      function num(v, fallback){ const n = Number(String(v).trim()); return Number.isFinite(n) ? n : fallback; }
      function setStatus(lines){ statusEl.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines); }

      function setTheme(theme){
        document.body.setAttribute("data-theme", theme);
        localStorage.setItem("theme", theme);
      }
      function initTheme(){
        const saved = localStorage.getItem("theme");
        setTheme(saved === "dark" ? "dark" : "light");
      }
      themeToggle.addEventListener("click", ()=>{
        const cur = document.body.getAttribute("data-theme");
        setTheme(cur === "dark" ? "light" : "dark");
      });

      function renderWinrates(byN){
        const ns = Object.keys(byN || {}).sort((a,b)=>Number(a)-Number(b));
        if (!ns.length){ winratesEl.innerHTML = "<div class='muted'>No data.</div>"; return; }

        const rows = ns.map(n=>{
          const b = byN[n];
          const losses = (b.signals ?? 0) - (b.wins ?? 0);
          const wr = b.winRate;
          const wrClass = (wr==null) ? "muted" : (wr >= 0.5 ? "good" : "bad");
          return `
            <tr>
              <td>${n}</td>
              <td>${b.signals ?? 0}</td>
              <td class="good">${b.wins ?? 0}</td>
              <td class="bad">${losses}</td>
              <td class="${wrClass}">${pct(wr)}</td>
            </tr>`;
        }).join("");

        winratesEl.innerHTML = `
          <table>
            <thead>
              <tr><th>N</th><th>Signals</th><th class="good">Wins</th><th class="bad">Losses</th><th>Win rate</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`;
      }

      function renderNext(nextPrediction, minStreak, maxStreak){
        if (!nextPrediction || !nextPrediction.suggestions || !nextPrediction.suggestions.length){
          nextEl.innerHTML = `<div class="muted">No current ${minStreak}-${maxStreak} streak detected (or not enough resolved rounds).</div>`;
          return;
        }
        const items = nextPrediction.suggestions.map(s=>{
          const predClass = s.predictNext === "Up" ? "good" : "bad";
          const prevClass = s.prevDir === "Up" ? "good" : "bad";
          return `<li class="mono">N=${s.n}: previous were <span class="${prevClass}">${s.prevDir}</span> => predict <span class="${predClass}">${s.predictNext}</span></li>`;
        }).join("");
        nextEl.innerHTML = `<ul>${items}</ul>`;
      }

      async function callJson(url){
        const res = await fetch(url, { headers: { "accept":"application/json" } });
        const text = await res.text();
        let j = null;
        try { j = JSON.parse(text); } catch {}
        return { res, text, j };
      }

      async function loadLatest(){
        setStatus("Loading latest slug…");
        const { res, text, j } = await callJson(`/api/latest?prefix=btc-updown-5m-&roundSeconds=300&lookbackSteps=120`);
        if (!res.ok) { setStatus(["ERROR /api/latest", `HTTP ${res.status}`, text.slice(0, 3000)]); return; }

        const pick = j.latestResolvedSlug || j.latestExistingSlug;
        if (pick) baseSlugEl.value = pick;

        setStatus([
          `Latest existing: ${j.latestExistingSlug || "n/a"}`,
          `Latest resolved: ${j.latestResolvedSlug || "n/a"}`,
          `Next slug:       ${j.nextSlug || "n/a"}`
        ]);
      }

      function makeStatsUrl(){
        const minStreak = num(document.querySelector("#minStreak").value, 2);
        const maxStreak = num(document.querySelector("#maxStreak").value, 8);
        const count = num(document.querySelector("#count").value, 100);
        const offset = num(document.querySelector("#offset").value, 1);
        const concurrency = num(document.querySelector("#concurrency").value, 3);
        const roundSeconds = num(document.querySelector("#roundSeconds").value, 300);

        const qs = new URLSearchParams({
          baseSlug: baseSlugEl.value.trim(),
          count: String(count),
          offset: String(offset),
          minStreak: String(minStreak),
          maxStreak: String(maxStreak),
          roundSeconds: String(roundSeconds),
          concurrency: String(concurrency)
        });
        return { url: `/api/stats?${qs.toString()}`, minStreak, maxStreak };
      }

      async function run(){
        btnRun.disabled = true;
        try{
          winratesEl.innerHTML = "";
          nextEl.innerHTML = "";
          const { url, minStreak, maxStreak } = makeStatsUrl();
          rawEl.href = url;
          rawEl.textContent = url;

          setStatus("Running backtest…");
          const { res, text, j } = await callJson(url);
          if (!res.ok){ setStatus(["ERROR /api/stats", `HTTP ${res.status}`, text.slice(0, 3500)]); return; }
          if (j?.error){ setStatus(["ERROR /api/stats", JSON.stringify(j, null, 2).slice(0, 3500)]); return; }

          const diag = j.diagnostics || {};
          setStatus([
            `Using baseSlug:     ${j.input?.baseSlug}`,
            `Backtest slugs:     previous ${j.input?.count} (offset=${j.input?.offset})`,
            `Resolved rounds:    ${j.totals?.resolvedRounds}/${j.totals?.rounds}`,
            `Signals:            ${j.totals?.signals}`,
            `Diagnostics errors: ${diag.totalErrors ?? 0}`,
            diag.topErrors?.length ? ("Top errors:\n" + diag.topErrors.map(x=>`- ${x.key}: ${x.count}`).join("\n")) : "",
            diag.sampleErrors?.length ? ("\nSample errors:\n" + diag.sampleErrors.map(x=>`- ${x.slug}: ${x.error}`).join("\n")) : ""
          ].filter(Boolean));

          renderWinrates(j.byN);
          renderNext(j.nextPrediction, minStreak, maxStreak);
        } finally {
          btnRun.disabled = false;
        }
      }

      initTheme();
      btnLatest.addEventListener("click", async () => { await loadLatest(); });
      btnRun.addEventListener("click", async () => { await run(); });

      await loadLatest();
      await run();
    </script>
  </body>
</html>
'@

# --------------------------------
# lib/backtest-core.js (logic/API)
# --------------------------------
$backtestCore = @'
// lib/backtest-core.js
// Uses Gamma markets-by-slug, and falls back to CLOB /prices-history for token price history.
// CLOB prices-history supports tokenId + startTs/endTs (or interval), and returns a `history` list of {t,p}. [Polymarket docs]

const gammaBase = "https://gamma-api.polymarket.com";
const clobBase = "https://clob.polymarket.com";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function clampInt(v, min, max, fallback){
  const n = Number(String(v).trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function parseSlug(slug){
  const parts = String(slug).split("-");
  const last = parts[parts.length - 1];
  const ts = Number(last);
  if (!Number.isFinite(ts)) throw new Error("Slug must end with unix timestamp: " + slug);
  const prefix = parts.slice(0, -1).join("-") + "-";
  return { prefix, ts };
}

function makeSlug(prefix, ts){ return prefix + String(ts); }

function buildPreviousSlugs(baseSlug, count, offset, roundSeconds){
  const { prefix, ts } = parseSlug(baseSlug);
  const slugs = [];
  for (let i = 0; i < count; i++){
    const t = ts - (offset + i) * roundSeconds;
    slugs.push({ slug: makeSlug(prefix, t), ts: t });
  }
  return slugs;
}

async function fetchJson(url, { retries=2, backoffMs=250, timeoutMs=9000 } = {}){
  let lastErr;
  for (let i=0; i<=retries; i++){
    const ac = new AbortController();
    const timer = setTimeout(()=>ac.abort(new Error("timeout")), timeoutMs);
    try{
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { accept: "application/json", "user-agent":"polystreaker/1.2" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch(e){
      lastErr = e;
      await sleep(backoffMs * (2 ** i));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function fetchMarketBySlug(slug){
  const u = `${gammaBase}/markets/slug/${encodeURIComponent(slug)}`;
  return await fetchJson(u, { retries: 2, timeoutMs: 9000 });
}

function safeParseArray(v){
  if (Array.isArray(v)) return v;
  if (typeof v === "string"){
    const s = v.trim();
    // Common: JSON-encoded arrays in string fields
    if ((s.startsWith("[") && s.endsWith("]")) || (s.startsWith("\"[") && s.endsWith("]\""))){
      try{
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {}
    }
    // Sometimes stored like: "Up,Down" or "['Up','Down']"
    if (s.includes(",")){
      return s.replace(/[\[\]'" ]/g, "").split(",").filter(Boolean);
    }
  }
  return null;
}

function normalizeUpDown(x){
  const s = String(x ?? "").trim().toLowerCase();
  if (s === "up") return "Up";
  if (s === "down") return "Down";
  if (/\bup\b/.test(s)) return "Up";
  if (/\bdown\b/.test(s)) return "Down";
  return null;
}

function pickWinnerFromOutcomePrices(outcomesRaw, outcomePricesRaw){
  const outcomes = safeParseArray(outcomesRaw);
  const prices = safeParseArray(outcomePricesRaw);

  if (!outcomes || !prices || outcomes.length !== prices.length) return null;

  let bestI = -1;
  let bestP = -Infinity;
  for (let i=0;i<prices.length;i++){
    const p = Number(prices[i]);
    if (!Number.isFinite(p)) continue;
    if (p > bestP){ bestP = p; bestI = i; }
  }
  if (bestI < 0) return null;

  const norm = normalizeUpDown(outcomes[bestI]);
  return norm ? { outcome: norm, bestPrice: bestP } : null;
}

function tryOutcomeFromGamma(market){
  // Gamma often includes resolved + outcomes + outcomePrices. These may be arrays or JSON strings.
  const resolvedFlag =
    market?.resolved ?? market?.isResolved ?? market?.market?.resolved ?? market?.market?.isResolved ??
    market?.closed ?? market?.market?.closed ?? false;

  const direct =
    market?.winningOutcome ?? market?.winning_outcome ??
    market?.winner ?? market?.result ?? market?.outcome ??
    market?.market?.winningOutcome ?? market?.market?.winner ?? market?.market?.result;

  const directNorm = normalizeUpDown(direct);
  if (directNorm) return { outcome: directNorm, method: "gamma-direct" };

  if (resolvedFlag){
    const outcomesRaw = market?.outcomes ?? market?.market?.outcomes;
    const outcomePricesRaw = market?.outcomePrices ?? market?.outcome_prices ?? market?.market?.outcomePrices ?? market?.market?.outcome_prices;
    const picked = pickWinnerFromOutcomePrices(outcomesRaw, outcomePricesRaw);
    if (picked?.outcome) return { outcome: picked.outcome, method: "gamma-outcomePrices" };
  }

  return { outcome: null, method: null };
}

function mapOutcomeToTokenIds(market){
  const outcomesRaw = market?.outcomes ?? market?.market?.outcomes;
  const clobTokenIdsRaw =
    market?.clobTokenIds ?? market?.clob_token_ids ?? market?.market?.clobTokenIds ?? market?.market?.clob_token_ids;

  const outcomes = safeParseArray(outcomesRaw);
  const clobTokenIds = safeParseArray(clobTokenIdsRaw);

  if (!outcomes || !clobTokenIds || outcomes.length !== clobTokenIds.length){
    return { upTokenId: null, downTokenId: null, error: "Missing outcomes/clobTokenIds mapping (arrays or JSON strings)." };
  }

  const pairs = outcomes.map((o,i)=>({ outcome:String(o), tokenId:String(clobTokenIds[i]) }));
  const up = pairs.find(x=>String(x.outcome).toLowerCase()==="up" || /\bup\b/i.test(x.outcome));
  const down = pairs.find(x=>String(x.outcome).toLowerCase()==="down" || /\bdown\b/i.test(x.outcome));
  if (!up || !down){
    return { upTokenId: null, downTokenId: null, error: "Could not find Up/Down in outcomes: " + JSON.stringify(outcomes) };
  }
  return { upTokenId: up.tokenId, downTokenId: down.tokenId, error: null };
}

async function fetchPricesHistory(tokenId, startTs, endTs){
  // Docs: /prices-history with tokenId, startTs, endTs, fidelity (minutes) [Polymarket docs]
  const paramsA = new URLSearchParams({ tokenId: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
  const urlA = `${clobBase}/prices-history?${paramsA.toString()}`;
  try {
    return await fetchJson(urlA, { retries: 2, timeoutMs: 9000 });
  } catch {
    const paramsB = new URLSearchParams({ token_id: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
    const urlB = `${clobBase}/prices-history?${paramsB.toString()}`;
    return await fetchJson(urlB, { retries: 2, timeoutMs: 9000 });
  }
}

function lastPriceFromHistory(j){
  const hist = j?.history ?? j?.data ?? j?.prices ?? j?.priceHistory;
  if (Array.isArray(hist) && hist.length){
    const last = hist[hist.length - 1];
    const p = Number(last?.p ?? last?.price ?? last?.[1]);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

function inferOutcomeFromFinalPrices(upLast, downLast){
  if (upLast == null || downLast == null) return { outcome: null, settled: false };
  const hi = Math.max(upLast, downLast);
  const lo = Math.min(upLast, downLast);
  const settled = (hi >= 0.90 && lo <= 0.10);
  const outcome = upLast >= downLast ? "Up" : "Down";
  return { outcome: settled ? outcome : null, settled };
}

async function inferResolvedOutcome(market, ts){
  // 1) Prefer Gamma resolved info
  const g = tryOutcomeFromGamma(market);
  if (g.outcome) return { outcome: g.outcome, method: g.method, settled: true, upLast: null, downLast: null };

  // 2) Fall back to CLOB /prices-history
  const map = mapOutcomeToTokenIds(market);
  if (!map.upTokenId || !map.downTokenId){
    return { outcome: null, method: "no-token-mapping", settled: false, error: map.error, upLast: null, downLast: null };
  }

  const startTs = ts - 1800; // 30m before
  const endTs = ts + 7200;   // 2h after
  const [upHist, downHist] = await Promise.all([
    fetchPricesHistory(map.upTokenId, startTs, endTs),
    fetchPricesHistory(map.downTokenId, startTs, endTs)
  ]);

  const upLast = lastPriceFromHistory(upHist);
  const downLast = lastPriceFromHistory(downHist);
  const inf = inferOutcomeFromFinalPrices(upLast, downLast);

  return { outcome: inf.outcome, method: "clob-prices-history", settled: inf.settled, upLast, downLast };
}

async function withPool(items, worker, max){
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(max, items.length) }, async ()=>{
    while(true){
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

function opposite(x){ return x==="Up" ? "Down" : x==="Down" ? "Up" : null; }

function computeSignals(rounds, minStreak, maxStreak){
  const signals = [];
  for (let i=0;i<rounds.length;i++){
    const actual = rounds[i].resolvedOutcome;
    if (actual !== "Up" && actual !== "Down") continue;

    for (let n=minStreak; n<=maxStreak; n++){
      if (i - n < 0) continue;
      const prev = rounds.slice(i-n, i);
      if (prev.some(r => r.resolvedOutcome !== "Up" && r.resolvedOutcome !== "Down")) continue;

      const allUp = prev.every(r => r.resolvedOutcome === "Up");
      const allDown = prev.every(r => r.resolvedOutcome === "Down");
      if (!allUp && !allDown) continue;

      const prevDir = allUp ? "Up" : "Down";
      const prediction = opposite(prevDir);
      signals.push({ n, ts: rounds[i].ts, slug: rounds[i].slug, prevDir, prediction, actual, correct: prediction === actual });
    }
  }
  return signals;
}

function summarize(signals, minStreak, maxStreak){
  const byN = {};
  for (let n=minStreak;n<=maxStreak;n++) byN[n] = { signals:0, wins:0, winRate:null };
  for (const s of signals){
    const b = byN[s.n];
    b.signals++;
    if (s.correct) b.wins++;
  }
  for (let n=minStreak;n<=maxStreak;n++){
    const b = byN[n];
    b.winRate = b.signals ? (b.wins / b.signals) : null;
  }
  return byN;
}

function latestNextPrediction(rounds, minStreak, maxStreak, roundSeconds){
  const resolved = rounds.filter(r => r.resolvedOutcome === "Up" || r.resolvedOutcome === "Down");
  if (!resolved.length) return null;

  const last = resolved[resolved.length - 1];
  const tail = resolved.map(r => r.resolvedOutcome);

  const suggestions = [];
  for (let n=minStreak;n<=maxStreak;n++){
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

export async function getLatestSlugs({ prefix="btc-updown-5m-", roundSeconds=300, lookbackSteps=120 } = {}){
  const nowTs = Math.floor(Date.now()/1000);
  let t = Math.floor(nowTs / roundSeconds) * roundSeconds;

  let latestExistingSlug = null;
  let latestResolvedSlug = null;
  let nextSlug = null;

  for (let i=0;i<=lookbackSteps;i++){
    const slug = prefix + String(t);
    try{
      const m = await fetchMarketBySlug(slug);
      if (!latestExistingSlug){
        latestExistingSlug = slug;
        nextSlug = prefix + String(t + roundSeconds);
      }
      const g = tryOutcomeFromGamma(m);
      if (g.outcome){
        latestResolvedSlug = slug;
        break;
      }
    } catch {}
    t -= roundSeconds;
  }

  return { latestExistingSlug, latestResolvedSlug, nextSlug };
}

export async function runBacktest({
  baseSlug,
  count=100,
  offset=1,
  minStreak=2,
  maxStreak=8,
  roundSeconds=300,
  concurrency=3
}){
  const cnt = clampInt(count, 2, 250, 100);
  const off = clampInt(offset, 0, 80, 1);
  const minS = clampInt(minStreak, 1, 200, 2);
  const maxS = clampInt(maxStreak, minS, 200, 8);
  const rs = clampInt(roundSeconds, 60, 3600, 300);
  const conc = clampInt(concurrency, 1, 8, 3);

  let resolvedBaseSlug = String(baseSlug ?? "").trim();
  if (!resolvedBaseSlug){
    const latest = await getLatestSlugs({ prefix: "btc-updown-5m-", roundSeconds: rs, lookbackSteps: 180 });
    resolvedBaseSlug = latest.latestResolvedSlug || latest.latestExistingSlug;
    if (!resolvedBaseSlug){
      return { error: "Could not determine a baseSlug (no markets found in lookback window).", latest };
    }
  }

  const slugs = buildPreviousSlugs(resolvedBaseSlug, cnt, off, rs);

  const errorCounts = new Map();
  const sampleErrors = [];
  const bumpErr = (key, slug, msg) => {
    errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    if (sampleErrors.length < 8 && slug && msg) sampleErrors.push({ slug, error: msg });
  };

  const rounds = await withPool(slugs, async ({ slug, ts })=>{
    try{
      const market = await fetchMarketBySlug(slug);
      const inf = await inferResolvedOutcome(market, ts);
      if (inf.error) bumpErr(inf.method || "inferResolvedOutcome", slug, inf.error);
      return {
        slug, ts,
        resolvedOutcome: inf.outcome,
        settled: inf.settled,
        method: inf.method,
        upFinalPrice: inf.upLast,
        downFinalPrice: inf.downLast
      };
    } catch (e){
      const msg = String(e?.message ?? e);
      bumpErr("fetchOrInfer", slug, msg);
      return { slug, ts, resolvedOutcome: null, error: msg };
    }
  }, conc);

  rounds.sort((a,b)=>a.ts-b.ts);

  const signals = computeSignals(rounds, minS, maxS);
  const byN = summarize(signals, minS, maxS);
  const nextPrediction = latestNextPrediction(rounds, minS, maxS, rs);

  const topErrors = Array.from(errorCounts.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 10)
    .map(([key,count])=>({ key, count }));

  const totalErrors = Array.from(errorCounts.values()).reduce((a,b)=>a+b, 0);

  return {
    input: { baseSlug: resolvedBaseSlug, count: cnt, offset: off, minStreak: minS, maxStreak: maxS, roundSeconds: rs, concurrency: conc },
    totals: {
      rounds: rounds.length,
      resolvedRounds: rounds.filter(r=>r.resolvedOutcome==="Up" || r.resolvedOutcome==="Down").length,
      signals: signals.length
    },
    byN,
    nextPrediction,
    diagnostics: { totalErrors, topErrors, sampleErrors }
  };
}
'@

# ----------------
# api/latest.js
# ----------------
$apiLatest = @'
// api/latest.js
import { getLatestSlugs } from "../lib/backtest-core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try{
    const url = new URL(req.url, "http://localhost");
    const prefix = url.searchParams.get("prefix") ?? "btc-updown-5m-";
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
    const lookbackSteps = Number(url.searchParams.get("lookbackSteps") ?? 120);

    const j = await getLatestSlugs({ prefix, roundSeconds, lookbackSteps });
    res.status(200).json(j);
  } catch(e){
    res.status(500).json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
}
'@

# ----------------
# api/stats.js
# ----------------
$apiStats = @'
// api/stats.js
import { runBacktest } from "../lib/backtest-core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try{
    const url = new URL(req.url, "http://localhost");

    const baseSlug = (url.searchParams.get("baseSlug") ?? "").trim();
    const count = Number(url.searchParams.get("count") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 1);
    const minStreak = Number(url.searchParams.get("minStreak") ?? 2);
    const maxStreak = Number(url.searchParams.get("maxStreak") ?? 8);
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
    const concurrency = Number(url.searchParams.get("concurrency") ?? 3);

    const result = await runBacktest({ baseSlug, count, offset, minStreak, maxStreak, roundSeconds, concurrency });
    res.status(result?.error ? 500 : 200).json(result);
  } catch(e){
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

Write-FileUtf8NoBom ".\index.html" $indexHtml
Write-FileUtf8NoBom ".\lib\backtest-core.js" $backtestCore
Write-FileUtf8NoBom ".\api\latest.js" $apiLatest
Write-FileUtf8NoBom ".\api\stats.js" $apiStats
Write-FileUtf8NoBom ".\vercel.json" $vercelJson

# Ensure package.json is Vercel/ESM-friendly
if (Test-Path ".\package.json") {
  $pkg = Get-Content ".\package.json" -Raw | ConvertFrom-Json
  if (-not $pkg.engines) { $pkg | Add-Member -NotePropertyName engines -NotePropertyValue (@{}) }
  $pkg.engines.node = "20.x"
  if (-not $pkg.type) { $pkg | Add-Member -NotePropertyName type -NotePropertyValue "module" }
  ($pkg | ConvertTo-Json -Depth 50) | Set-Content -Encoding UTF8 ".\package.json"
}

Write-Host "Patched files:"
Write-Host "  index.html"
Write-Host "  lib/backtest-core.js"
Write-Host "  api/latest.js"
Write-Host "  api/stats.js"
Write-Host "  vercel.json"
Write-Host ""
Write-Host "Now commit and push:"
Write-Host "  git add ."
Write-Host "  git commit -m `"Fix resolution parsing + theme toggle`""
Write-Host "  git push"
