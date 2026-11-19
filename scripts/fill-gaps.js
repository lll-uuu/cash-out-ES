#!/usr/bin/env node
// Fill gaps: rebuild the snapshot of any hour that has none.
// Every bet stays in the public record, so an hour skipped by GitHub (or by a failed run) can be
// rebuilt afterwards from the trades themselves: the 24 hours of bets up to that hour, with the odds
// taken from the last traded price of each party's "Yes". Rebuilt hours are marked "rebuilt": true.
// New-wallet flags need a lookup per wallet and are left out of rebuilt hours; whales and swings are kept.
//
//   node scripts/fill-gaps.js                 hours since hourly collection began (FIRST_HOUR below)
//   node scripts/fill-gaps.js --hours 48      only the last 48 hours
//
// It never touches data/latest.json. It adds the rebuilt hours to data/index.json, and lists their
// ids in data/.rebuilt (one per line) so the workflow can render their frames.
const fs = require("fs");
const path = require("path");
const L = require("../lib");

const FIRST_HOUR = "2026-11-17T19Z";   // the first hour collected live
const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };
const idOf = h => new Date(h * 3600 * 1000).toISOString().slice(0, 13) + "Z";
const hourOfId = id => Math.floor(Date.parse(id.replace(/Z$/, ":00:00Z")) / 3600000);

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "cash-out-espana/1.0 (artwork by Luiza Prado)" } }).catch(() => ({ ok: false, status: 0 }));
    if (r.ok) return await r.json();
    if (r.status && r.status !== 429 && r.status < 500) throw new Error(`HTTP ${r.status} for ${url}`);
    await sleep(1500 * (i + 1));
  }
  throw new Error("gave up on " + url);
}

async function tradesSince(conditionId, market, sinceTs) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 400; page++) {
    const j = await getJSON(`${DATA}/v2/trades?condition=${conditionId}&limit=500&takerOnly=true` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    const batch = (j && j.data || []).map(L.fromV2);
    if (!batch.length) break;
    for (const t of batch) out.push({ ...t, market });
    cursor = L.nextCursor(j);
    if (batch[batch.length - 1].timestamp < sinceTs || !cursor) break;
    await sleep(200);
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const nowH = Math.floor(Date.now() / 3600000);
  const finalH = Math.floor(Date.parse(L.CONFIG.finalAt) / 3600000);
  const lastH = Math.min(nowH - 1, finalH);            // the current hour belongs to the live run
  const hi = args.indexOf("--hours");
  const firstH = Math.max(hourOfId(FIRST_HOUR), hi >= 0 ? lastH - Number(args[hi + 1]) + 1 : -Infinity);

  const missing = [];
  for (let h = firstH; h <= lastH; h++) if (!fs.existsSync(`data/snapshots/${idOf(h)}.json`)) missing.push(h);
  fs.writeFileSync("data/.rebuilt", "");
  if (!missing.length) { console.log("no gaps"); return; }
  console.log(`${missing.length} missing hours: ${missing.map(idOf).join(", ")}`);

  const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(L.CONFIG.eventSlug)}`);
  const ev = Array.isArray(events) ? events[0] : events;
  const candidates = L.CONFIG.candidates.map(c => {
    const m = (ev.markets || []).find(m => c.match.test(m.groupItemTitle || m.question || ""));
    if (!m) throw new Error("No market found for " + c.label);
    return { key: c.key, label: c.label, conditionId: m.conditionId };
  });

  // bets from 24 hours before the first gap (its window) plus 2 more hours (for its odds) until now
  const since = (missing[0] - L.CONFIG.windowHours - 2) * 3600;
  const trades = [];
  for (const c of candidates) trades.push(...await tradesSince(c.conditionId, c.key, since));
  trades.sort((a, b) => a.timestamp - b.timestamp);
  console.log(`${trades.length} trades since ${new Date(since * 1000).toISOString()}`);

  // odds at the end of each hour, from the last traded price of each party's Yes
  const priceAt = new Map(), last = {};
  let i = 0;
  for (let h = Math.floor(since / 3600); h <= lastH; h++) {
    while (i < trades.length && trades[i].timestamp < (h + 1) * 3600) {
      const t = trades[i++];
      last[t.market] = String(t.outcome).toLowerCase() === "yes" ? t.price : 1 - t.price;
    }
    priceAt.set(h, Object.fromEntries(candidates.map(c => [c.key, last[c.key] != null ? Number(last[c.key].toFixed(4)) : null])));
  }
  // live hours keep the odds they recorded
  const index = readJSON("data/index.json", []);
  for (const r of index) if (r.prices && !r.rebuilt) priceAt.set(hourOfId(r.id), r.prices);

  const rebuilt = [];
  for (const h of missing) {
    const id = idOf(h), ts = h * 3600 + 5 * 60;      // as if the run had started five past the hour
    const from = ts - L.CONFIG.windowHours * 3600;
    const win = trades.filter(t => t.timestamp >= from && t.timestamp <= ts);
    const prices = priceAt.get(h) || {};
    const priceHistory = [];
    for (let k = Math.floor(from / 3600); k <= h; k++) if (priceAt.has(k)) priceHistory.push([k, priceAt.get(k)]);
    const anomalies = L.detectWhalesRolling(win, from, ts + 1);
    for (let k = 1; k < priceHistory.length; k++) anomalies.push(...L.detectSwing(priceHistory[k - 1][1], priceHistory[k][1], priceHistory[k][0] * 3600));
    anomalies.sort((a, b) => a.ts - b.ts);
    const compact = L.compactTrades(win, ts);
    const totals = L.sideTotals(compact);
    writeJSON(`data/snapshots/${id}.json`, {
      v: 3, id, ts, at: new Date(ts * 1000).toISOString(), final: false, rebuilt: true,
      event: { slug: ev.slug, id: ev.id, title: ev.title },
      palette: L.CONFIG.palette,
      candidates: candidates.map(c => ({ key: c.key, label: c.label, price: prices[c.key], conditionId: c.conditionId })),
      prices, priceHistory, totals, anomalies, newAnomalies: 0,
      contracts: L.CONTRACTS, trades: compact,
    });
    index.push({ id, ts, prices, rebuilt: true, wallets: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.wallets])), newAnomalies: [] });
    rebuilt.push(id);
    console.log(`rebuilt ${id}: ${compact.length} trades, ${anomalies.length} anomalies`);
  }
  index.sort((a, b) => a.ts - b.ts);
  writeJSON("data/index.json", index);
  fs.writeFileSync("data/.rebuilt", rebuilt.join("\n") + "\n");
})().catch(e => { console.error(e); process.exit(1); });
