// lib/backtest-core.js
// Gamma: GET https://gamma-api.polymarket.com/markets/slug/{slug}
// CLOB price history: GET https://clob.polymarket.com/prices-history?tokenId=...&startTs=...&endTs=...&fidelity=1 [Polymarket docs]

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

function safeParseArray(v){
  if (Array.isArray(v)) return v;
  if (typeof v === "string"){
    const s = v.trim();
    if (s.startsWith("[") && s.endsWith("]")){
      try{ const p = JSON.parse(s); if (Array.isArray(p)) return p; } catch {}
    }
    // Quick fallback "Up,Down"
    if (s.includes(",")) return s.replace(/[\[\]'" ]/g, "").split(",").filter(Boolean);
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

async function fetchJson(url, { retries=2, backoffMs=250, timeoutMs=9000 } = {}){
  let lastErr;
  for (let i=0; i<=retries; i++){
    const ac = new AbortController();
    const timer = setTimeout(()=>ac.abort(new Error("timeout")), timeoutMs);
    try{
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { accept:"application/json", "user-agent":"polystreaker/1.3" }
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
  const resolvedFlag =
    market?.resolved ?? market?.isResolved ?? market?.market?.resolved ?? market?.market?.isResolved ?? null;

  const closedFlag =
    market?.closed ?? market?.market?.closed ?? market?.archived ?? market?.market?.archived ?? null;

  const endDate =
    market?.endDate ?? market?.end_date ?? market?.market?.endDate ?? market?.market?.end_date ?? null;

  const direct =
    market?.winningOutcome ?? market?.winning_outcome ??
    market?.winner ?? market?.result ?? market?.outcome ??
    market?.market?.winningOutcome ?? market?.market?.winner ?? market?.market?.result;

  const directNorm = normalizeUpDown(direct);
  if (directNorm) return { outcome: directNorm, method: "gamma-direct" };

  // If it's resolved OR closed OR already past endDate, use outcomePrices max as best available inference.
  const now = Date.now();
  const ended = endDate ? (Date.parse(endDate) < (now - 30_000)) : false;

  if (resolvedFlag || closedFlag || ended){
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
    return { upTokenId:null, downTokenId:null, error:"Missing outcomes/clobTokenIds mapping (array or JSON string)." };
  }

  const pairs = outcomes.map((o,i)=>({ outcome:String(o), tokenId:String(clobTokenIds[i]) }));
  const up = pairs.find(x=>String(x.outcome).toLowerCase()==="up" || /\bup\b/i.test(x.outcome));
  const down = pairs.find(x=>String(x.outcome).toLowerCase()==="down" || /\bdown\b/i.test(x.outcome));
  if (!up || !down) return { upTokenId:null, downTokenId:null, error:"Could not find Up/Down in outcomes." };

  return { upTokenId: up.tokenId, downTokenId: down.tokenId, error:null };
}

async function fetchPricesHistory(tokenId, startTs, endTs){
  const paramsA = new URLSearchParams({ tokenId:String(tokenId), startTs:String(startTs), endTs:String(endTs), fidelity:"1" });
  const urlA = `${clobBase}/prices-history?${paramsA.toString()}`;
  try{
    return await fetchJson(urlA, { retries:2, timeoutMs:9000 });
  } catch {
    const paramsB = new URLSearchParams({ token_id:String(tokenId), startTs:String(startTs), endTs:String(endTs), fidelity:"1" });
    const urlB = `${clobBase}/prices-history?${paramsB.toString()}`;
    return await fetchJson(urlB, { retries:2, timeoutMs:9000 });
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
  if (upLast == null || downLast == null) return { outcome:null, settled:false };
  const hi = Math.max(upLast, downLast);
  const lo = Math.min(upLast, downLast);
  const settled = (hi >= 0.90 && lo <= 0.10);
  const outcome = upLast >= downLast ? "Up" : "Down";
  return { outcome: settled ? outcome : null, settled };
}

async function inferResolvedOutcome(market, ts){
  const g = tryOutcomeFromGamma(market);
  if (g.outcome) return { outcome:g.outcome, method:g.method, settled:true, upLast:null, downLast:null };

  const map = mapOutcomeToTokenIds(market);
  if (!map.upTokenId || !map.downTokenId){
    return { outcome:null, method:"no-token-mapping", settled:false, error:map.error, upLast:null, downLast:null };
  }

  const startTs = ts - 1800;
  const endTs = ts + 7200;

  const [upHist, downHist] = await Promise.all([
    fetchPricesHistory(map.upTokenId, startTs, endTs),
    fetchPricesHistory(map.downTokenId, startTs, endTs)
  ]);

  const upLast = lastPriceFromHistory(upHist);
  const downLast = lastPriceFromHistory(downHist);
  const inf = inferOutcomeFromFinalPrices(upLast, downLast);

  return { outcome: inf.outcome, method:"clob-prices-history", settled: inf.settled, upLast, downLast };
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

export async function getLatestSlugs({ prefix="btc-updown-5m-", roundSeconds=300, lookbackSteps=180 } = {}){
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
  concurrency=3,
  stripCount=12,
  signalsLimit=25
}){
  const cnt = clampInt(count, 2, 300, 100);
  const off = clampInt(offset, 0, 120, 1);
  const minS = clampInt(minStreak, 1, 500, 2);
  const maxS = clampInt(maxStreak, minS, 500, 8);
  const rs = clampInt(roundSeconds, 60, 3600, 300);
  const conc = clampInt(concurrency, 1, 8, 3);
  const stripN = clampInt(stripCount, 4, 40, 12);
  const sigLim = clampInt(signalsLimit, 0, 200, 25);

  let resolvedBaseSlug = String(baseSlug ?? "").trim();
  if (!resolvedBaseSlug){
    const latest = await getLatestSlugs({ prefix:"btc-updown-5m-", roundSeconds: rs, lookbackSteps: 240 });
    resolvedBaseSlug = latest.latestResolvedSlug || latest.latestExistingSlug;
    if (!resolvedBaseSlug){
      return { error:"Could not determine a baseSlug (no markets found in lookback window).", latest };
    }
  }

  const base = parseSlug(resolvedBaseSlug);

  const slugs = [];
  for (let i = 0; i < cnt; i++){
    const t = base.ts - (off + i) * rs;
    slugs.push({ slug: makeSlug(base.prefix, t), ts: t });
  }

  const errorCounts = new Map();
  const sampleErrors = [];
  const bumpErr = (key, slug, msg) => {
    errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    if (sampleErrors.length < 10 && slug && msg) sampleErrors.push({ slug, error: msg });
  };

  const rounds = await withPool(slugs, async ({ slug, ts })=>{
    try{
      const market = await fetchMarketBySlug(slug);
      const inf = await inferResolvedOutcome(market, ts);
      if (inf.error) bumpErr(inf.method || "inferResolvedOutcome", slug, inf.error);
      return { slug, ts, resolvedOutcome: inf.outcome, method: inf.method, settled: inf.settled, upFinalPrice: inf.upLast, downFinalPrice: inf.downLast };
    } catch (e){
      bumpErr("fetchOrInfer", slug, String(e?.message ?? e));
      return { slug, ts, resolvedOutcome: null, error: String(e?.message ?? e) };
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

  // Build round strip: last N past rounds + current
// For past rounds, r.ts is the start of that window.
// For current, the Polymarket slug timestamp base.ts is the END of the previous window,
// so the current window starts at base.ts and ends at base.ts + roundSeconds.
// We show [ts, ts+roundSeconds], so use start = base.ts + roundSeconds.
const tail = rounds.slice(-stripN).map(r=>({
  kind: "past",
  slug: r.slug,
  ts: r.ts,
  outcome: r.resolvedOutcome,
  method: r.method
}));

const currentStartTs = base.ts + roundSeconds;

const roundStrip = [
  ...tail,
  {
    kind: "current",
    slug: resolvedBaseSlug,
    ts: currentStartTs,
    outcome: null,
    method: "current"
  }
];

  // Recent signals (most recent first)
  const recentSignals = sigLim === 0
    ? []
    : signals.slice().sort((a,b)=>b.ts-a.ts).slice(0, sigLim);

  return {
    input: { baseSlug: resolvedBaseSlug, count: cnt, offset: off, minStreak: minS, maxStreak: maxS, roundSeconds: rs, concurrency: conc },
    totals: {
      rounds: rounds.length,
      resolvedRounds: rounds.filter(r=>r.resolvedOutcome==="Up" || r.resolvedOutcome==="Down").length,
      signals: signals.length
    },
    byN,
    nextPrediction,
    visual: {
      stripMeta: `stripCount=${stripN}, current=grey`,
      roundStrip,
      recentSignals
    },
    diagnostics: { totalErrors, topErrors, sampleErrors }
  };
}