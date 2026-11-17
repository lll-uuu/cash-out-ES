// Cash Out · España. Pure logic shared by the hourly collector and any offline tools.
// No network here: functions take plain trade objects and return plain data.

const CONFIG = {
  eventSlug: "spain-general-election-winner",   // Polymarket: "Spain General Election Winner" (most seats, 29 Nov 2026)
  // The parties. The key names the ink family in the engine; "dir" is the direction its odds comb the bath.
  candidates: [
    { key: "psoe", match: /psoe|socialist/i,              label: "PSOE", dir: [0, 1] },
    { key: "pp",   match: /^\s*pp\b|partido popular|people/i, label: "PP",   dir: [1, 0] },
    { key: "vox",  match: /\bvox\b/i,                     label: "Vox",  dir: [0.7071, 0.7071] },
  ],
  windowHours: 24,          // each frame marbles the last 24 hours of trades
  palette: "espana",        // "espana" or "contracts"
  timeZone: "Europe/Madrid",
  whaleUsd: 5000,           // a wallet moving at least this much in one hour pours pearl ink
  freshWalletDays: 7,       // a wallet whose first Polymarket activity is this recent is "fresh"
  freshMinUsd: 1000,        // ...when it stakes at least this much in the hour
  swingPoints: 0.03,        // a 3-point move in one party's odds in an hour is a swing
  anomalyMemoryHours: 24,   // anomalies stay in the bath for this long
  // The last frame: polls close at 20:00 local time. The Canary Islands close last, at 20:00 WET = 20:00 UTC
  // on Sunday 29 November (21:00 in Madrid).
  finalAt: "2026-11-29T20:00:00Z",
};
// Contracts the bets settle through. Their addresses double as colours.
const CONTRACTS = {
  collateral: { name: "pUSD collateral token", address: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" },
  exchange:   { name: "Neg Risk CTF Exchange", address: "0xe2222d279d744050d28e00520010520000310F59" },
  ctf:        { name: "Conditional Tokens",     address: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" },
};

const usd = t => Number(t.size) * Number(t.price);

// Which party a trade backs, and in which direction.
// Buying Yes or selling No on a party backs it: returns "vox".
// Buying No or selling Yes bets against it: returns "-vox". With three or more parties a bet against one
// is not a bet for any other, so it keeps its own (dimmed) ink.
function backedCandidate(trade, marketKey) {
  const yes = String(trade.outcome).toLowerCase() === "yes";
  const buy = String(trade.side).toUpperCase() === "BUY";
  return yes === buy ? marketKey : "-" + marketKey;
}
const partyOf = side => String(side).replace(/^-/, "");
const isAgainst = side => String(side).startsWith("-");

// The window's trades in the compact form the engine reads: [ts, wallet, usd, backs, tx]
function compactTrades(trades, nowTs) {
  const since = nowTs - CONFIG.windowHours * 3600;
  return trades
    .filter(t => t.timestamp >= since && t.timestamp <= nowTs && /^0x[0-9a-f]{40}$/i.test(t.proxyWallet || ""))
    .map(t => [t.timestamp, t.proxyWallet.toLowerCase(), round2(usd(t)), backedCandidate(t, t.market), t.transactionHash || null])
    .sort((a, b) => a[0] - b[0]);
}

// Wallets and money on each side of a compact trade list.
function sideTotals(compact) {
  const out = {};
  for (const c of CONFIG.candidates) for (const k of [c.key, "-" + c.key]) out[k] = { wallets: new Set(), usd: 0, trades: 0 };
  for (const [, w, u, side] of compact) { if (!out[side]) continue; out[side].wallets.add(w); out[side].usd += u; out[side].trades++; }
  for (const k in out) out[k] = { wallets: out[k].wallets.size, usd: round2(out[k].usd), trades: out[k].trades };
  return out;
}

// Large movers in [fromTs, toTs). Returns per-wallet hour totals with their biggest tx.
function hourlyMovers(trades, fromTs, toTs) {
  const m = new Map();
  for (const t of trades) {
    if (t.timestamp < fromTs || t.timestamp >= toTs) continue;
    const w = (t.proxyWallet || "").toLowerCase();
    const backs = backedCandidate(t, t.market);
    const k = w + "|" + backs;
    const cur = m.get(k) || { wallet: w, backs, usd: 0, maxTx: null, maxUsd: 0, ts: t.timestamp };
    const u = usd(t);
    cur.usd += u;
    if (u > cur.maxUsd) { cur.maxUsd = u; cur.maxTx = t.transactionHash || null; cur.ts = t.timestamp; }
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.usd - a.usd);
}

function detectWhales(movers) {
  return movers
    .filter(x => x.usd >= CONFIG.whaleUsd)
    .map(x => ({
      kind: "whale", wallet: x.wallet, backs: x.backs, usd: round2(x.usd), ts: x.ts, tx: x.maxTx,
      note: `${fmtUsd(x.usd)} bet ${betOn(x.backs)} within an hour`,
    }));
}

// Whales over a whole window: a wallet that moves whaleUsd or more on one side within any 60-minute stretch.
// Returns one anomaly per such stretch (overlapping stretches of the same wallet count once).
function detectWhalesRolling(trades, fromTs, toTs) {
  const groups = new Map();
  for (const t of trades) {
    if (t.timestamp < fromTs || t.timestamp >= toTs) continue;
    const w = (t.proxyWallet || "").toLowerCase();
    const k = w + "|" + backedCandidate(t, t.market);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of groups) {
    const [wallet, backs] = k.split("|");
    list.sort((a, b) => a.timestamp - b.timestamp);
    let i = 0, sum = 0;
    for (let j = 0; j < list.length; j++) {
      sum += usd(list[j]);
      while (list[j].timestamp - list[i].timestamp >= 3600) { sum -= usd(list[i]); i++; }
      if (sum >= CONFIG.whaleUsd) {
        const win = list.slice(i, j + 1);
        // extend to the whole run of trades that keeps the total above the line
        let k2 = j, s2 = sum;
        while (k2 + 1 < list.length && list[k2 + 1].timestamp - list[i].timestamp < 3600) { k2++; s2 += usd(list[k2]); win.push(list[k2]); }
        const big = win.reduce((a, b) => (usd(b) > usd(a) ? b : a));
        out.push({
          kind: "whale", wallet, backs, usd: round2(s2), ts: big.timestamp, tx: big.transactionHash || null,
          note: `${fmtUsd(s2)} bet ${betOn(backs)} within an hour`,
        });
        // start looking again after this stretch
        i = k2 + 1; sum = 0; j = k2;
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// firstSeen: unix seconds of the wallet's first Polymarket activity (or null if unknown)
function detectFresh(mover, firstSeen, nowTs) {
  if (firstSeen == null || mover.usd < CONFIG.freshMinUsd) return null;
  const ageDays = (nowTs - firstSeen) / 86400;
  if (ageDays > CONFIG.freshWalletDays) return null;
  return {
    kind: "fresh", wallet: mover.wallet, backs: mover.backs, usd: round2(mover.usd), ts: mover.ts, tx: mover.maxTx,
    ageDays: round2(ageDays),
    note: `wallet first active ${ageDays < 1 ? Math.round(ageDays * 24) + " h" : ageDays.toFixed(1) + " days"} ago, staked ${fmtUsd(mover.usd)} ${betOn(mover.backs)}`,
  };
}

// prevPrices / prices: { psoe: 0.19, pp: 0.81, vox: 0.004 }. One anomaly per party that moved swingPoints or more.
function detectSwing(prevPrices, prices, nowTs) {
  if (!prevPrices) return [];
  const out = [];
  for (const c of CONFIG.candidates) {
    if (prevPrices[c.key] == null || prices[c.key] == null) continue;
    const d = prices[c.key] - prevPrices[c.key];
    if (Math.abs(d) < CONFIG.swingPoints) continue;
    out.push({
      kind: "swing", wallet: null, backs: d > 0 ? c.key : "-" + c.key, points: round2(Math.abs(d) * 100),
      usd: 0, ts: nowTs, tx: null,
      note: `${c.label} odds moved ${d > 0 ? "up" : "down"} ${(Math.abs(d) * 100).toFixed(1)} points in an hour`,
    });
  }
  return out;
}

function mergeAnomalies(prev, fresh, nowTs) {
  const keep = (prev || []).filter(a => nowTs - a.ts < CONFIG.anomalyMemoryHours * 3600);
  const key = a => `${a.kind}|${a.wallet || ""}|${a.tx || Math.floor(a.ts / 3600)}`;
  const seen = new Set(keep.map(key));
  for (const a of fresh) if (!seen.has(key(a))) { keep.push(a); seen.add(key(a)); }
  return keep.sort((a, b) => a.ts - b.ts);
}

const labelOf = k => {
  const c = CONFIG.candidates.find(c => c.key === partyOf(k));
  const name = c ? c.label : partyOf(k);
  return isAgainst(k) ? "against " + name : name;
};
const betOn = k => (isAgainst(k) ? "against " : "on ") + labelOf(partyOf(k));
const round2 = x => Math.round(x * 100) / 100;
const fmtUsd = x => "$" + Math.round(x).toLocaleString("en-US");

module.exports = {
  CONFIG, CONTRACTS, usd, backedCandidate, partyOf, isAgainst, compactTrades, sideTotals, hourlyMovers,
  detectWhales, detectWhalesRolling, detectFresh, detectSwing, mergeAnomalies, labelOf, fmtUsd,
};
