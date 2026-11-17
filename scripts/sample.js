// A synthetic snapshot for testing the bath and the page without the network.
// It is NOT real data: wallets and transactions are random.
//   node scripts/sample.js > data/sample.json
const L = require("../lib");
let seed = 7;
const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x6d2b79f5 >>> 0) / 4294967296);
const hex = n => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(rnd() * 16)]).join("");
const now = Math.floor(Date.parse("2026-11-17T15:00:00Z") / 1000);
const wallets = Array.from({ length: 260 }, () => "0x" + hex(40));
const prices = { psoe: 0.19, pp: 0.81, vox: 0.004 };
const mix = [["pp", 0.34], ["psoe", 0.3], ["-pp", 0.08], ["-psoe", 0.08], ["vox", 0.06], ["-vox", 0.14]];
const pick = () => { let r = rnd(), a = 0; for (const [k, w] of mix) { a += w; if (r < a) return k; } return "pp"; };
const trades = [];
for (let i = 0; i < 900; i++) {
  const w = wallets[Math.floor(Math.pow(rnd(), 1.6) * wallets.length)];
  const usd = Math.round(Math.exp(rnd() * 7.5) * 100) / 100;
  trades.push([now - Math.floor(rnd() * 86400), w, usd, pick(), "0x" + hex(64)]);
}
trades.push([now - 5 * 3600, wallets[3], 7200, "vox", "0x" + hex(64)]);
trades.push([now - 9 * 3600, wallets[11], 12500, "pp", "0x" + hex(64)]);
trades.push([now - 2 * 3600, wallets[40], 2400, "-psoe", "0x" + hex(64)]);
trades.sort((a, b) => a[0] - b[0]);
const priceHistory = [];
for (let h = 24; h >= 0; h--) {
  const t = Math.floor((now - h * 3600) / 3600);
  priceHistory.push([t, { psoe: +(0.2 + 0.03 * Math.sin(h / 4)).toFixed(4), pp: +(0.8 - 0.03 * Math.sin(h / 4)).toFixed(4), vox: 0.004 }]);
}
const anomalies = [
  { kind: "whale", wallet: wallets[3], backs: "vox", usd: 7200, ts: now - 5 * 3600, tx: null, note: "$7,200 bet on Vox within an hour" },
  { kind: "whale", wallet: wallets[11], backs: "pp", usd: 12500, ts: now - 9 * 3600, tx: null, note: "$12,500 bet on PP within an hour" },
  { kind: "fresh", wallet: wallets[40], backs: "-psoe", usd: 2400, ts: now - 2 * 3600, tx: null, ageDays: 1.2, note: "wallet first active 1.2 days ago, staked $2,400 against PSOE" },
  { kind: "swing", wallet: null, backs: "pp", points: 3.4, usd: 0, ts: now - 7 * 3600, tx: null, note: "PP odds moved up 3.4 points in an hour" },
];
const compact = trades;
console.log(JSON.stringify({
  v: 3, id: new Date(now * 1000).toISOString().slice(0, 13) + "Z", ts: now, at: new Date(now * 1000).toISOString(), final: false,
  sample: true,
  event: { slug: L.CONFIG.eventSlug, title: "Spain General Election Winner" },
  palette: L.CONFIG.palette,
  candidates: L.CONFIG.candidates.map(c => ({ key: c.key, label: c.label, price: prices[c.key] })),
  prices, priceHistory, totals: L.sideTotals(compact), anomalies, newAnomalies: 0, contracts: L.CONTRACTS, trades: compact,
}));
