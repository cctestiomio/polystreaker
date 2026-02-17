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
    const lookbackSteps = Number(url.searchParams.get("lookbackSteps") ?? 180);

    const j = await getLatestSlugs({ prefix, roundSeconds, lookbackSteps });
    res.status(200).json(j);
  } catch(e){
    res.status(500).json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
}