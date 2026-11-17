// Aggregate analysis of the money in Cash Out · España (general election, 29 November 2026).
// Report in Spanish (analysis/informe.md). Times in Madrid time.
//
// Reads every hourly snapshot the project has saved, looks up the public history of the
// largest and most unusual wallets, and writes a report about them as a group:
// when they bet, what else they bet on, roughly which time zones they keep, and how their
// money arrived on Polygon.
//
// It never publishes a wallet or funder address. Every figure is a sum or a count over a
// group, and any group smaller than MIN_GROUP wallets is folded into "other" or left out.
//
// Usage:  node analyze.js            (writes analysis/)
// Optional: ETHERSCAN_API_KEY=...    (free key from etherscan.io; enables the funding section)
//           CASHOUT_OFFLINE=1         (rebuild the report from analysis/cache.json without any network call)

const fs = require("fs");
const path = require("path");
const L = require("./lib.js");

const A = {
  bigWalletUsd: 5000,     // a wallet whose total stake on the election reaches this counts as a big bettor
  baselineSample: 150,    // ordinary wallets sampled for comparison
  maxActivity: 3000,      // history items read per wallet
  refreshDays: 60,         // re-read a wallet's history after this long
  minGroup: 3,            // suppress any figure that describes fewer wallets than this
  beforeSwingHours: 2,    // how far back to look for money placed ahead of a swing
};

const DATA = "data", OUT = "analysis", CACHE = path.join(OUT, "cache.json"), FUNDERS = path.join(OUT, "funders.json");
const API = "https://data-api.polymarket.com";
const ESCAN = "https://api.etherscan.io/v2/api?chainid=137";
const KEY = process.env.ETHERSCAN_API_KEY || "";
const OFFLINE = !!process.env.CASHOUT_OFFLINE;
// Public name tags of services (Polymarket contracts, exchanges, bridges, swaps), checked by hand on Polygonscan.
// Only services go here, never personal wallets.
const LABELS = fs.existsSync(path.join("analysis", "labels.json")) ? JSON.parse(fs.readFileSync(path.join("analysis", "labels.json"), "utf8")) : {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hourOf = ts => Math.floor(ts / 3600) * 3600;
const iso = ts => new Date(ts * 1000).toISOString().slice(0, 13) + "Z";
// Madrid local time (CET in November), via the time zone database rather than a fixed offset
const TZ = L.CONFIG.timeZone || "Europe/Madrid";
const madParts = ts => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  .formatToParts(new Date(ts * 1000)).map(p => [p.type, p.value]));
const mad = ts => { const p = madParts(ts); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
const madDay = ts => { const p = madParts(ts); return `${p.year}-${p.month}-${p.day}`; };
const madHour = ts => Number(madParts(ts).hour);
const SIDES = L.CONFIG.candidates.flatMap(c => [c.key, "-" + c.key]);
const sideName = k => (L.isAgainst(k) ? "contra " : "") + L.labelOf(L.partyOf(k));
const r2 = x => Math.round(x * 100) / 100;
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

// Stablecoins money arrives in, and Polymarket's own contracts (not "funders").
const STABLES = /^(usdc|usdc\.e|pusd|usdt|usdt0|dai)$/i;
const INTERNAL = new Set([
  "0x0000000000000000000000000000000000000000",
  ...Object.values(L.CONTRACTS).map(c => c.address.toLowerCase()),
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", // CTF Exchange
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296", // Neg Risk Adapter
]);

// Broad areas for "other markets". First match wins.
const AREAS = [
  ["España", /spain|spanish|españa|espana|s[aá]nchez|feij[oó]o|abascal|\bvox\b|psoe|partido popular|sumar|podemos|catalonia|catalu|andaluc|madrid|basque|galicia/i],
  ["Brasil", /brazil|brasil|lula|bolsonaro|tarc[ií]sio|caiado|ratinho|zema|selic|ibovespa/i],
  ["Política de EE. UU.", /trump|biden|vance|newsom|harris|senate|house|congress|governor|mayor|republican|democrat|supreme court|us election|presidential election 2028|government shutdown|tariff/i],
  ["Otras elecciones europeas", /france|french|le pen|bardella|germany|german|afd|merz|italy|meloni|portugal|chega|netherlands|wilders|hungary|orb[aá]n|poland|uk |reform uk|farage|austria|fp[oö]|eu parliament/i],
  ["Guerra y geopolítica", /iran|israel|gaza|hamas|hezbollah|ukraine|russia|putin|zelensky|china|taiwan|strike|ceasefire|war|missile|nato|venezuela|maduro|military/i],
  ["Otras elecciones", /election|elect|prime minister|president of|parliament|referendum|vote/i],
  ["Economía", /fed |fed\b|interest rate|rates|inflation|cpi|recession|gdp|jobs report|unemployment|s&p|nasdaq|stock|ipo|earnings/i],
  ["Cripto", /bitcoin|btc|ethereum|eth\b|solana|sol\b|crypto|xrp|doge|memecoin|token|airdrop|fdv/i],
  ["Deporte", /\bvs\.?\b|nfl|nba|mlb|nhl|ufc|premier league|champions league|la liga|serie a|bundesliga|world cup|copa|libertadores|f1|grand prix|tennis|open|super bowl|fc\b|match|game \d/i],
  ["Cultura y tecnología", /oscar|grammy|album|movie|box office|spotify|youtube|tiktok|openai|gpt|ai model|apple|tesla|elon|musk|twitter|x\.com/i],
];
const areaOf = s => (AREAS.find(([, re]) => re.test(s)) || ["Otros"])[0];

async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!res.ok) throw new Error(res.status + " " + url);
      return await res.json();
    } catch (e) { if (i === tries - 1) throw e; await sleep(800 * (i + 1)); }
  }
}

// ---------- 1. Everything the project has recorded ----------

