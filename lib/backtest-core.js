// lib/backtest-core.js
// Data sources:
// - Gamma: https://gamma-api.polymarket.com/markets/slug/{slug}
// - CLOB prices history: https://clob.polymarket.com/prices-history (tokenId, startTs/endTs or interval) [Polymarket docs]

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
        headers: { accept: "application/json", "user-agent":"polystreaker/1.1" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
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

function normalizeUpDown(x){
  const s = String(x ?? "").trim().toLowerCase();
  if (s === "up") return "Up";
  if (s === "down") return "Down";
  if (s.includes(" up")) return "Up";
  if (s.includes("down")) return "Down";
  return null;
}

function tryOutcomeFromGammaMarket(market){
  // Heuristics: different Gamma objects expose resolution differently.
  const outcomes = market?.outcomes ?? market?.market?.outcomes;
  const prices = market?.outcomePrices ?? market?.outcome_prices ?? market?.market?.outcomePrices ?? market?.market?.outcome_prices;
  const resolvedFlag = market?.resolved ?? market?.market?.resolved ?? market?.isResolved ?? market?.market?.isResolved;

  // If a direct outcome/winner field exists:
  const direct =
    market?.winningOutcome ?? market?.winning_outcome ??
    market?.winner ?? market?.outcome ?? market?.result ??
    market?.market?.winningOutcome ?? market?.market?.winner ?? market?.market?.outcome;

  const directNorm = normalizeUpDown(direct);
  if (directNorm) return { outcome: directNorm, source: "gamma-direct" };

  // If market is resolved and outcomePrices line up with outcomes, pick max index.
  if (resolvedFlag && Array.isArray(outcomes) && Array.isArray(prices) && outcomes.length === prices.length){
    let bestI = 0, bestP = -Infinity;
    for (let i=0;i<prices.length;i++){
      const p = Number(prices[i]);
      if (Number.isFinite(p) && p > bestP){ bestP = p; bestI = i; }
    }
    const norm = normalizeUpDown(outcomes[bestI]);
    if (norm) return { outcome: norm, source: "gamma-outcomePrices" };
  }

  return { outcome: null, source: null };
}

function mapOutcomeToTokenIds(market){
  const outcomes = market?.outcomes ?? market?.market?.outcomes;
  const clobTokenIds = market?.clobTokenIds ?? market?.clob_token_ids ?? market?.market?.clobTokenIds ?? market?.market?.clob_token_ids;

  if (!Array.isArray(outcomes) || !Array.isArray(clobTokenIds) || outcomes.length !== clobTokenIds.length){
    throw new Error("Missing outcomes/clobTokenIds mapping");
  }

  const pairs = outcomes.map((o,i)=>({ outcome:String(o), tokenId:String(clobTokenIds[i]) }));
  const up = pairs.find(x=>String(x.outcome).toLowerCase()==="up" || /\bup\b/i.test(x.outcome));
  const down = pairs.find(x=>String(x.outcome).toLowerCase()==="down" || /\bdown\b/i.test(x.outcome));
  if (!up || !down) throw new Error("Could not find Up/Down in outcomes: " + JSON.stringify(outcomes));
  return { upTokenId: up.tokenId, downTokenId: down.tokenId };
}

async function fetchPricesHistory(tokenId, startTs, endTs){
  // Polymarket docs: /prices-history supports tokenId + startTs/endTs (or interval), fidelity in minutes.
  const paramsA = new URLSearchParams({ tokenId: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
  const urlA = `${clobBase}/prices-history?${paramsA.toString()}`;
  try {
    return await fetchJson(urlA, { retries: 2, timeoutMs: 9000 });
  } catch {
    // Fallback param name
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
  // Some APIs return separate arrays; try to detect minimal shapes
  if (j?.history && Array.isArray(j.history.p) && j.history.p.length){
    const p = Number(j.history.p[j.history.p.length - 1]);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

function inferOutcomeFromFinalPrices(upLast, downLast){
  if (upLast == null || downLast == null) return { outcome: null, settled: false };
  const outcome = upLast >= downLast ? "Up" : "Down";

  // settled-ish check: winner near 1 and loser near 0
  const hi = Math.max(upLast, downLast);
  const lo = Math.min(upLast, downLast);
  const settled = (hi >= 0.90 && lo <= 0.10);

  return { outcome, settled };
}

async function inferResolvedOutcome(market, ts){
  // 1) Try Gamma fields first (fast, if present)
  const g = tryOutcomeFromGammaMarket(market);
  if (g.outcome) return { outcome: g.outcome, method: g.source, upLast: null, downLast: null, settled: true };

  // 2) Fall back to CLOB price-history
  const { upTokenId, downTokenId } = mapOutcomeToTokenIds(market);

  const startTs = ts - 1800; // 30m before
  const endTs = ts + 7200;   // 2h after
  const [upHist, downHist] = await Promise.all([
    fetchPricesHistory(upTokenId, startTs, endTs),
    fetchPricesHistory(downTokenId, startTs, endTs)
  ]);

  const upLast = lastPriceFromHistory(upHist);
  const downLast = lastPriceFromHistory(downHist);
  const { outcome, settled } = inferOutcomeFromFinalPrices(upLast, downLast);

  return { outcome: settled ? outcome : null, method: "clob-prices-history", upLast, downLast, settled };
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
      signals.push({
        n,
        ts: rounds[i].ts,
        slug: rounds[i].slug,
        prevDir,
        prediction,
        actual,
        correct: prediction === actual
      });
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

export async function getLatestSlugs({ prefix="btc-updown-5m-", roundSeconds=300, lookbackSteps=72 } = {}){
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
      // Try to see if it resolves (Gamma direct OR price-history settled)
      try{
        const inf = await inferResolvedOutcome(m, t);
        if (inf.outcome){
          latestResolvedSlug = slug;
          break;
        }
      } catch {
        // ignore resolution failure for latest scan
      }
    } catch {
      // does not exist; keep looking back
    }
    t -= roundSeconds;
  }

  return { latestExistingSlug, latestResolvedSlug, nextSlug };
}

export async function runBacktest({
  baseSlug,
  count=100,
  offset=1,
  minStreak=3,
  maxStreak=8,
  roundSeconds=300,
  concurrency=4
}){
  // Safety clamps (Vercel-friendly)
  const cnt = clampInt(count, 2, 200, 100);
  const off = clampInt(offset, 0, 50, 1);
  const minS = clampInt(minStreak, 1, 100, 3);
  const maxS = clampInt(maxStreak, minS, 100, 8);
  const rs = clampInt(roundSeconds, 60, 3600, 300);
  const conc = clampInt(concurrency, 1, 8, 4);

  let resolvedBaseSlug = String(baseSlug ?? "").trim();
  if (!resolvedBaseSlug){
    const latest = await getLatestSlugs({ prefix: "btc-updown-5m-", roundSeconds: rs, lookbackSteps: 96 });
    resolvedBaseSlug = latest.latestResolvedSlug || latest.latestExistingSlug;
    if (!resolvedBaseSlug){
      return { error: "Could not determine a baseSlug (no markets found in lookback window).", latest };
    }
  }

  const slugs = buildPreviousSlugs(resolvedBaseSlug, cnt, off, rs);

  const errorCounts = new Map();
  const bumpErr = (key) => errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);

  const rounds = await withPool(slugs, async ({ slug, ts })=>{
    try{
      const market = await fetchMarketBySlug(slug);
      try{
        const inf = await inferResolvedOutcome(market, ts);
        return {
          slug, ts,
          resolvedOutcome: inf.outcome,
          settled: inf.settled,
          method: inf.method,
          upFinalPrice: inf.upLast,
          downFinalPrice: inf.downLast
        };
      } catch (e2){
        bumpErr("inferResolvedOutcome");
        return { slug, ts, resolvedOutcome: null, error: "inferResolvedOutcome: " + String(e2?.message ?? e2) };
      }
    } catch (e){
      bumpErr("fetchMarketBySlug");
      return { slug, ts, resolvedOutcome: null, error: "fetchMarketBySlug: " + String(e?.message ?? e) };
    }
  }, conc);

  rounds.sort((a,b)=>a.ts-b.ts);

  const signals = computeSignals(rounds, minS, maxS);
  const byN = summarize(signals, minS, maxS);
  const nextPrediction = latestNextPrediction(rounds, minS, maxS, rs);

  // Diagnostics
  const topErrors = Array.from(errorCounts.entries())
    .sort((a,b)=>b[1]-a[1])
    .slice(0, 8)
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
    diagnostics: { totalErrors, topErrors }
  };
}