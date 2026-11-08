// Compares every system layout (number of matches x column sizes) on today's real bulletin.
// Usage: node tests/system-research.mjs [events.json] [minOdd] [maxOdd] [budget]
import { readFileSync } from 'node:fs';
import { analyzeEvent } from '../js/model.js';
import { filterPicks, buildPool, optimizeSystem } from '../js/optimizer.js';
import { columnCount } from '../js/system.js';

const [file, minOdd = 2.0, maxOdd = 5.0, budget = 84] = process.argv.slice(2);
let events;
if (file && file !== '-') events = JSON.parse(readFileSync(file, 'utf8')).data.events;
else events = (await (await fetch('https://sportsbookv2.iddaa.com/sportsbook/events?st=1&type=0&version=0')).json()).data.events;
const now = Date.now() / 1000;
const YOUTH = /\bU-?(1[5-9]|2[0-3])\b|\(K\)|Kadın|Women|Femenin|Rezerv|Reserve|Amatör/i;
events = events.filter((e) => e.sid === 1 && e.d > now + 600 && !YOUTH.test(e.hn + ' ' + e.an));
const all = [];
for (const e of events) {
  const a = analyzeEvent(e, { oddField: 'wodd' });
  if (a) for (const p of a.picks) { p.league = e.ci; all.push(p); }
}
const groups = new Set(['MS', 'CS', 'AU', 'KG', 'HND', 'TAU', 'IY']);
console.log(`events ${events.length}, odds ${minOdd}-${maxOdd}, budget ${budget} TL`);

const rows = [];
for (let n = 3; n <= 10; n++) {
  for (let a = 2; a <= n; a++) {
    for (let b = a; b <= n; b++) {
      const sizes = []; for (let k = a; k <= b; k++) sizes.push(k);
      const cols = columnCount(n, sizes);
      const misli = Math.floor(budget / cols);
      if (misli < 1 || cols * misli < 50) continue;
      const picks = filterPicks(all, { minOdd: +minOdd, maxOdd: +maxOdd, groups, maxMbc: a });
      const pool = buildPool(picks, 3, n >= 8 ? 70 : 110);
      for (const objective of ['kar', 'deger']) {
        const r = optimizeSystem(pool, { n, sizes, misli, unit: 1, objective, seed: 7, maxPerLeague: 2 });
        if (!r) continue;
        const x = r.result;
        rows.push({ sys: `${n} maç ${sizes.join('-')}`, objective, cols, misli, stake: x.stake, ev: x.evRatio, pProfit: x.pProfit, pGood: x.pGood, pBig: x.pBig, max: x.maxPay, avgOdd: r.picks.reduce((s, p) => s + p.odd, 0) / n, minHit: x.byHits.find((h) => h.minPay > x.stake)?.k });
      }
    }
  }
}
const show = (title, list) => {
  console.log(`\n${title}`);
  console.log('sistem'.padEnd(26), 'kolon misli bedel  EV   P(kâr) P(+25%) P(10x)  maks   ort.oran kâr için');
  for (const r of list) console.log(r.sys.padEnd(26), String(r.cols).padStart(5), String(r.misli).padStart(5), String(r.stake).padStart(5), r.ev.toFixed(3), (r.pProfit * 100).toFixed(1).padStart(6), (r.pGood * 100).toFixed(1).padStart(6), (r.pBig * 100).toFixed(1).padStart(6), String(Math.round(r.max)).padStart(7), r.avgOdd.toFixed(2).padStart(7), (r.minHit ?? '-') + ' tutmalı');
};
const kar = rows.filter((r) => r.objective === 'kar').sort((x, y) => (y.pGood + 0.5 * (y.ev - 1)) - (x.pGood + 0.5 * (x.ev - 1)));
show('En iyi 15 (kâr şansı hedefi)', kar.slice(0, 15));
show('Popüler sistemler (kâr şansı hedefi)', kar.filter((r) => ['6 maç 3-4-5-6', '5 maç 3-4-5', '6 maç 3', '6 maç 4-5-6', '7 maç 3', '8 maç 3', '6 maç 2'].includes(r.sys)));
const ev = rows.filter((r) => r.objective === 'deger').sort((x, y) => y.ev - x.ev);
show('En iyi 10 (beklenen getiri hedefi)', ev.slice(0, 10));
