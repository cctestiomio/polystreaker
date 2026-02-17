// src/backtest.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);
const baseSlug = String(args.baseSlug ?? "btc-updown-5m-1771290300");
const count = Number(args.count ?? 100);
const minStreak = Number(args.minStreak ?? 3);
const maxStreak = Number(args.maxStreak ?? 8);
const roundSeconds = Number(args.roundSeconds ?? 300);
const concurrency = Number(args.concurrency ?? 6);
const sleepMs = Number(args.sleepMs ?? 80);

const gammaBase = "https://gamma-api.polymarket.com";
const clobBase = "https://clob.polymarket.com";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function slugToPrefixAndTs(slug) {
  const parts = slug.split("-");
  const last = parts[parts.length - 1];
  const ts = Number(last);
  if (!Number.isFinite(ts)) throw new Error("Base slug must end with a unix timestamp: " + slug);
  const prefix = parts.slice(0, -1).join("-") + "-";
  return { prefix, ts };
}

function buildSlugs(baseSlug, count, roundSeconds) {
  const { prefix, ts } = slugToPrefixAndTs(baseSlug);
  const slugs = [];
  for (let i = 0; i < count; i++) {
    slugs.push({ slug: prefix + String(ts - i * roundSeconds), ts: ts - i * roundSeconds });
  }
  return slugs;
}

async function fetchJson(url, { retries = 4, backoffMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { "accept": "application/json" } });
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(backoffMs * Math.pow(2, i));
    }
  }
  throw lastErr;
}

async function fetchMarketBySlug(slug) {
  // Primary per docs: /markets/slug/{slug}
  const u1 = gammaBase + "/markets/slug/" + encodeURIComponent(slug);
  try {
    return await fetchJson(u1);
  } catch {
    // Fallback some deployments support /markets?slug=...
    const u2 = gammaBase + "/markets?slug=" + encodeURIComponent(slug) + "&limit=1";
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
    throw new Error("Market object missing outcomes/clobTokenIds mapping.");
  }

  const pairs = outcomes.map((o, i) => ({ outcome: String(o), tokenId: String(clobTokenIds[i]) }));
  const up = pairs.find(x => /^up$/i.test(x.outcome) || /\\bup\\b/i.test(x.outcome));
  const down = pairs.find(x => /^down$/i.test(x.outcome) || /\\bdown\\b/i.test(x.outcome));

  if (!up || !down) {
    // Try common binary YES/NO mapping if needed
    const yes = pairs.find(x => /^yes$/i.test(x.outcome));
    const no  = pairs.find(x => /^no$/i.test(x.outcome));
    if (yes && no) return { upTokenId: yes.tokenId, downTokenId: no.tokenId, outcomes, pairs, mappingNote: "Used YES=Up, NO=Down fallback." };
    throw new Error("Could not find Up/Down outcomes in: " + JSON.stringify(outcomes));
  }

  return { upTokenId: up.tokenId, downTokenId: down.tokenId, outcomes, pairs, mappingNote: "Matched outcome strings to token IDs." };
}

async function fetchPricesHistory(tokenId, startTs, endTs) {
  // Docs mention /prices-history with token id + timestamps OR interval.
  // Parameter names have varied; try tokenId then token_id fallback.
  const paramsA = new URLSearchParams({ tokenId: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
  const urlA = clobBase + "/prices-history?" + paramsA.toString();
  try {
    return await fetchJson(urlA);
  } catch {
    const paramsB = new URLSearchParams({ token_id: String(tokenId), startTs: String(startTs), endTs: String(endTs), fidelity: "1" });
    const urlB = clobBase + "/prices-history?" + paramsB.toString();
    return await fetchJson(urlB);
  }
}

function lastPriceFromHistory(j) {
  const hist = j?.history ?? j?.data ?? j?.prices ?? j?.priceHistory;
  if (!Array.isArray(hist) || hist.length === 0) return null;
  const last = hist[hist.length - 1];
  const p = Number(last?.p ?? last?.price ?? last?.[1]);
  if (!Number.isFinite(p)) return null;
  return p;
}

async function inferResolvedOutcomeFromPrices(upTokenId, downTokenId, approxEndTs) {
  // Pull a window around the slug timestamp to catch resolution/settlement.
  const startTs = approxEndTs - 3600; // 1h before
  const endTs = approxEndTs + 7200;   // 2h after

  const [upHist, downHist] = await Promise.all([
    fetchPricesHistory(upTokenId, startTs, endTs),
    fetchPricesHistory(downTokenId, startTs, endTs)
  ]);

  const upLast = lastPriceFromHistory(upHist);
  const downLast = lastPriceFromHistory(downHist);

  if (upLast == null || downLast == null) return { outcome: null, upLast, downLast };

  // Winning outcome should settle to ~1.0, losing to ~0.0; if not settled, still pick higher.
  const outcome = (upLast >= downLast) ? "Up" : "Down";
  return { outcome, upLast, downLast };
}

async function withPool(items, worker, max) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
      if (sleepMs > 0) await sleep(sleepMs);
    }
  });
  await Promise.all(runners);
  return results;
}

