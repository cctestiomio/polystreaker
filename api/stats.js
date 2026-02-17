// api/stats.js
import { runBacktest } from "../lib/backtest-core.js";

export const config = { runtime: "nodejs" };


// Discord webhook helper
const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1467216362962161727/qDTCrFMNtUUaTIhw7jrr3z7W2FmyfNq6BaDHfvE2l3M9djE-oKRzSLlYVqX0_zjq0kxM";

async function sendDiscordAlert(message) {
  try {
    if (!DISCORD_WEBHOOK_URL) return;
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message })
    });
  } catch (e) {
    console.error("Discord webhook failed", e);
  }
}
export default async function handler(req, res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  try{
    const url = new URL(req.url, "http://localhost");

    const baseSlug = (url.searchParams.get("baseSlug") ?? "").trim();
    const useLatest = url.searchParams.get("useLatest") === "1";
    const count = Number(url.searchParams.get("count") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 1);
    const minStreak = Number(url.searchParams.get("minStreak") ?? 2);
    const maxStreak = Number(url.searchParams.get("maxStreak") ?? 8);
    const roundSeconds = Number(url.searchParams.get("roundSeconds") ?? 300);
    const concurrency = Number(url.searchParams.get("concurrency") ?? 3);
    const stripCount = Number(url.searchParams.get("stripCount") ?? 12);
    const signalsLimit = Number(url.searchParams.get("signalsLimit") ?? 25);

    const result = await runBacktest({ baseSlug, useLatest, count, offset, minStreak, maxStreak, roundSeconds, concurrency, stripCount, signalsLimit });
    res.status(result?.error ? 500 : 200).json(result);
  } catch(e){
    res.status(500).json({ error: String(e?.message ?? e), stack: String(e?.stack ?? "") });
  }
}