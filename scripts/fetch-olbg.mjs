// Fetches OLBG football tipster consensus and writes data/olbg.json for the app.
// Runs a few times a day from .github/workflows/olbg.yml (OLBG's robots.txt allows it).
// Usage: node scripts/fetch-olbg.mjs [outFile]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = process.argv[2] || 'data/olbg.json';
// The site's own page data (SvelteKit "__data.json"): the top tips plus the competition pages.
const PAGES = ['', 'UK/', 'International/', 'European_Competitions/', 'UEFA_Competitions/', 'World_Competitions/'];
const UA = 'SistemKupon/1.0 (+https://aliaskin.github.io/-ddiaa/)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SvelteKit serializes data with "devalue": every value is an index into one flat array.
function revive(arr, i, seen = new Map()) {
  if (typeof i !== 'number' || i < 0) return null;
  if (seen.has(i)) return seen.get(i);
  const v = arr[i];
  if (Array.isArray(v)) {
    if (typeof v[0] === 'string' && ['Date', 'Set', 'Map', 'BigInt', 'RegExp'].includes(v[0])) return v[1] ?? null;
    const out = [];
    seen.set(i, out);
    for (const x of v) out.push(revive(arr, x, seen));
    return out;
  }
  if (v && typeof v === 'object') {
    const out = {};
    seen.set(i, out);
    for (const [k, x] of Object.entries(v)) out[k] = revive(arr, x, seen);
    return out;
  }
  return v;
}

async function tipsOf(path) {
  const url = `https://www.olbg.com/betting-tips/Football/${path}1/__data.json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const d = await r.json();
  const nodes = (d.nodes || []).filter((n) => n && n.type === 'data');
  for (const n of nodes.reverse()) {
    const root = revive(n.data, 0);
    if (root && Array.isArray(root.tips)) return root.tips;
  }
  return [];
}

const all = new Map();
let ok = 0;
for (const p of PAGES) {
  try {
    const tips = await tipsOf(p);
    ok++;
    for (const t of tips) if (t && t.id) all.set(t.id, t);
    console.log(`${p || 'top'}: ${tips.length} tips`);
  } catch (e) {
    console.log(`${p || 'top'}: ${e.message}`);
  }
  await sleep(1500);
}
if (!ok) {
  console.error('OLBG could not be read, keeping the previous file');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const tips = [...all.values()]
  .filter((t) => !t.expired && t.event_start_unix_timestamp > now - 3 * 3600 && t.event_start_unix_timestamp < now + 4 * 86400)
  .map((t) => {
    const [home, away] = String(t.event_name_alias || '').split(' v ');
    return {
      home: (home || '').replace(/&amp;/g, '&').trim(),
      away: (away || '').replace(/&amp;/g, '&').trim(),
      league: t.menu_league || '',
      t: t.event_start_unix_timestamp,
      market: t.market_alias || '',
      sel: String(t.selection || '').replace(/&amp;/g, '&'),
      odds: Number(t.odds) || null,
      win: t.win_tips ?? null, // tipsters on this selection
      total: t.win_tips_count ?? null, // tipsters on the match
      conf: t.confidence ?? null,
      stars: t.stars_rating ?? null,
      url: t.eventUrl ? `https://www.olbg.com${t.eventUrl}` : null,
    };
  })
  .filter((t) => t.home && t.away)
  .sort((a, b) => a.t - b.t || (b.win || 0) - (a.win || 0));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: 'olbg.com', updatedAt: now, tips }, null, 0) + '\n');
console.log(`wrote ${tips.length} tips to ${OUT}`);
