// OLBG tipster consensus (data/olbg.json, refreshed by a GitHub workflow) matched to iddaa matches.
// Shown as extra information only; it does not change any probability.

const SOURCES = [
  // raw GitHub copy is updated right after the workflow commits; the site copy after the Pages rebuild
  'https://raw.githubusercontent.com/aliaskin/-ddiaa/claude/inspiring-allen-oy590c/data/olbg.json',
  'data/olbg.json',
];

export async function fetchOlbg() {
  for (const u of SOURCES) {
    try {
      const r = await fetch(`${u}?t=${Math.floor(Date.now() / 300000)}`, { cache: 'no-store' });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j?.tips)) return j;
    } catch { /* try the next copy */ }
  }
  return null;
}

// Turkish names iddaa uses for some countries / teams
const ALIASES = {
  abd: 'usa', marsilya: 'marseille', munih: 'munich', 'dominik cumhuriyeti': 'dominican republic',
  adalari: 'islands', ve: '&', 'kuzey irlanda': 'northern ireland', 'guney kore': 'south korea',
  ingiltere: 'england', galler: 'wales', iskocya: 'scotland', irlanda: 'ireland', almanya: 'germany',
  fransa: 'france', ispanya: 'spain', italya: 'italy', hollanda: 'netherlands', belcika: 'belgium',
  portekiz: 'portugal', isvicre: 'switzerland', avusturya: 'austria', hirvatistan: 'croatia', sirbistan: 'serbia',
  yunanistan: 'greece', turkiye: 'turkey', polonya: 'poland', cekya: 'czech', danimarka: 'denmark',
  isvec: 'sweden', norvec: 'norway', finlandiya: 'finland', macaristan: 'hungary', romanya: 'romania',
  arjantin: 'argentina', brezilya: 'brazil', meksika: 'mexico', kolombiya: 'colombia', sili: 'chile',
  japonya: 'japan', 'suudi arabistan': 'saudi arabia', avustralya: 'australia', misir: 'egypt', fas: 'morocco',
};
const DROP = new Set(['fc', 'cf', 'sc', 'afc', 'ac', 'fk', 'club', 'cd', 'ca', 'sd', 'sk', 'bk', 'if', 'de', 'the', 'calcio', 'sport', 'sporting']);

export function normName(x) {
  let s = String(x || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ı/g, 'i').replace(/&amp;/g, '&').replace(/\butd\b/g, 'united').replace(/\bst\.?\b/g, 'saint');
  for (const [k, v] of Object.entries(ALIASES)) s = s.replace(new RegExp(`\\b${k}\\b`, 'g'), v);
  return s.replace(/[^a-z0-9& ]+/g, ' ').split(/\s+/).filter((w) => w && !DROP.has(w)).join(' ');
}

function sim(a, b) {
  const x = normName(a), y = normName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const cx = x.replace(/ /g, ''), cy = y.replace(/ /g, '');
  if ((cx.length >= 4 && cy.includes(cx)) || (cy.length >= 4 && cx.includes(cy))) return 0.9;
  const tx = x.split(' ').filter((w) => w.length >= 4), ty = new Set(y.split(' ').filter((w) => w.length >= 4));
  if (tx.some((w) => ty.has(w))) return 0.7;
  if (cx.slice(0, 5) === cy.slice(0, 5) && cx.length >= 5) return 0.6;
  return 0;
}

// Returns Map(eventId -> tips[]) for the given iddaa events.
export function matchOlbg(data, events) {
  const out = new Map();
  if (!data?.tips?.length) return out;
  for (const tip of data.tips) {
    let best = null, bestScore = 0;
    for (const e of events) {
      if (Math.abs(e.d - tip.t) > 900) continue;
      const s = sim(tip.home, e.hn) + sim(tip.away, e.an);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (!best || bestScore < 0.6) continue;
    if (!out.has(best.i)) out.set(best.i, []);
    out.get(best.i).push({ ...tip, side: tipSide(tip, best) });
  }
  for (const list of out.values()) list.sort((a, b) => (b.win || 0) - (a.win || 0));
  return out;
}

// For a "Full Time Result" tip: which outcome the tipsters back ('H', 'D', 'A').
function tipSide(tip, e) {
  if (tip.market !== 'Full Time Result') return null;
  if (/^draw$/i.test(tip.sel)) return 'D';
  const h = sim(tip.sel, tip.home) || sim(tip.sel, e.hn), a = sim(tip.sel, tip.away) || sim(tip.sel, e.an);
  return h > a ? 'H' : a > h ? 'A' : null;
}

const MARKET_TR = { 'Full Time Result': 'MS', 'Total Goals': 'Toplam gol', 'Asian Hcap': 'Asya handikap', 'Half Time / Full Time': 'İY/MS' };
export const marketTr = (m) => MARKET_TR[m] || m;

// Does the main tipster pick agree with our pick? Our pick's own full-time stance comes
// from where its probability sits (winH / winA = share of its winning scores won by home / away).
export function agreement(pick, tips) {
  const ft = tips?.find((t) => t.side);
  if (!ft) return null;
  let ours = null;
  if ((pick.key === '1_1' && pick.no === 2) || (pick.winH !== null && pick.winH !== undefined && pick.winH + (pick.winA ?? 0) < 0.05)) ours = 'D';
  else if ((pick.winH ?? 0) > 0.95) ours = 'H';
  else if ((pick.winA ?? 0) > 0.95) ours = 'A';
  if (!ours) return null;
  return ours === ft.side;
}