function toCsv(rows, headers) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\\n]/.test(s)) return "\"" + s.replace(/"/g, "\"\"") + "\"";
    return s;
  };
  const lines = [];
  lines.push(headers.map(esc).join(","));
  for (const r of rows) lines.push(headers.map(h => esc(r[h])).join(","));
  return lines.join("\\n") + "\\n";
}

function opposite(outcome) {
  if (outcome === "Up") return "Down";
  if (outcome === "Down") return "Up";
  return null;
}

function computeSignals(rounds, minStreak, maxStreak) {
  // rounds must be time-ascending
  const signals = [];
  for (let i = 0; i < rounds.length; i++) {
    const actual = rounds[i]?.resolvedOutcome;
    if (actual !== "Up" && actual !== "Down") continue;

    for (let n = minStreak; n <= maxStreak; n++) {
      if (i - n < 0) continue;
      const prev = rounds.slice(i - n, i);
      if (prev.some(x => x.resolvedOutcome !== "Up" && x.resolvedOutcome !== "Down")) continue;

      const allUp = prev.every(x => x.resolvedOutcome === "Up");
      const allDown = prev.every(x => x.resolvedOutcome === "Down");
      if (!allUp && !allDown) continue;

      const prevDir = allUp ? "Up" : "Down";
      const pred = opposite(prevDir);
      const correct = (pred === actual);

      signals.push({
        n,
        index: i,
        slug: rounds[i].slug,
        ts: rounds[i].ts,
        prevDir,
        prediction: pred,
        actual,
        correct: correct ? 1 : 0
      });
    }
  }
  return signals;
}

function summarize(signals, minStreak, maxStreak) {
  const byN = {};
  for (let n = minStreak; n <= maxStreak; n++) byN[n] = { signals: 0, wins: 0, winRate: null, upStreakSignals: 0, upStreakWins: 0, downStreakSignals: 0, downStreakWins: 0 };

  for (const s of signals) {
    const b = byN[s.n];
    b.signals++;
    b.wins += s.correct;
    if (s.prevDir === "Up") { b.upStreakSignals++; b.upStreakWins += s.correct; }
    if (s.prevDir === "Down") { b.downStreakSignals++; b.downStreakWins += s.correct; }
  }
  for (let n = minStreak; n <= maxStreak; n++) {
    const b = byN[n];
    b.winRate = b.signals ? (b.wins / b.signals) : null;
    b.upStreakWinRate = b.upStreakSignals ? (b.upStreakWins / b.upStreakSignals) : null;
    b.downStreakWinRate = b.downStreakSignals ? (b.downStreakWins / b.downStreakSignals) : null;
  }
  return byN;
}

function latestNextPrediction(rounds, minStreak, maxStreak, roundSeconds) {
  // Use the latest resolved rounds at the end of the series.
  const resolved = rounds.filter(r => r.resolvedOutcome === "Up" || r.resolvedOutcome === "Down");
  if (resolved.length === 0) return null;

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
    suggestions.push({
      n,
      prevDir,
      predictNext: opposite(prevDir),
      nextTs: last.ts + roundSeconds
    });
  }
  if (suggestions.length === 0) return null;
  return { lastResolvedSlug: last.slug, lastResolvedTs: last.ts, suggestions };
}