function loadSnapshots() {
  const dir = path.join(DATA, "snapshots");
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  const trades = new Map(), anomalies = new Map(), prices = new Map();
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const t of s.trades || []) {
      const [ts, w, u, backs, tx] = t;
      trades.set(`${tx}|${w}|${ts}|${u}|${backs}`, { ts, w, u, backs });
    }
    for (const a of s.anomalies || []) anomalies.set(`${a.kind}|${a.wallet}|${a.tx || a.ts}`, a);
    for (const [h, v] of s.priceHistory || []) prices.set(h * 3600, v);
    if (s.prices) prices.set(hourOf(s.ts), s.prices);
  }
  return { files, trades: [...trades.values()].sort((a, b) => a.ts - b.ts), anomalies: [...anomalies.values()], prices };
}

// ---------- 2. Which wallets to study ----------

function groupWallets(trades, anomalies) {
  const per = new Map();
  for (const t of trades) {
    const p = per.get(t.w) || { usd: 0, n: 0, ...Object.fromEntries(SIDES.map(k => [k, 0])) };
    p.usd += t.u; p[t.backs] = (p[t.backs] || 0) + t.u; p.n++;
    per.set(t.w, p);
  }
  anomalies = anomalies.filter(a => per.has(a.wallet)); // ignore flags whose trades never reached a snapshot
  const whale = new Set(anomalies.filter(a => a.kind === "whale").map(a => a.wallet));
  const fresh = new Set(anomalies.filter(a => a.kind === "fresh").map(a => a.wallet));
  const big = new Set([...per].filter(([, p]) => p.usd >= A.bigWalletUsd).map(([w]) => w));
  const flagged = new Set([...whale, ...fresh, ...big]);
  // a reproducible sample of everyone else, for comparison
  const rest = [...per.keys()].filter(w => !flagged.has(w)).sort();
  const step = Math.max(1, Math.floor(rest.length / A.baselineSample));
  const baseline = new Set(rest.filter((_, i) => i % step === 0).slice(0, A.baselineSample));
  return { per, whale, fresh, big, flagged, baseline };
}

// ---------- 3. Public history of each studied wallet (kept only as aggregates) ----------

