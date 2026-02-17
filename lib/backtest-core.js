// lib/backtest-core.js
const gammaBase = "https://gamma-api.polymarket.com";
const clobBase = "https://clob.polymarket.com";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

async function fetchJson(url, { retries = 3, backoffMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(backoffMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function fetchMarketBySlug(slug) {
  const u1 = `${gammaBase}/markets/slug/${encodeURIComponent(slug)}`;
  try {
    return await fetchJson(u1);
  } catch {
    const u2 = `${gammaBase}/markets?slug=${encodeURIComponent(slug)}&limit=1`;
    const j = await fetchJson(u2);
    if (Array.isArray(j) && j.length) return j[0];
    if (j && Array.isArray(j.markets) && j.markets.length) return j.markets[0];
    throw new Error("Could not fetch market for slug: " + slug);
  }
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
    return await fetchJson(urlA);
  } catch {
    const paramsB = new URLSearchParams({ token_id: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
    const urlB = `${clobBase}/prices-history?${paramsB.toString()}`;
    return await fetchJson(urlB);
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
  const startTs = approxEndTs - 3600;
  const endTs = approxEndTs + 7200;

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
  const slugs = buildSlugs(baseSlug, count, roundSeconds);

  const rounds = await withPool(slugs, async ({ slug, ts }) => {
    try {
      const market = await fetchMarketBySlug(slug);
      const { upTokenId, downTokenId } = mapOutcomeToTokenId(market);
      const inferred = await inferResolvedOutcomeFromPrices(upTokenId, downTokenId, ts);
      return { slug, ts, upTokenId, downTokenId, upFinalPrice: inferred.upLast, downFinalPrice: inferred.downLast, resolvedOutcome: inferred.outcome };
    } catch (e) {
      return { slug, ts, resolvedOutcome: null, error: String(e?.message ?? e) };
    }
  }, concurrency);

  rounds.sort((a, b) => a.ts - b.ts);

  const signals = computeSignals(rounds, minStreak, maxStreak);
  const byN = summarize(signals, minStreak, maxStreak);
  const nextPrediction = latestNextPrediction(rounds, minStreak, maxStreak, roundSeconds);

  return {
    input: { baseSlug, count, minStreak, maxStreak, roundSeconds, concurrency },
    totals: {
      rounds: rounds.length,
      resolvedRounds: rounds.filter(r => r.resolvedOutcome === "Up" || r.resolvedOutcome === "Down").length,
      signals: signals.length
    },
    byN,
    nextPrediction
  };
}
