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
    const minStreak = Number(url.searchParams.get("minStreak") ?? 3);
    const maxStreak = Number(url.searchParams.get("maxStreak") ?? 8);
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
    const concurrency = Number(url.searchParams.get("concurrency") ?? 4);

    const result = await runBacktest({ baseSlug, count, offset, minStreak, maxStreak, roundSeconds, concurrency });
    res.status(result?.error ? 500 : 200).json(result);
  } catch(e){
    res.status(500).json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
}