async function history(wallet) {
  const hours = new Array(24).fill(0);   // trades per UTC hour of day, across all markets
  const events = {};                     // eventSlug -> { usd, n, title }
  let first = Infinity, n = 0;
  let cursor = null;
  for (let read = 0; read < A.maxActivity; read += 500) {
    const j = await get(`${API}/v2/activity?user=${wallet}&limit=500` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    const page = (j && j.data || []).map(L.fromV2);
    if (!page.length) break;
    for (const it of page) {
      first = Math.min(first, it.timestamp);
      if (it.type !== "TRADE") continue;
      n++;
      hours[new Date(it.timestamp * 1000).getUTCHours()]++;
      const slug = it.eventSlug || it.slug || "?";
      const e = events[slug] || (events[slug] = { usd: 0, n: 0, title: it.title || slug });
      e.usd += Number(it.usdcSize) || 0; e.n++;
      // Brazil's presidential election: which candidate the money backed (for the cross-check with Cash Out Brasil)
      if (/brazil|brasil/i.test(slug + " " + (it.title || "")) && /presiden/i.test(slug + " " + (it.title || ""))) {
        const q = it.title || "", yes = String(it.outcome).toLowerCase() === "yes", buy = String(it.side).toUpperCase() === "BUY";
        const who = /fl[aá]vio|bolsonaro/i.test(q) ? "flavio" : /lula/i.test(q) ? "lula" : null;
        if (who) {
          const backs = yes === buy ? who : (who === "lula" ? "flavio" : "lula");
          e.br = e.br || { lula: 0, flavio: 0 };
          e.br[backs] += Number(it.usdcSize) || 0;
        }
      }
    }
    cursor = L.nextCursor(j);
    if (!cursor) break;
    await sleep(150);
  }
  for (const k in events) { events[k].usd = r2(events[k].usd); if (events[k].br) { events[k].br.lula = r2(events[k].br.lula); events[k].br.flavio = r2(events[k].br.flavio); } }
  if (n >= A.maxActivity) { // history was cut short; ask for the very first item separately
    const one = await get(`${API}/v2/activity?user=${wallet}&limit=1&sort_direction=ASC`);
    if (one && one.data && one.data[0]) first = Math.min(first, Number(one.data[0].timestamp));
  }
  return { at: Math.floor(Date.now() / 1000), first: first === Infinity ? null : first, n, hours, events, capped: n >= A.maxActivity };
}

// The quietest six hours of a wallet's day are probably night. Centring them on 03:30 local
// gives a rough UTC offset. Needs a reasonable number of trades to mean anything.
function guessOffset(hours) {
  const total = hours.reduce((a, b) => a + b, 0);
  if (total < 20) return null;
  let best = 0, bestSum = Infinity;
  for (let s = 0; s < 24; s++) {
    let sum = 0; for (let k = 0; k < 6; k++) sum += hours[(s + k) % 24];
    if (sum < bestSum) { bestSum = sum; best = s; }
  }
  if (bestSum / total > 0.12) return null; // no clear night: bot, shift worker, or several people
  let off = Math.round(3.5 - (best + 3)); // centre of the window is best+3 (UTC)
  if (off < -11) off += 24; if (off > 12) off -= 24;
  return off;
}
const REGIONS = [
  ["UTC−8 a −6 (costa oeste y centro de EE. UU., México)", -8, -6],
  ["UTC−5 a −2 (este de EE. UU., Canadá, Brasil, resto de Sudamérica)", -5, -2],
  ["UTC−1 a +3 (Europa, incluida España, y África)", -1, 3],
  ["UTC+4 a +6 (Golfo, Asia Central, India)", 4, 6],
  ["UTC+7 a +10 (Sudeste y Este de Asia, Australia)", 7, 10],
  ["otros husos", -11, 12],
];
const regionOf = off => REGIONS.find(([, a, b]) => off >= a && off <= b)[0];

// ---------- 4. Funding: where the stablecoins came from (needs an Etherscan key) ----------

async function funding(wallet) {
  const url = `${ESCAN}&module=account&action=tokentx&address=${wallet}&startblock=0&endblock=99999999&page=1&offset=200&sort=asc&apikey=${KEY}`;
  const j = await get(url);
  if (!j || j.status !== "1" || !Array.isArray(j.result)) return { inflows: [] };
  const inflows = j.result
    .filter(x => x.to.toLowerCase() === wallet && STABLES.test(x.tokenSymbol) && !INTERNAL.has(x.from.toLowerCase()))
    .map(x => ({ from: x.from.toLowerCase(), ts: +x.timeStamp, usd: r2(Number(x.value) / 10 ** Number(x.tokenDecimal)), token: x.tokenSymbol }));
  return { inflows };
}

// What kind of address a funder is. Order: hand-checked service labels, then what the chain says.
// Polymarket accounts are smart wallets (ProxyWallet, Safe, DepositWallet): money from one of them is
// money moved from another Polymarket account, not money entering from outside.
const USER_ACCOUNT = /^(ProxyWallet|GnosisSafeProxy|SafeProxy|DepositWallet)$/;
const DEX = /Pool|Pair|Router|Swap/i;
async function funderCategory(addr) {
  if (LABELS[addr]) return { cat: LABELS[addr].cat, src: "labels.json" };
  const code = await get(`${ESCAN}&module=proxy&action=eth_getCode&address=${addr}&tag=latest&apikey=${KEY}`);
  if (!code || typeof code.result !== "string") return null;
  if (code.result === "0x") return { cat: "carteira sem rótulo", src: "etherscan" };
  await sleep(250);
  const src = await get(`${ESCAN}&module=contract&action=getsourcecode&address=${addr}&apikey=${KEY}`);
  const name = src && Array.isArray(src.result) && src.result[0] ? src.result[0].ContractName || "" : "";
  const cat = USER_ACCOUNT.test(name) ? "conta de usuário do Polymarket" : DEX.test(name) ? "troca descentralizada" : "outro contrato";
  return { cat, src: "etherscan", contract: name };
}
const POLY_CATS = new Set(["contrato do Polymarket", "conta de usuário do Polymarket"]);
// Internal category keys stay as in labels.json (shared with Cash Out Brasil); labels are in Spanish.
const CAT_ORDER = [
  ["contrato do Polymarket", "Contratos del propio Polymarket (premios, canjes, depósitos)"],
  ["conta de usuário do Polymarket", "Otra cuenta de Polymarket (transferencia entre cuentas)"],
  ["troca descentralizada", "Intercambio descentralizado (otra cripto convertida en dólar digital)"],
  ["ponte entre redes", "Puente entre blockchains"],
  ["corretora", "Exchange con etiqueta pública"],
  ["carteira abastecida por corretora", "Billetera personal abastecida por un exchange"],
  ["carteira abastecida pela ChangeNOW", "Billetera personal abastecida por ChangeNOW (cambio sin registro)"],
  ["MoonPay", "MoonPay (compra con tarjeta)"],
  ["carteira sem rótulo", "Billetera personal sin etiqueta"],
  ["outro contrato", "Otro contrato"],
  ["não verificado", "Todavía sin verificar"],
];

// ---------- 5. The report ----------

function hourlyTimeline(trades, groups, anomalies, prices) {
  const rows = new Map();
  const row = h => rows.get(h) || rows.set(h, { h, side: {}, big: {}, fresh: 0, wallets: new Set() }).get(h);
  for (const t of trades) {
    const r = row(hourOf(t.ts));
    r.side[t.backs] = (r.side[t.backs] || 0) + t.u; r.wallets.add(t.w);
    if (groups.whale.has(t.w) || groups.big.has(t.w)) r.big[t.backs] = (r.big[t.backs] || 0) + t.u;
    if (groups.fresh.has(t.w)) r.fresh += t.u;
  }
  const swings = new Map();
  for (const a of anomalies.filter(a => a.kind === "swing")) {
    const h = hourOf(a.ts);
    swings.set(h, (swings.has(h) ? swings.get(h) + "; " : "") + `${sideName(a.backs)} ${a.points}`);
  }
  const col = k => k.replace(/^-/, "contra_");
  return [...rows.values()].sort((a, b) => a.h - b.h).map(r => {
    const o = { hour_utc: iso(r.h), hora_madrid: mad(r.h), wallets: r.wallets.size };
    for (const k of SIDES) o[col(k) + "_usd"] = r2(r.side[k] || 0);
    for (const k of SIDES) o["grandes_" + col(k) + "_usd"] = r2(r.big[k] || 0);
    o.nuevas_usd = r2(r.fresh);
    const p = prices.get(r.h) || {};
    for (const c of L.CONFIG.candidates) o["prob_" + c.key] = p[c.key] != null ? p[c.key] : "";
    o.giro = swings.get(r.h) || "";
    return o;
  });
}

// What each group bets on. A wallet "sticks to" one side when 90%+ of its money went there;
// otherwise it spread across several (hedging, trading the swings, or making the market).
function sidesOf(label, set, per) {
  const out = { label, stick: Object.fromEntries(SIDES.map(k => [k, { wallets: 0, usd: 0 }])), mixed: { wallets: 0, usd: 0 }, usd: Object.fromEntries(SIDES.map(k => [k, 0])), total: 0 };
  for (const w of set) {
    const p = per.get(w); if (!p || !p.usd) continue;
    const k = SIDES.find(k => (p[k] || 0) / p.usd >= 0.9);
    const bucket = k ? out.stick[k] : out.mixed;
    bucket.wallets++; bucket.usd += p.usd;
    for (const s of SIDES) out.usd[s] += p[s] || 0;
    out.total += p.usd;
  }
  for (const k of SIDES) { out.stick[k].usd = r2(out.stick[k].usd); out.usd[k] = r2(out.usd[k]); }
  out.mixed.usd = r2(out.mixed.usd);
  out.pct = Object.fromEntries(SIDES.map(k => [k, pct(out.usd[k], out.total)]));
  return out;
}

// Day by day (Madrid dates): share of the big bettors' money on each side next to everyone else's,
// and each party's odds at the end of the day.
function dailySides(trades, isBig, prices) {
  const days = new Map();
  for (const t of trades) {
    const d = madDay(t.ts);
    const x = days.get(d) || days.set(d, { day: d, big: {}, rest: {}, bigTot: 0, restTot: 0, bigWallets: new Set() }).get(d);
    const big = isBig(t), g = big ? x.big : x.rest;
    g[t.backs] = (g[t.backs] || 0) + t.u;
    if (big) { x.bigTot += t.u; x.bigWallets.add(t.w); } else x.restTot += t.u;
  }
  const hours = [...prices.keys()].sort((a, b) => a - b);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(x => {
    const end = Math.max(...hours.filter(h => madDay(h) === x.day), -Infinity);
    const p = isFinite(end) ? prices.get(end) : null;
    return {
      day: x.day, bigWallets: x.bigWallets.size, bigUsd: r2(x.bigTot),
      bigPct: Object.fromEntries(SIDES.map(k => [k, pct(x.big[k] || 0, x.bigTot)])),
      restPct: Object.fromEntries(SIDES.map(k => [k, pct(x.rest[k] || 0, x.restTot)])),
      odds: p ? Object.fromEntries(L.CONFIG.candidates.map(c => [c.key, Math.round(p[c.key] * 1000) / 10])) : null,
    };
  });
}

// Cross-check with Cash Out Brasil: did the wallets betting on Spain also bet on Brazil's presidential
// election, and on whom? Grouped by what they back in Spain. Counts and sums only.
function brazilCross(wallets, cache, per) {
  const groups = new Map();
  const add = (label, w, br) => {
    const g = groups.get(label) || groups.set(label, { label, withHistory: 0, inBrazil: 0, lula: 0, flavio: 0 }).get(label);
    g.withHistory++;
    if (br && br.lula + br.flavio > 0) { g.inBrazil++; g.lula += br.lula; g.flavio += br.flavio; }
  };
  for (const w of wallets) {
    const h = cache[w], p = per.get(w); if (!h || !h.n || !p) continue;
    let br = null;
    for (const e of Object.values(h.events || {})) if (e.br) { br = br || { lula: 0, flavio: 0 }; br.lula += e.br.lula; br.flavio += e.br.flavio; }
    const main = SIDES.find(k => (p[k] || 0) / p.usd >= 0.6);   // looser than 90%: what they mostly back in Spain
    add("Todas", w, br);
    const name = L.labelOf(L.partyOf(main || "")), de = /^(PP|PSOE)$/.test(name) ? "del " : "de ";
    add(main ? "Sobre todo " + (L.isAgainst(main) ? "en contra " : "a favor ") + de + name : "Varios lados", w, br);
    // the right-wing bloc in this market: for PP, for Vox, or against PSOE
    const right = (p.pp || 0) + (p.vox || 0) + (p["-psoe"] || 0), left = (p.psoe || 0) + (p["-pp"] || 0);
    if (right / p.usd >= 0.6) add("Bloque derecho (PP, Vox o contra el PSOE)", w, br);
    if (left / p.usd >= 0.6) add("Bloque izquierdo (PSOE o contra el PP)", w, br);
  }
  return [...groups.values()].filter(g => g.withHistory >= A.minGroup).map(g => ({
    ...g, inBrazil: g.inBrazil, inBrazilPct: pct(g.inBrazil, g.withHistory),
    lula: r2(g.lula), flavio: r2(g.flavio), flavioPct: pct(g.flavio, g.lula + g.flavio),
  }));
}

function hourOfDay(trades, filter) {
  const h = new Array(24).fill(0);
  let tot = 0;
  for (const t of trades) if (filter(t)) { h[madHour(t.ts)] += t.u; tot += t.u; }
  return h.map(x => pct(x, tot)); // share of money per Madrid hour
}

// Money placed by big wallets in the hours before each swing, split by whether it backed the
// direction the odds then moved (a swing up for PP backs "pp"; a swing down backs "-pp").
function aheadOfSwings(trades, groups, anomalies) {
  const out = { swings: 0, withBigMoneyAhead: 0, usdSameDirection: 0, usdOpposite: 0 };
  for (const s of anomalies.filter(a => a.kind === "swing")) {
    const h = hourOf(s.ts), from = h - A.beforeSwingHours * 3600;
    let same = 0, opp = 0;
    for (const t of trades) {
      if (t.ts < from || t.ts >= h || !(groups.whale.has(t.w) || groups.big.has(t.w))) continue;
      if (t.backs === s.backs) same += t.u; else opp += t.u;
    }
    out.swings++; if (same + opp > 0) out.withBigMoneyAhead++;
    out.usdSameDirection += same; out.usdOpposite += opp;
  }
  out.usdSameDirection = r2(out.usdSameDirection); out.usdOpposite = r2(out.usdOpposite);
  return out;
}

function otherMarkets(wallets, cache) {
  const byArea = {}, byEvent = {};
  let withHistory = 0, onlyThis = 0;
  for (const w of wallets) {
    const h = cache[w]; if (!h || !h.n) continue;
    withHistory++;
    const others = Object.entries(h.events).filter(([slug]) => slug !== L.CONFIG.eventSlug);
    if (!others.length) onlyThis++;
    const areas = new Set();
    for (const [slug, e] of others) {
      const a = areaOf(slug + " " + e.title);
      areas.add(a);
      const ev = byEvent[slug] || (byEvent[slug] = { title: e.title, area: a, wallets: 0, usd: 0 });
      ev.wallets++; ev.usd += e.usd;
    }
    for (const a of areas) {
      const x = byArea[a] || (byArea[a] = { wallets: 0, usd: 0 });
      x.wallets++;
      x.usd += others.filter(([s, e]) => areaOf(s + " " + e.title) === a).reduce((s, [, e]) => s + e.usd, 0);
    }
  }
  const areas = Object.entries(byArea)
    .map(([area, x]) => ({ area, wallets: x.wallets, walletsPct: pct(x.wallets, withHistory), usd: r2(x.usd) }))
    .filter(x => x.wallets >= A.minGroup).sort((a, b) => b.wallets - a.wallets);
  const events = Object.values(byEvent).filter(e => e.wallets >= A.minGroup)
    .sort((a, b) => b.wallets - a.wallets || b.usd - a.usd).slice(0, 25)
    .map(e => ({ ...e, usd: r2(e.usd) }));
  return { withHistory, onlyThisMarket: onlyThis, onlyThisMarketPct: pct(onlyThis, withHistory), areas, events };
}

function timezones(wallets, cache) {
  const count = {}; let read = 0, unclear = 0;
  for (const w of wallets) {
    const h = cache[w]; if (!h || !h.n) continue;
    const off = guessOffset(h.hours);
    if (off == null) { unclear++; continue; }
    read++; const r = regionOf(off); count[r] = (count[r] || 0) + 1;
  }
  return {
    estimated: read, unclear,
    regions: Object.entries(count).filter(([, n]) => n >= A.minGroup)
      .map(([region, n]) => ({ region, wallets: n, pct: pct(n, read) })).sort((a, b) => b.wallets - a.wallets),
  };
}

function walletAge(wallets, cache, per, trades) {
  // age of each wallet at its first bet on the election
  const firstBet = new Map();
  for (const t of trades) if (!firstBet.has(t.w)) firstBet.set(t.w, t.ts);
  const buckets = { "menos de 1 día": 0, "1 a 7 días": 0, "1 a 4 semanas": 0, "1 a 6 meses": 0, "más de 6 meses": 0 };
  const usd = { ...Object.fromEntries(Object.keys(buckets).map(k => [k, 0])) };
  let n = 0;
  for (const w of wallets) {
    const h = cache[w]; if (!h || h.first == null || !firstBet.has(w)) continue;
    const d = (firstBet.get(w) - h.first) / 86400;
    const k = d < 1 ? "menos de 1 día" : d < 7 ? "1 a 7 días" : d < 28 ? "1 a 4 semanas" : d < 182 ? "1 a 6 meses" : "más de 6 meses";
    buckets[k]++; usd[k] += per.get(w).usd; n++;
  }
  return Object.keys(buckets).map(k => ({
    age: k, wallets: buckets[k] >= A.minGroup ? buckets[k] : (buckets[k] ? `<${A.minGroup}` : 0),
    pct: buckets[k] >= A.minGroup || !buckets[k] ? pct(buckets[k], n) : "–", usd: buckets[k] >= A.minGroup ? r2(usd[k]) : null,
  }));
}

function fundingSummary(wallets, fund, per, funders) {
  // Addresses are counted and classified, never printed.
  const catOf = a => (funders[a] && funders[a].cat) || "não verificado";
  let withData = 0, noOutside = 0, inflowUsd = 0;
  const tokens = {};
  const byCat = {}; // cat -> { usd, wallets:Set }
  const personal = new Map(); // unlabeled personal funder -> studied wallets it paid
  for (const w of wallets) {
    const f = fund[w]; if (!f) continue;
    withData++;
    let outside = false;
    for (const x of f.inflows) {
      const c = catOf(x.from);
      inflowUsd += x.usd; tokens[x.token] = (tokens[x.token] || 0) + x.usd;
      (byCat[c] = byCat[c] || { usd: 0, wallets: new Set() }).usd += x.usd;
      byCat[c].wallets.add(w);
      if (!POLY_CATS.has(c)) outside = true;
      if (c === "carteira sem rótulo") { if (!personal.has(x.from)) personal.set(x.from, new Set()); personal.get(x.from).add(w); }
    }
    if (!outside) noOutside++;
  }
  const sharedSizes = [...personal.values()].map(s => s.size).filter(n => n >= A.minGroup).sort((a, b) => b - a);
  const crossFunded = Object.keys(fund).length ? [...new Set(Object.values(fund).flatMap(f => f.inflows.map(x => x.from)))].filter(a => wallets.has(a)).length : 0;
  let betNoOutside = 0;
  for (const w of wallets) { const f = fund[w]; if (f && !f.inflows.some(x => !POLY_CATS.has(catOf(x.from)))) betNoOutside += per.get(w).usd; }
  return {
    walletsChecked: withData, walletsNoOutsideInflow: noOutside, betUsdNoOutsideInflow: r2(betNoOutside), inflowUsd: r2(inflowUsd),
    tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, r2(v)])),
    byCategory: CAT_ORDER.filter(([k]) => byCat[k]).map(([k, label]) => ({ key: k, label, inflowUsd: r2(byCat[k].usd), pct: pct(byCat[k].usd, inflowUsd), wallets: byCat[k].wallets.size })),
    funderAddresses: Object.keys(funders).length,
    personalFunderGroups: sharedSizes.length, personalFunderGroupSizes: sharedSizes,
    walletsThatFundedOtherStudiedWallets: crossFunded >= A.minGroup ? crossFunded : (crossFunded ? `<${A.minGroup}` : 0),
  };
}

