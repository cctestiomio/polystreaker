// api/stats.js
import { runBacktest } from "../lib/backtest-core.js";

export const config = { runtime: "nodejs" };

export default async function handler(request) {
  const url = new URL(request.url);

  const baseSlug = url.searchParams.get("baseSlug") ?? "btc-updown-5m-1771290300";
  const count = Number(url.searchParams.get("count") ?? 40);        // default lower for Vercel
  const minStreak = Number(url.searchParams.get("minStreak") ?? 3);
  const maxStreak = Number(url.searchParams.get("maxStreak") ?? 8);
  const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
  const concurrency = Number(url.searchParams.get("concurrency") ?? 4);

  const result = await runBacktest({ baseSlug, count, minStreak, maxStreak, roundSeconds, concurrency });

  return Response.json(result, {
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
