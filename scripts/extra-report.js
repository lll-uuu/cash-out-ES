#!/usr/bin/env node
// Report on the extra markets (data/extra/*.json) -> analysis/otros-mercados.md, in Spanish.
// Like the main report: no wallet addresses, and any figure about fewer than 3 wallets is hidden.
// "Ultra" outcomes = bets on a strong far right: PP + Vox majority, PP + Vox 50%+ of the vote,
// Vox above 20% of the vote, Vox 66+ seats, Vox winning a constituency.
const fs = require("fs");
const path = require("path");

const DIR = "data/extra";
const MIN = 3;
const ULTRA = {
  "spain-general-election-pp-vox-majority": o => true,
  "spain-general-election-pp-vox-get-50-of-vote": o => true,
  "spain-general-election-vox-of-vote": o => /^(20-22%|22%\+)$/.test(o),
  "spain-general-election-vox-of-seats": o => /^(66-70|71-75|76\+)$/.test(o),
  "spain-general-election-vox-wins-a-constituency": o => true,
  "next-prime-minister-of-spain-20260625005215443": o => /abascal/i.test(o),
  "who-will-receive-the-first-mandate-to-form-spains-next-government": o => /abascal/i.test(o),
};
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const money = x => "US$ " + Math.round(x).toLocaleString("es-ES", { useGrouping: "always" });
const pc = (a, b) => (b ? (Math.round(a / b * 1000) / 10) : 0).toString().replace(".", ",") + "%";
const few = n => (n > 0 && n < MIN ? `<${MIN}` : n);
const madDay = ts => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Madrid" }).format(new Date(ts * 1000));
const madTime = ts => new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ts * 1000));

// wallets of the main market, and Brazil history where the daily analysis has read it
const mainWallets = new Set();
for (const f of fs.existsSync("data/snapshots") ? fs.readdirSync("data/snapshots") : []) {
  const s = readJSON(path.join("data/snapshots", f), null);
  for (const t of (s && s.trades) || []) mainWallets.add(t[1]);
}
const history = (readJSON("analysis/cache.json", {}).history) || {};
const brazilOf = w => {
  const h = history[w]; if (!h || !h.events) return null;
  let lula = 0, flavio = 0, any = false;
  for (const e of Object.values(h.events)) if (e.br) { any = true; lula += e.br.lula; flavio += e.br.flavio; }
  return any ? { lula, flavio } : { lula: 0, flavio: 0, none: true };
};

const out = [];
const p = s => out.push(s);
p("# Cash Out · España: otros mercados");
p("");
p(`Actualizado el ${madTime(Math.floor(Date.now() / 1000))} (hora de Madrid). La imagen marmolada sigue el mercado de quién gana más escaños; aquí se analizan los mercados de Polymarket que apuestan específicamente sobre la fuerza de la extrema derecha. Ninguna dirección de billetera aparece aquí, y los grupos de menos de ${MIN} billeteras se omiten.`);
p("");
p("**Apuestas «ultra»** = apuestas a que PP y Vox suman mayoría absoluta, a que suman el 50% de los votos, a que Vox supera el 20% de los votos, a que Vox saca 66 escaños o más, a que Vox gana alguna circunscripción, o a que Santiago Abascal será presidente del Gobierno o recibirá el primer encargo para formarlo.");
p("");