const money = x => "US$ " + Math.round(x).toLocaleString("es-ES", { useGrouping: "always" });
const few = n => (typeof n === "number" && n > 0 && n < A.minGroup ? `<${A.minGroup}` : n);
const pc = x => String(x).replace(".", ",") + "%";

function markdown(R) {
  const L1 = [];
  const p = s => L1.push(s);
  const heads = SIDES.map(sideName);
  p(`# Cash Out · España: análisis agregado`);
  p(``);
  p(`Elecciones generales del 29 de noviembre de 2026, mercado «${L.CONFIG.eventSlug}» de Polymarket (qué partido gana más escaños). Actualizado el ${mad(R.generatedAt)} (hora de Madrid). ${R.hoursRecorded} horas registradas, del ${R.from} al ${R.to} (UTC).`);
  p(``);
  p(`Ninguna dirección de billetera aparece aquí. Cada número es una suma o un conteo sobre un grupo, y los grupos de menos de ${A.minGroup} billeteras se omiten.`);
  p(``);
  p(`**Cómo leer «contra».** En este mercado se puede apostar a favor de un partido (comprar su «sí») o en contra (comprar su «no»). Comprar el «no» de un partido que casi no tiene opciones, como Vox para ganar más escaños, cuesta casi un dólar y paga un poco más: es sobre todo una forma de cobrar un pequeño rendimiento, no una toma de posición política. Las apuestas *a favor* de Vox, en cambio, son apuestas contra las probabilidades y merecen atención.`);
  p(``);
  p(`## Quién apuesta`);
  p(``);
  p(`| | Billeteras | Apostado | ${heads.join(" | ")} |`);
  p(`|---|---:|---:|${SIDES.map(() => "---:").join("|")}|`);
  for (const g of R.groups) p(`| ${g.label} | ${g.wallets} | ${money(g.usd)} | ${SIDES.map(k => pc(g.pct[k])).join(" | ")} |`);
  p(``);
  p(`Grandes apostadores = ballenas (US$ 5.000+ en menos de una hora), billeteras nuevas señaladas, o quien sumó US$ ${A.bigWalletUsd.toLocaleString("es-ES", { useGrouping: "always" })}+ en el periodo. Son el ${pc(R.concentration.bigWalletsPct)} de las billeteras y ponen el ${pc(R.concentration.bigUsdPct)} del dinero.`);
  p(``);
  p(`## A qué apuestan los grandes apostadores`);
  p(``);
  p(`Una billetera se «queda» en un lado cuando el 90% o más de su dinero fue ahí. Las demás repartieron su dinero entre varios lados: para cubrirse, para ganar con las oscilaciones o como intermediarias del mercado.`);
  p(``);
  p(`| Grupo | ${heads.map(h => "Solo " + h).join(" | ")} | Varios lados |`);
  p(`|---|${SIDES.map(() => "---:").join("|")}|---:|`);
  const cell = c => c.wallets >= A.minGroup ? `${c.wallets} (${money(c.usd)})` : few(c.wallets);
  for (const g of R.sides) p(`| ${g.label} | ${SIDES.map(k => cell(g.stick[k])).join(" | ")} | ${cell(g.mixed)} |`);
  p(``);
  if (R.daily.length) {
    p(`Día a día (fechas de Madrid). Parte del dinero de los grandes apostadores que fue a cada lado, junto a la de las demás billeteras y las probabilidades al final del día:`);
    p(``);
    p(`| Día | Grandes activos | Dinero de los grandes | Grandes: PP / PSOE / Vox | Demás: PP / PSOE / Vox | Prob. PP / PSOE / Vox |`);
    p(`|---|---:|---:|---|---|---|`);
    const tri = o => ["pp", "psoe", "vox"].map(k => pc(o[k] || 0)).join(" / ");
    for (const d of R.daily) {
      const ok = d.bigWallets >= A.minGroup;
      p(`| ${d.day} | ${few(d.bigWallets)} | ${ok ? money(d.bigUsd) : "–"} | ${ok ? tri(d.bigPct) : "–"} | ${tri(d.restPct)} | ${d.odds ? tri(d.odds) : "–"} |`);
    }
    p(``);
    p(`(Solo apuestas *a favor*; el resto hasta 100% son apuestas en contra.)`);
    p(``);
  }
  p(`## Horarios (hora de Madrid)`);
  p(``);
  p(`Parte del dinero apostado en cada hora del día. La línea de tiempo completa, hora por hora, está en \`hourly.csv\`, lista para cruzar con la agenda de campaña, los debates y la publicación de encuestas.`);
  p(``);
  p(`| Hora | Grandes | Demás |`);
  p(`|---|---:|---:|`);
  for (let h = 0; h < 24; h++) p(`| ${String(h).padStart(2, "0")} h | ${R.hourOfDay.big ? pc(R.hourOfDay.big[h]) : "–"} | ${pc(R.hourOfDay.rest[h])} |`);
  p(``);
  const s = R.aheadOfSwings;
  p(`**Antes de los giros.** Hubo ${s.swings} giros de 3+ puntos en una hora en las probabilidades de algún partido. En ${s.withBigMoneyAhead} de ellos, grandes apostadores habían puesto dinero en las ${A.beforeSwingHours} horas anteriores: ${money(s.usdSameDirection)} en la misma dirección del giro, ${money(s.usdOpposite)} en otras. Esto muestra coincidencia en el tiempo, no prueba que alguien supiera antes; también puede ser su propio dinero el que movió las probabilidades.`);
  p(``);
  p(`## Cruce con Cash Out Brasil`);
  p(``);
  if (R.brazil.length) {
    p(`¿Las billeteras que apuestan sobre España también apostaron en la elección presidencial de Brasil de 2026, y a quién? Agrupadas según lo que respaldan sobre todo en España (60% o más de su dinero). Se miran los grandes apostadores y la muestra de comparación juntos.`);
    p(``);
    p(`| Grupo (según su apuesta en España) | Billeteras con historial | También apostaron en Brasil | % | Dinero en Brasil a Flávio | Dinero a Lula | % a Flávio |`);
    p(`|---|---:|---:|---:|---:|---:|---:|`);
    for (const g of R.brazil) {
      const ok = g.inBrazil >= A.minGroup;
      p(`| ${g.label} | ${g.withHistory} | ${few(g.inBrazil)} | ${pc(g.inBrazilPct)} | ${ok ? money(g.flavio) : "–"} | ${ok ? money(g.lula) : "–"} | ${ok ? pc(g.flavioPct) : "–"} |`);
    }
    p(``);
    p(`Coincidir en las dos elecciones no prueba coordinación: muchos apostadores profesionales apuestan en todas las elecciones del mundo. Lo que interesa es si el patrón se repite: las mismas billeteras, del mismo lado, en los mismos momentos de la campaña.`);
  } else p(`Todavía no hay suficientes historiales leídos para este cruce.`);
  p(``);
  p(`## Husos horarios (estimación)`);
  p(``);
  p(`Para cada billetera con historial suficiente, las seis horas más tranquilas del día se toman como noche. ${R.timezones.big.estimated} grandes apostadores mostraron un patrón claro; ${R.timezones.big.unclear} no (bots, varias personas o poca actividad). El método no distingue España del resto de Europa central.`);
  p(``);
  p(`| Franja | Grandes | Comparación |`);
  p(`|---|---:|---:|`);
  const regs = new Set([...R.timezones.big.regions, ...R.timezones.baseline.regions].map(r => r.region));
  for (const r of regs) {
    const b = R.timezones.big.regions.find(x => x.region === r), c = R.timezones.baseline.regions.find(x => x.region === r);
    p(`| ${r} | ${b ? pc(b.pct) : "–"} | ${c ? pc(c.pct) : "–"} |`);
  }
  p(``);
  p(`## Edad de las billeteras en su primera apuesta sobre la elección`);
  p(``);
  p(`| Edad | Grandes | % | Apostado |`);
  p(`|---|---:|---:|---:|`);
  for (const a of R.walletAge) p(`| ${a.age} | ${a.wallets} | ${a.pct === "–" ? "–" : pc(a.pct)} | ${a.usd == null ? "–" : money(a.usd)} |`);
  p(``);
  p(`## En qué más apuestan`);
  p(``);
  const om = R.otherMarkets.big, ob = R.otherMarkets.baseline;
  p(`El ${pc(om.onlyThisMarketPct)} de los grandes apostadores nunca apostó en otra cosa en Polymarket (en la comparación: ${pc(ob.onlyThisMarketPct)}). Las billeteras de un solo uso son una de las señales clásicas de apuestas con información privilegiada, pero también de quien solo se interesa por España.`);
  p(``);
  p(`| Área | Grandes | Comparación |`);
  p(`|---|---:|---:|`);
  const areas = new Set([...om.areas, ...ob.areas].map(a => a.area));
  for (const a of areas) {
    const b = om.areas.find(x => x.area === a), c = ob.areas.find(x => x.area === a);
    p(`| ${a} | ${b ? pc(b.walletsPct) : "–"} | ${c ? pc(c.walletsPct) : "–"} |`);
  }
  p(``);
  if (om.events.length) {
    p(`Mercados en común entre los grandes apostadores (${A.minGroup}+ billeteras):`);
    p(``);
    p(`| Mercado | Área | Billeteras | Apostado |`);
    p(`|---|---|---:|---:|`);
    for (const e of om.events) p(`| ${e.title.replace(/\|/g, "/")} | ${e.area} | ${e.wallets} | ${money(e.usd)} |`);
    p(``);
  }
  p(`## De dónde viene el dinero`);
  p(``);
  const f = R.funding;
  if (f && f.walletsChecked < A.minGroup) {
    p(`Todavía hay muy pocos grandes apostadores verificados para mostrar esta sección sin exponer billeteras individuales.`);
  } else if (!f) {
    p(`Esta sección necesita una clave gratuita de Etherscan (secret \`ETHERSCAN_API_KEY\`).`);
  } else {
    p(`Entradas de stablecoins (USDC, pUSD y similares) en las billeteras de los ${f.walletsChecked} grandes apostadores verificados, en la red Polygon, a lo largo de todo su historial: ${money(f.inflowUsd)} en total. Cada dirección de origen se clasificó por su etiqueta pública en Polygonscan o por el tipo de contrato; las direcciones no se publican.`);
    p(``);
    p(`| Origen | Entradas | % | Billeteras |`);
    p(`|---|---:|---:|---:|`);
    for (const c of f.byCategory) p(`| ${c.label} | ${money(c.inflowUsd)} | ${pc(c.pct)} | ${few(c.wallets)} |`);
    p(``);
    p(`**Sin entradas de fuera de Polymarket:** ${few(f.walletsNoOutsideInflow)} billeteras (${money(f.betUsdNoOutsideInflow)} apostados en la elección) solo recibieron dinero de contratos o de otras cuentas del propio Polymarket, o ninguna entrada visible. Para ellas, solo Polymarket sabe de dónde vino el dinero.`);
    p(``);
    p(`${f.personalFunderGroups} grupos de 3 o más billeteras estudiadas fueron abastecidos por una misma billetera personal sin etiqueta (posible mismo dueño; tamaños: ${f.personalFunderGroupSizes.join(", ") || "–"}). Billeteras estudiadas que abastecieron a otras billeteras estudiadas: ${f.walletsThatFundedOtherStudiedWallets}.`);
    p(``);
    p(`Monedas de entrada: ${Object.entries(f.tokens).map(([k, v]) => `${k} ${money(v)}`).join(", ")}.`);
    p(``);
    p(`La blockchain muestra la dirección de origen, no a la persona. Exchanges, puentes e intercambios mezclan miles de clientes; a partir de ellos el rastro solo sigue con datos de las propias empresas, que en España pueden solicitar autoridades como el SEPBLAC o la Dirección General de Ordenación del Juego, que mantiene bloqueado Polymarket desde mayo de 2026.`);
  }
  p(``);
  return L1.join("\n");
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { files, trades, anomalies, prices } = loadSnapshots();
  if (!trades.length) { console.log("no trades recorded yet"); return; }
  const G = groupWallets(trades, anomalies);
  console.log(`${files.length} snapshots, ${trades.length} trades, ${G.per.size} wallets; studying ${G.flagged.size} big + ${G.baseline.size} baseline`);

  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : { history: {}, funding: {} };
  // What kind of address each funder is (category only), kept in its own small file.
  cache.funders = fs.existsSync(FUNDERS) ? JSON.parse(fs.readFileSync(FUNDERS, "utf8")) : (cache.funders || {});
  const now = Math.floor(Date.now() / 1000);
  const study = [...G.flagged, ...G.baseline];
  let fetched = 0;
  for (const w of study) {
    const h = cache.history[w];
    if (OFFLINE || (h && now - h.at < A.refreshDays * 86400)) continue;
    try { cache.history[w] = await history(w); fetched++; } catch (e) { console.log("history failed:", e.message); }
    await sleep(120);
  }
  if (KEY && !OFFLINE) {
    for (const w of G.flagged) {
      if (cache.funding[w] && now - cache.funding[w].at < A.refreshDays * 86400) continue;
      try { cache.funding[w] = { at: now, ...(await funding(w)) }; } catch (e) { console.log("funding failed:", e.message); }
      await sleep(250); // stays under the free tier's rate
    }
  }
  // Classify every address that funded a big bettor (hand-checked labels first, then the chain).
  for (const [a, l] of Object.entries(LABELS)) cache.funders[a] = { cat: l.cat, src: "labels.json" };
  if (KEY && !OFFLINE) {
    const all = new Set(Object.values(cache.funding).flatMap(f => f.inflows.map(x => x.from)));
    for (const a of all) {
      if (cache.funders[a]) continue;
      try { const c = await funderCategory(a); if (c) cache.funders[a] = c; } catch (e) { console.log("funder check failed:", e.message); }
      await sleep(250);
    }
  }
  const { funders: fundersOut, ...cacheOut } = cache;
  fs.writeFileSync(CACHE, JSON.stringify(cacheOut));
  fs.writeFileSync(FUNDERS, JSON.stringify(fundersOut, null, 0));
  console.log(`read ${fetched} wallet histories`);

  const group = (label, set) => {
    let usd = 0; const by = Object.fromEntries(SIDES.map(k => [k, 0]));
    for (const w of set) { const p = G.per.get(w); usd += p.usd; for (const k of SIDES) by[k] += p[k] || 0; }
    return { label, wallets: set.size, usd: r2(usd), pct: Object.fromEntries(SIDES.map(k => [k, pct(by[k], usd)])) };
  };
  const all = new Set(G.per.keys());
  const bigUsd = [...G.flagged].reduce((s, w) => s + G.per.get(w).usd, 0);
  const allUsd = [...all].reduce((s, w) => s + G.per.get(w).usd, 0);
  const isBig = t => G.whale.has(t.w) || G.big.has(t.w) || G.fresh.has(t.w);

  const R = {
    generatedAt: now, hoursRecorded: files.length,
    from: iso(trades[0].ts), to: iso(trades[trades.length - 1].ts),
    thresholds: { ...A, whaleUsd: L.CONFIG.whaleUsd, freshWalletDays: L.CONFIG.freshWalletDays },
    groups: [
      group("Todas las billeteras", all),
      group("Grandes apostadores", G.flagged),
      group("…ballenas", G.whale),
      group("…billeteras nuevas señaladas", G.fresh),
    ].filter(g => g.wallets >= A.minGroup),
    concentration: { bigWalletsPct: pct(G.flagged.size, all.size), bigUsdPct: pct(bigUsd, allUsd) },
    hourOfDay: { big: G.flagged.size >= A.minGroup ? hourOfDay(trades, isBig) : null, rest: hourOfDay(trades, t => !isBig(t)) },
    sides: [
      sidesOf("Todos los grandes apostadores", G.flagged, G.per),
      sidesOf("Ballenas", G.whale, G.per),
      sidesOf("Billeteras nuevas señaladas", G.fresh, G.per),
      sidesOf("Demás billeteras", new Set([...all].filter(w => !G.flagged.has(w))), G.per),
    ].filter(g => SIDES.reduce((n, k) => n + g.stick[k].wallets, g.mixed.wallets) >= A.minGroup),
    daily: G.flagged.size >= A.minGroup ? dailySides(trades, isBig, prices) : [],
    brazil: brazilCross(new Set([...G.flagged, ...G.baseline]), cache.history, G.per),
    aheadOfSwings: aheadOfSwings(trades, G, anomalies),
    timezones: { big: timezones(G.flagged, cache.history), baseline: timezones(G.baseline, cache.history) },
    walletAge: walletAge(G.flagged, cache.history, G.per, trades),
    otherMarkets: { big: otherMarkets(G.flagged, cache.history), baseline: otherMarkets(G.baseline, cache.history) },
    funding: Object.keys(cache.funding).length ? fundingSummary(G.flagged, cache.funding, G.per, cache.funders) : null,
  };

  const rows = hourlyTimeline(trades, G, anomalies, prices);
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(path.join(OUT, "hourly.csv"), [cols.join(","), ...rows.map(r => cols.map(c => JSON.stringify(r[c] ?? "")).join(","))].join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(R, null, 1));
  fs.writeFileSync(path.join(OUT, "informe.md"), markdown(R));
  console.log("wrote analysis/informe.md, report.json, hourly.csv");
}

main().catch(e => { console.error(e); process.exit(1); });