async function main() {
  console.log("Base slug:", baseSlug);
  console.log("Rounds:", count, "MinStreak:", minStreak, "MaxStreak:", maxStreak, "RoundSeconds:", roundSeconds);

  const outDir = path.join(process.cwd(), "out");
  ensureDir(outDir);

  const slugs = buildSlugs(baseSlug, count, roundSeconds);

  const rounds = await withPool(slugs, async (it) => {
    const { slug, ts } = it;
    try {
      const market = await fetchMarketBySlug(slug);
      const map = mapOutcomeToTokenId(market);

      const inferred = await inferResolvedOutcomeFromPrices(map.upTokenId, map.downTokenId, ts);

      return {
        slug,
        ts,
        upTokenId: map.upTokenId,
        downTokenId: map.downTokenId,
        upFinalPrice: inferred.upLast,
        downFinalPrice: inferred.downLast,
        resolvedOutcome: inferred.outcome,
        mappingNote: map.mappingNote
      };
    } catch (e) {
      return {
        slug,
        ts,
        upTokenId: null,
        downTokenId: null,
        upFinalPrice: null,
        downFinalPrice: null,
        resolvedOutcome: null,
        error: String(e?.message ?? e)
      };
    }
  }, concurrency);

  // Sort ascending for backtest chronology
  rounds.sort((a, b) => a.ts - b.ts);

  const signals = computeSignals(rounds, minStreak, maxStreak);
  const summaryByN = summarize(signals, minStreak, maxStreak);
  const nextPred = latestNextPrediction(rounds, minStreak, maxStreak, roundSeconds);

  // Write files
  fs.writeFileSync(path.join(outDir, "rounds.csv"),
    toCsv(rounds, ["ts","slug","resolvedOutcome","upTokenId","downTokenId","upFinalPrice","downFinalPrice","mappingNote","error"]),
    "utf8"
  );

  fs.writeFileSync(path.join(outDir, "signals.csv"),
    toCsv(signals, ["n","ts","slug","prevDir","prediction","actual","correct"]),
    "utf8"
  );

  const summary = {
    input: { baseSlug, count, minStreak, maxStreak, roundSeconds },
    totals: {
      rounds: rounds.length,
      resolvedRounds: rounds.filter(r => r.resolvedOutcome === "Up" || r.resolvedOutcome === "Down").length,
      signals: signals.length
    },
    byN: summaryByN,
    nextPrediction: nextPred
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  // Human readable markdown
  const lines = [];
  lines.push("# Streak-to-opposite backtest");
  lines.push("");
  lines.push("## Win rates by N");
  lines.push("");
  lines.push("| N | Signals | Wins | Win rate | Up-streak win rate | Down-streak win rate |");
  lines.push("|---:|---:|---:|---:|---:|---:|");
  for (let n = minStreak; n <= maxStreak; n++) {
    const b = summaryByN[n];
    const fmt = (x) => (x == null ? "n/a" : (100 * x).toFixed(2) + "%");
    lines.push(`| ${n} | ${b.signals} | ${b.wins} | ${fmt(b.winRate)} | ${fmt(b.upStreakWinRate)} | ${fmt(b.downStreakWinRate)} |`);
  }

  lines.push("");
  lines.push("## Latest next-round suggestions");
  lines.push("");
  if (!nextPred) {
    lines.push("No current N-in-a-row streak detected in the latest resolved rounds.");
  } else {
    lines.push(`Last resolved slug: \`${nextPred.lastResolvedSlug}\` (ts=${nextPred.lastResolvedTs})`);
    lines.push("");
    lines.push("| N | Previous N were | Predict next | Next ts |");
    lines.push("|---:|---|---|---:|");
    for (const s of nextPred.suggestions) {
      lines.push(`| ${s.n} | ${s.prevDir} | ${s.predictNext} | ${s.nextTs} |`);
    }
  }

  fs.writeFileSync(path.join(outDir, "summary.md"), lines.join("\\n") + "\\n", "utf8");

  // Console output
  console.log("");
  console.log("Resolved rounds:", summary.totals.resolvedRounds, "/", summary.totals.rounds);
  console.log("Total signals:", summary.totals.signals);
  console.log("");
  console.log("Win rates by N:");
  for (let n = minStreak; n <= maxStreak; n++) {
    const b = summaryByN[n];
    const wr = b.winRate == null ? "n/a" : (100 * b.winRate).toFixed(2) + "%";
    console.log(`  N=${n}: signals=${b.signals}, wins=${b.wins}, winRate=${wr}`);
  }
  console.log("");
  console.log("Wrote:");
  console.log("  out/rounds.csv");
  console.log("  out/signals.csv");
  console.log("  out/summary.json");
  console.log("  out/summary.md");
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});