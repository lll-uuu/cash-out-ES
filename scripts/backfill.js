#!/usr/bin/env node
// Backfill: the market opened on 5 October 2026, weeks before Cash Out · España started collecting.
// This pulls every trade Polymarket's public API still returns for the three parties and writes one
// snapshot per day (the 24 hours up to 23:00 UTC), so the aggregate analysis covers the whole campaign.
//
//   node scripts/backfill.js            writes data/snapshots/<day>T23Z.json for each past day
//
// It never touches data/latest.json or data/index.json, so the live page and the hourly run are unaffected.
// Odds are reconstructed from the last traded price of each party's "Yes" in each hour.
// New-wallet flags are not computed here (they need one lookup per wallet); whales and swings are.
// The trades endpoint only pages back so far; the script reports the earliest trade it reached.
const fs = require("fs");
const path = require("path");
const L = require("../lib");

const GAMMA = "https://gamma-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1)); };

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "cash-out-espana/1.0 (artwork by Luiza Prado)" } }).catch(e => ({ ok: false, status: 0, e }));
    if (r.ok) return await r.json();
    if (r.status && r.status !== 429 && r.status < 500) { const err = new Error(`HTTP ${r.status} for ${url}`); err.status = r.status; throw err; }
    await sleep(1500 * (i + 1));
  }
  throw new Error("gave up on " + url);
}

async function allTrades(conditionId, market) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    let batch;
    try { batch = await getJSON(`${DATA}/trades?market=${conditionId}&limit=500&offset=${offset}&takerOnly=true`); }
    catch (e) { if (e.status) { console.warn(`  ${market}: the API stopped paging at offset ${offset} (${e.message})`); break; } throw e; }
    if (!Array.isArray(batch) || !batch.length) break;
    for (const t of batch) out.push({ ...t, market, size: Number(t.size), price: Number(t.price), timestamp: Number(t.timestamp) });
    if (batch.length < 500) break;
    await sleep(250);
  }
  return out;
}

(async () => {
  const events = await getJSON(`${GAMMA}/events?slug=${encodeURIComponent(L.CONFIG.eventSlug)}`);
  const ev = Array.isArray(events) ? events[0] : events;
  if (!ev) throw new Error("Event not found: " + L.CONFIG.eventSlug);
  const candidates = L.CONFIG.candidates.map(c => {
    const m = (ev.markets || []).find(m => c.match.test(m.groupItemTitle || m.question || ""));
    if (!m) throw new Error("No market found for " + c.label);
    return { key: c.key, label: c.label, conditionId: m.conditionId };
  });

  const trades = [];
  for (const c of candidates) {
    const t = await allTrades(c.conditionId, c.key);
    console.log(`${c.label}: ${t.length} trades, earliest ${t.length ? new Date(Math.min(...t.map(x => x.timestamp)) * 1000).toISOString() : "–"}`);
    trades.push(...t);
  }
  if (!trades.length) { console.log("no trades returned"); return; }
  trades.sort((a, b) => a.timestamp - b.timestamp);

  // hourly odds from the last traded price of each party's Yes
  const priceAt = new Map();   // hour -> { key: price }
  const last = {};
  let h0 = Math.floor(trades[0].timestamp / 3600), i = 0;
  const hEnd = Math.floor(Date.now() / 1000 / 3600);
  for (let h = h0; h <= hEnd; h++) {
    while (i < trades.length && trades[i].timestamp < (h + 1) * 3600) {
      const t = trades[i++];
      last[t.market] = String(t.outcome).toLowerCase() === "yes" ? t.price : 1 - t.price;
    }
    if (Object.keys(last).length) priceAt.set(h, Object.fromEntries(candidates.map(c => [c.key, last[c.key] != null ? Number(last[c.key].toFixed(4)) : null])));
  }

  const today = Math.floor(Date.now() / 1000 / 86400) * 86400;
  const firstDay = Math.floor(trades[0].timestamp / 86400) * 86400;
  let written = 0;
  for (let day = firstDay; day < today; day += 86400) {
    const ts = day + 23 * 3600, since = ts - L.CONFIG.windowHours * 3600;
    const win = trades.filter(t => t.timestamp >= since && t.timestamp <= ts);
    if (!win.length) continue;
    const id = new Date(ts * 1000).toISOString().slice(0, 13) + "Z";
    const prices = priceAt.get(Math.floor(ts / 3600)) || {};
    const priceHistory = [];
    for (let h = Math.floor(since / 3600); h <= Math.floor(ts / 3600); h++) if (priceAt.has(h)) priceHistory.push([h, priceAt.get(h)]);
    const anomalies = L.detectWhalesRolling(win, since, ts + 1);
    for (let k = 1; k < priceHistory.length; k++) {
      for (const s of L.detectSwing(priceHistory[k - 1][1], priceHistory[k][1], priceHistory[k][0] * 3600)) anomalies.push(s);
    }
    anomalies.sort((a, b) => a.ts - b.ts);
    const compact = L.compactTrades(win, ts);
    writeJSON(`data/snapshots/${id}.json`, {
      v: 3, id, ts, at: new Date(ts * 1000).toISOString(), final: false, backfill: true,
      event: { slug: ev.slug, id: ev.id, title: ev.title },
      palette: L.CONFIG.palette,
      candidates: candidates.map(c => ({ key: c.key, label: c.label, price: prices[c.key], conditionId: c.conditionId })),
      prices, priceHistory, totals: L.sideTotals(compact), anomalies, newAnomalies: 0,
      contracts: L.CONTRACTS, trades: compact,
    });
    written++;
  }
  console.log(`wrote ${written} daily snapshots (backfill) from ${new Date(firstDay * 1000).toISOString().slice(0, 10)}`);
})().catch(e => { console.error(e); process.exit(1); });