const allUltra = new Map();   // wallet -> usd on ultra outcomes, all markets
const dayUltra = new Map();
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => f.endsWith(".json")) : [];
for (const f of files) {
  const E = readJSON(path.join(DIR, f), null); if (!E) continue;
  const isUltra = ULTRA[E.slug] || (() => false);
  const tr = E.trades;
  const tot = tr.reduce((a, t) => a + t[2], 0);
  const wallets = new Set(tr.map(t => t[1]));
  p(`## ${E.title}`);
  p("");
  p(`${money(tot)} apostados por ${wallets.size} billeteras en ${tr.length} apuestas${tr.length ? `, desde el ${madTime(tr[0][0])}` : ""}.`);
  p("");
  p("| Resultado | Probabilidad ahora | A favor | En contra |");
  p("|---|---:|---:|---:|");
  // outcomes with money, biggest first; long lists (e.g. 58 candidates for prime minister) are cut at 12
  const rows = E.markets.map(m => ({ m,
    y: tr.filter(t => t[3] === m.outcome && t[4] === "yes").reduce((a, t) => a + t[2], 0),
    n: tr.filter(t => t[3] === m.outcome && t[4] === "no").reduce((a, t) => a + t[2], 0) }))
    .filter(x => x.y + x.n > 0);
  if (rows.length > 12) rows.sort((a, b) => (b.y + b.n) - (a.y + a.n));
  for (const { m, y, n } of rows.slice(0, 12)) p(`| ${m.outcome === "Yes" ? "Sí" : m.outcome}${isUltra(m.outcome) ? " (ultra)" : ""} | ${m.price == null ? "–" : pc(m.price, 1)} | ${money(y)} | ${money(n)} |`);
  if (rows.length > 12) p(`| …y otros ${rows.length - 12} resultados | | | |`);
  p("");
  // concentration
  const per = new Map();
  for (const t of tr) per.set(t[1], (per.get(t[1]) || 0) + t[2]);
  const top5 = [...per.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
  if (per.size >= MIN) p(`Las 5 billeteras más grandes ponen el ${pc(top5, tot)} del dinero.`);
  // whales: one wallet, one side of one outcome, $5,000+ within an hour
  const win = new Map();
  for (const t of tr) { const k = `${t[1]}|${t[3]}|${t[4]}|${Math.floor(t[0] / 3600)}`; win.set(k, (win.get(k) || 0) + t[2]); }
  const whales = [...win.entries()].filter(([, u]) => u >= 5000);
  const ws = new Set(whales.map(([k]) => k.split("|")[0]));
  p(whales.length ? `Ballenas (US$ 5.000+ en una hora): ${few(ws.size)} billeteras, ${whales.length} veces.` : "Ninguna ballena (US$ 5.000+ en una hora).");
  // biggest single bets (no wallet)
  const big = tr.filter(t => t[2] >= 1000).sort((a, b) => b[2] - a[2]).slice(0, 8);
  if (big.length) {
    p("");
    p("Apuestas individuales de US$ 1.000 o más:");
    p("");
    p("| Cuándo (Madrid) | Monto | Apuesta |");
    p("|---|---:|---|");
    for (const t of big) p(`| ${madTime(t[0])} | ${money(t[2])} | ${t[4] === "yes" ? "a favor de" : "en contra de"} «${t[3] === "Yes" ? "Sí" : t[3]}»${isUltra(t[3]) && t[4] === "yes" ? " (ultra)" : ""} |`);
  }
  p("");
  for (const t of tr) if (t[4] === "yes" && isUltra(t[3])) {
    allUltra.set(t[1], (allUltra.get(t[1]) || 0) + t[2]);
    const d = madDay(t[0]); dayUltra.set(d, (dayUltra.get(d) || 0) + t[2]);
  }
}

p("## Quién apuesta a una extrema derecha fuerte");
p("");
const uTot = [...allUltra.values()].reduce((a, b) => a + b, 0);
p(`En todos estos mercados, ${allUltra.size} billeteras pusieron ${money(uTot)} en apuestas ultra.`);
const inMain = [...allUltra.keys()].filter(w => mainWallets.has(w));
p(`${few(inMain.length)} de ellas también apuestan en el mercado principal (quién gana más escaños).`);
let withH = 0, inBr = 0, lula = 0, flavio = 0;
for (const w of allUltra.keys()) { const b = brazilOf(w); if (!b) continue; withH++; if (!b.none && b.lula + b.flavio > 0) { inBr++; lula += b.lula; flavio += b.flavio; } }
if (withH >= MIN) p(`De las ${withH} que tienen su historial leído, ${few(inBr)} también apostaron en la elección presidencial de Brasil${inBr >= MIN ? `: ${money(flavio)} a Flávio Bolsonaro y ${money(lula)} a Lula (${pc(flavio, flavio + lula)} a Flávio)` : ""}.`);
p("");
if (dayUltra.size) {
  p("Dinero en apuestas ultra por día (los días del 24 al 29 de noviembre, en negrita, son los de la veda de encuestas):");
  p("");
  p("| Día | Apuestas ultra |");
  p("|---|---:|");
  for (const [d, u] of [...dayUltra.entries()].sort()) {
    const veda = d >= "2026-11-24" && d <= "2026-11-29";
    p(`| ${veda ? "**" + d + "**" : d} | ${money(u)} |`);
  }
  p("");
}
fs.mkdirSync("analysis", { recursive: true });
fs.writeFileSync("analysis/otros-mercados.md", out.join("\n"));
console.log("wrote analysis/otros-mercados.md");
