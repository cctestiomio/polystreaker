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