// lib/backtest-core.js
// Gamma: GET https://gamma-api.polymarket.com/markets/slug/{slug}
// CLOB last-trade-price: GET https://clob.polymarket.com/last-trade-price?token_id=X  (one token at a time)
// CLOB price history: GET https://clob.polymarket.com/prices-history?tokenId=...

const gammaBase = "https://gamma-api.polymarket.com";
const clobBase  = "https://clob.polymarket.com";

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
        headers: { accept:"application/json", "user-agent":"polystreaker/1.4" }
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

// ── CLOB per-token last-trade-price ──────────────────────────────────────────
// /last-trade-price only accepts ONE token_id at a time.
// Settles to 1.0/0.0 the instant a market resolves, faster than Gamma.
async function fetchClobLastTradePrice(tokenId){
  try {
    const url = `${clobBase}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
    const data = await fetchJson(url, { retries:1, timeoutMs:5000 });
    if (data && typeof data.price !== "undefined") return Number(data.price);
  } catch {}
  return null;
}

// ── Gamma outcome helpers ────────────────────────────────────────────────────

function pickWinnerFromOutcomePrices(outcomesRaw, outcomePricesRaw, threshold=0.99){
  const outcomes = safeParseArray(outcomesRaw);
  const prices   = safeParseArray(outcomePricesRaw);
  if (!outcomes || !prices || outcomes.length !== prices.length) return null;

  let bestI = -1, bestP = -Infinity;
  for (let i=0; i<prices.length; i++){
    const p = Number(prices[i]);
    if (!Number.isFinite(p)) continue;
    if (p > bestP){ bestP = p; bestI = i; }
  }
  if (bestI < 0 || bestP < threshold) return null;

  const norm = normalizeUpDown(outcomes[bestI]);
  return norm ? { outcome: norm, bestPrice: bestP } : null;
}

function tryOutcomeFromGamma(market){
  // 1. Direct winner field
  const direct =
    market?.winningOutcome ?? market?.winning_outcome ??
    market?.winner ?? market?.result ?? market?.outcome ??
    market?.resolvedOutcome ?? market?.resolved_outcome ??
    market?.market?.winningOutcome ?? market?.market?.winner ??
    market?.market?.result ?? market?.market?.resolvedOutcome;

  const directNorm = normalizeUpDown(direct);
  if (directNorm) return { outcome: directNorm, method: "gamma-direct" };

  // 2. outcomePrices — NO gate on closed/resolved flags.
  // Prices settle to 1.0/0.0 faster than the flags flip after a window closes.
  const outcomesRaw      = market?.outcomes ?? market?.market?.outcomes;
  const outcomePricesRaw = market?.outcomePrices ?? market?.outcome_prices ??
                           market?.market?.outcomePrices ?? market?.market?.outcome_prices;

  const picked = pickWinnerFromOutcomePrices(outcomesRaw, outcomePricesRaw, 0.99);
  if (picked?.outcome) return { outcome: picked.outcome, method: "gamma-outcomePrices" };

  return { outcome: null, method: null };
}

function mapOutcomeToTokenIds(market){
  const outcomesRaw      = market?.outcomes ?? market?.market?.outcomes;
  const clobTokenIdsRaw  = market?.clobTokenIds ?? market?.clob_token_ids ??
                           market?.market?.clobTokenIds ?? market?.market?.clob_token_ids;

  const outcomes     = safeParseArray(outcomesRaw);
  const clobTokenIds = safeParseArray(clobTokenIdsRaw);

  if (!outcomes || !clobTokenIds || outcomes.length !== clobTokenIds.length){
    return { upTokenId:null, downTokenId:null, error:"Missing outcomes/clobTokenIds mapping." };
  }

  const pairs = outcomes.map((o,i)=>({ outcome:String(o), tokenId:String(clobTokenIds[i]) }));
  const up    = pairs.find(x=>/\bup\b/i.test(x.outcome));
  const down  = pairs.find(x=>/\bdown\b/i.test(x.outcome));
  if (!up || !down) return { upTokenId:null, downTokenId:null, error:"Could not find Up/Down in outcomes." };

  return { upTokenId: up.tokenId, downTokenId: down.tokenId, error:null };
}

// ── CLOB prices-history (slower fallback for older markets) ──────────────────
async function fetchPricesHistory(tokenId, startTs, endTs){
  const paramsA = new URLSearchParams({ tokenId:String(tokenId), startTs:String(startTs), endTs:String(endTs), fidelity:"1" });
  try{
    return await fetchJson(`${clobBase}/prices-history?${paramsA}`, { retries:2, timeoutMs:9000 });
  } catch {
    const paramsB = new URLSearchParams({ token_id:String(tokenId), startTs:String(startTs), endTs:String(endTs), fidelity:"1" });
    return await fetchJson(`${clobBase}/prices-history?${paramsB}`, { retries:2, timeoutMs:9000 });
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

function inferOutcomeFromFinalPrices(upLast, downLast, threshold=0.90){
  if (upLast == null || downLast == null) return { outcome:null, settled:false };
  const hi = Math.max(upLast, downLast);
  const lo = Math.min(upLast, downLast);
  const settled = (hi >= threshold && lo <= (1 - threshold));
  const outcome = upLast >= downLast ? "Up" : "Down";
  return { outcome: settled ? outcome : null, settled };
}

// ── Main outcome resolver ─────────────────────────────────────────────────────
async function inferResolvedOutcome(market, ts){
  // 1. Try Gamma fields first (fastest when available)
  const g = tryOutcomeFromGamma(market);
  if (g.outcome) return { outcome:g.outcome, method:g.method, settled:true, upLast:null, downLast:null };

  // 2. CLOB last-trade-price per token (near-instant after resolution)
  const map = mapOutcomeToTokenIds(market);
  if (map.upTokenId && map.downTokenId){
    const [upLast, downLast] = await Promise.all([
      fetchClobLastTradePrice(map.upTokenId),
      fetchClobLastTradePrice(map.downTokenId)
    ]);
    const inf = inferOutcomeFromFinalPrices(upLast, downLast, 0.99);
    if (inf.outcome){
      return { outcome:inf.outcome, method:"clob-last-trade-price", settled:true, upLast, downLast };
    }

    // 3. CLOB prices-history fallback (slower, works for older markets)
    const startTs = ts - 1800;
    const endTs   = ts + 7200;
    const [upHist, downHist] = await Promise.all([
      fetchPricesHistory(map.upTokenId, startTs, endTs),
      fetchPricesHistory(map.downTokenId, startTs, endTs)
    ]);
    const upH   = lastPriceFromHistory(upHist);
    const downH = lastPriceFromHistory(downHist);
    const inf2  = inferOutcomeFromFinalPrices(upH, downH, 0.90);
    return { outcome:inf2.outcome, method:"clob-prices-history", settled:inf2.settled, upLast:upH, downLast:downH };
  }

  return { outcome:null, method:"no-token-mapping", settled:false, error:map.error, upLast:null, downLast:null };
}

// ── Pool runner ───────────────────────────────────────────────────────────────
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
  for (let i=0; i<rounds.length; i++){
    const actual = rounds[i].resolvedOutcome;
    if (actual !== "Up" && actual !== "Down") continue;
    for (let n=minStreak; n<=maxStreak; n++){
      if (i - n < 0) continue;
      const prev = rounds.slice(i-n, i);
      if (prev.some(r => r.resolvedOutcome !== "Up" && r.resolvedOutcome !== "Down")) continue;
      const allUp   = prev.every(r => r.resolvedOutcome === "Up");
      const allDown = prev.every(r => r.resolvedOutcome === "Down");
      if (!allUp && !allDown) continue;
      const prevDir = allUp ? "Up" : "Down";
      const prediction = opposite(prevDir);
      signals.push({ n, ts:rounds[i].ts, slug:rounds[i].slug, prevDir, prediction, actual, correct: prediction===actual });
    }
  }
  return signals;
}

function summarize(signals, minStreak, maxStreak){
  const byN = {};
  for (let n=minStreak; n<=maxStreak; n++) byN[n] = { signals:0, wins:0, winRate:null };
  for (const s of signals){
    const b = byN[s.n];
    b.signals++;
    if (s.correct) b.wins++;
  }
  for (let n=minStreak; n<=maxStreak; n++){
    const b = byN[n];
    b.winRate = b.signals ? (b.wins / b.signals) : null;
  }
  return byN;
}

function latestNextPrediction(rounds, minStreak, maxStreak, roundSeconds){
  const resolved = rounds.filter(r => r.resolvedOutcome==="Up" || r.resolvedOutcome==="Down");
  if (!resolved.length) return null;
  const last = resolved[resolved.length - 1];
  const tail = resolved.map(r => r.resolvedOutcome);
  const suggestions = [];
  for (let n=minStreak; n<=maxStreak; n++){
    if (tail.length < n) continue;
    const window = tail.slice(-n);
    const allUp   = window.every(x => x==="Up");
    const allDown = window.every(x => x==="Down");
    if (!allUp && !allDown) continue;
    const prevDir = allUp ? "Up" : "Down";
    suggestions.push({ n, prevDir, predictNext:opposite(prevDir), nextTs:last.ts + roundSeconds });
  }
  return suggestions.length ? { lastResolvedSlug:last.slug, lastResolvedTs:last.ts, suggestions } : null;
}

// ── getLatestSlugs ────────────────────────────────────────────────────────────
// Base slug = liveTs - roundSeconds. Always deterministic — no resolution check.
// inferResolvedOutcome handles resolution per-round during the backtest itself.
// Checking resolution here caused lag: if the most recent window just closed and
// Gamma/CLOB haven't settled yet, it would silently fall back to one window older.
export async function getLatestSlugs({ prefix="btc-updown-5m-", roundSeconds=300 } = {}){
  const nowTs  = Math.floor(Date.now() / 1000);
  const liveTs = Math.floor(nowTs / roundSeconds) * roundSeconds;

  const latestExistingSlug = prefix + String(liveTs);
  const latestResolvedSlug = prefix + String(liveTs - roundSeconds); // most recently closed window
  const nextSlug           = prefix + String(liveTs + roundSeconds);

  return { latestExistingSlug, latestResolvedSlug, nextSlug };
}

// ── runBacktest ───────────────────────────────────────────────────────────────
export async function runBacktest({ baseSlug, useLatest=false,
  count=100, offset=1, minStreak=2, maxStreak=8,
  roundSeconds=300, concurrency=3, stripCount=12, signalsLimit=25
}){
  const cnt    = clampInt(count,        2,   300, 100);
  const off    = clampInt(offset,       0,   120,   1);
  const minS   = clampInt(minStreak,    1,   500,   2);
  const maxS   = clampInt(maxStreak,  minS,  500,   8);
  const rs     = clampInt(roundSeconds, 60,  3600, 300);
  const conc   = clampInt(concurrency,  1,     8,   3);
  const stripN = clampInt(stripCount,   4,    40,  12);
  const sigLim = clampInt(signalsLimit, 0,   200,  25);

  let resolvedBaseSlug = String(baseSlug ?? "").trim();
  if (!resolvedBaseSlug || useLatest){
    const latest = await getLatestSlugs({ prefix:"btc-updown-5m-", roundSeconds:rs });
    resolvedBaseSlug = latest.latestResolvedSlug || latest.latestExistingSlug;
    if (!resolvedBaseSlug){
      return { error:"Could not determine a baseSlug.", latest };
    }
  }

  const base = parseSlug(resolvedBaseSlug);

  const slugs = [];
  for (let i=0; i<cnt; i++){
    const t = base.ts - (off + i) * rs;
    slugs.push({ slug:makeSlug(base.prefix, t), ts:t });
  }

  const errorCounts = new Map();
  const sampleErrors = [];
  const bumpErr = (key, slug, msg) => {
    errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
    if (sampleErrors.length < 10 && slug && msg) sampleErrors.push({ slug, error:msg });
  };

  const rounds = await withPool(slugs, async ({ slug, ts })=>{
    try{
      const market = await fetchMarketBySlug(slug);
      const inf    = await inferResolvedOutcome(market, ts);
      if (inf.error) bumpErr(inf.method || "inferResolvedOutcome", slug, inf.error);
      return { slug, ts, resolvedOutcome:inf.outcome, method:inf.method, settled:inf.settled, upFinalPrice:inf.upLast, downFinalPrice:inf.downLast };
    } catch(e){
      bumpErr("fetchOrInfer", slug, String(e?.message ?? e));
      return { slug, ts, resolvedOutcome:null, error:String(e?.message ?? e) };
    }
  }, conc);

  rounds.sort((a,b)=>a.ts-b.ts);

  const signals        = computeSignals(rounds, minS, maxS);
  const byN            = summarize(signals, minS, maxS);
  const nextPrediction = latestNextPrediction(rounds, minS, maxS, rs);

  const topErrors   = Array.from(errorCounts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([key,count])=>({ key, count }));
  const totalErrors = Array.from(errorCounts.values()).reduce((a,b)=>a+b, 0);

  // Round strip: last N past rounds + base slug (the anchor, not in rounds) + current live window
  const nowTs       = Math.floor(Date.now() / 1000);
  const liveTs      = Math.floor(nowTs / rs) * rs;
  const currentSlug = makeSlug(base.prefix, liveTs);

  const tail = rounds.slice(-stripN).map(r=>({
    kind:"past", slug:r.slug, ts:r.ts, outcome:r.resolvedOutcome, method:r.method
  }));

  // The base slug itself (e.g. 1:45-1:50) is the anchor used to build the backtest
  // but is never included in rounds (rounds start at base.ts - offset*rs).
  // Fetch and insert it so there's no gap before the current live chip.
  let baseRound = null;
  if (base.ts < liveTs) {
    try {
      const baseMarket = await fetchMarketBySlug(resolvedBaseSlug);
      const baseInf    = await inferResolvedOutcome(baseMarket, base.ts);
      baseRound = { kind:"past", slug:resolvedBaseSlug, ts:base.ts, outcome:baseInf.outcome, method:baseInf.method };
    } catch {}
  }

  const roundStrip = [
    ...tail,
    ...(baseRound ? [baseRound] : []),
    { kind:"current", slug:currentSlug, ts:liveTs, outcome:null, method:"current" }
  ];

  // Deduplicate by timestamp — keep only the highest N (longest streak) per round.
  // Without this, a round with a 6-streak before it generates 5 rows (N=2..6) for the same ts.
  const signalsByTs = new Map();
  for (const s of signals){
    const existing = signalsByTs.get(s.ts);
    if (!existing || s.n > existing.n) signalsByTs.set(s.ts, s);
  }
  const recentSignals = sigLim === 0 ? [] : Array.from(signalsByTs.values()).sort((a,b)=>b.ts-a.ts).slice(0, sigLim);

  return {
    input: { baseSlug:resolvedBaseSlug, count:cnt, offset:off, minStreak:minS, maxStreak:maxS, roundSeconds:rs, concurrency:conc },
    totals: {
      rounds: rounds.length,
      resolvedRounds: rounds.filter(r=>r.resolvedOutcome==="Up"||r.resolvedOutcome==="Down").length,
      signals: signals.length
    },
    byN,
    nextPrediction,
    visual: { stripMeta:`stripCount=${stripN}, current=grey`, roundStrip, recentSignals },
    diagnostics: { totalErrors, topErrors, sampleErrors }
  };
}