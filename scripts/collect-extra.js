#!/usr/bin/env node
// Extra markets: the money betting specifically on the far right's strength.
// The marbled image stays on "Spain General Election Winner"; these markets are only collected
// and analysed (scripts/extra-report.js). On the first run each market's whole history is pulled;
// after that only new trades.
//
//   node scripts/collect-extra.js        writes data/extra/<slug>.json
//
// Each file: { slug, title, markets: [{ outcome, conditionId, price }], trades: [[ts, wallet, usd, outcome, "yes"|"no", tx]] }
// "yes" = bought the outcome's Yes or sold its No; "no" = the reverse.
const fs = require("fs");
const path = require("path");
const L = require("../lib");

const EVENTS = [
  "spain-general-election-pp-vox-majority",
  "spain-general-election-pp-vox-get-50-of-vote",
  "spain-general-election-vox-of-vote",
  "spain-general-election-vox-of-seats",
  "spain-general-election-vox-wins-a-constituency",
];
const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const DIR = "data/extra";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "cash-out-espana/1.0 (artwork by Luiza Prado)" } }).catch(() => ({ ok: false, status: 0 }));
    if (r.ok) return await r.json();
    if (r.status && r.status !== 429 && r.status < 500) throw new Error(`HTTP ${r.status} for ${url}`);
    await sleep(1500 * (i + 1));
  }
  throw new Error("gave up on " + url);
}

const yesPrice = m => { try { return Number(JSON.parse(m.outcomePrices)[0]); } catch { return null; } };

async function collectEvent(slug) {
  const file = path.join(DIR, slug + ".json");
  const prev = readJSON(file, null);
  const evs = await getJSON(`${GAMMA}/events?slug=${slug}`);
  const ev = Array.isArray(evs) ? evs[0] : evs;
  if (!ev) { console.warn("not found: " + slug); return; }
  const markets = (ev.markets || []).map(m => ({ outcome: m.groupItemTitle || "Yes", conditionId: m.conditionId, price: yesPrice(m) }));
  const trades = prev ? prev.trades : [];
  const seen = new Set(trades.map(t => t.join("|")));
  const lastTs = trades.length ? Math.max(...trades.map(t => t[0])) : 0;
  let added = 0;
  for (const m of markets) {
    let cursor = null;
    for (let page = 0; page < 400; page++) {
      const j = await getJSON(`${DATA}/v2/trades?condition=${m.conditionId}&limit=500&takerOnly=true` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
      const batch = (j && j.data || []).map(L.fromV2);
      if (!batch.length) break;
      for (const t of batch) {
        if (!/^0x[0-9a-f]{40}$/i.test(t.proxyWallet || "")) continue;
        const yes = String(t.outcome).toLowerCase() === "yes", buy = String(t.side).toUpperCase() === "BUY";
        const row = [t.timestamp, t.proxyWallet.toLowerCase(), Math.round(t.size * t.price * 100) / 100, m.outcome, yes === buy ? "yes" : "no", t.transactionHash || null];
        const k = row.join("|");
        if (seen.has(k)) continue;
        seen.add(k); trades.push(row); added++;
      }
      cursor = L.nextCursor(j);
      // older than what we already have (minus an hour of overlap): stop
      if (!cursor || batch[batch.length - 1].timestamp < lastTs - 3600) break;
      await sleep(150);
    }
  }
  trades.sort((a, b) => a[0] - b[0]);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ slug, title: ev.title, updated: Math.floor(Date.now() / 1000), markets, trades }));
  console.log(`${slug}: +${added} trades (${trades.length} total)`);
}

(async () => {
  for (const slug of EVENTS) {
    try { await collectEvent(slug); } catch (e) { console.warn(slug + ": " + e.message); }
  }
})();
