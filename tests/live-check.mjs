// Runs the model and optimizer against live iddaa data (or a saved events JSON file).
// Usage: node tests/live-check.mjs [events.json]
import { readFileSync } from 'node:fs';
import { analyzeEvent } from '../js/model.js';
import { filterPicks, buildPool, optimizeSystem, findTargetCombos } from '../js/optimizer.js';
import { evaluateSystem } from '../js/system.js';

const file = process.argv[2];
let events;
if (file) {
  events = JSON.parse(readFileSync(file, 'utf8')).data.events;
} else {
  const r = await fetch('https://sportsbookv2.iddaa.com/sportsbook/events?st=1&type=0&version=0');
  events = (await r.json()).data.events;
}
const now = Date.now() / 1000;
events = events.filter((e) => e.sid === 1 && e.d > now + 300);
console.log('events', events.length);

const t0 = performance.now();
const analyses = [];
for (const e of events) {
  const a = analyzeEvent(e, { oddField: 'wodd' });
  if (a) { a.picks.forEach((p) => { p.league = e.ci; p.ev = e; }); analyses.push([e, a]); }
}
const t1 = performance.now();
console.log(`analysed ${analyses.length} in ${(t1 - t0).toFixed(0)} ms`);

// fit quality: model vs fair for 1X2
let errs = [];
for (const [e, a] of analyses) {
  for (const p of a.picks) if (p.pFair !== null) errs.push(Math.abs(p.pModel - p.pFair));
}
errs.sort((x, y) => x - y);
console.log('model-vs-fair abs err median', errs[errs.length >> 1].toFixed(4), 'p90', errs[Math.floor(errs.length * 0.9)].toFixed(4), 'max', errs[errs.length - 1].toFixed(4));

const [e0, a0] = analyses.find(([e]) => e.an === 'Barcelona') || analyses[0];
console.log(e0.hn, '-', e0.an, 'lh', a0.lh.toFixed(2), 'la', a0.la.toFixed(2), 'rho', a0.rho.toFixed(3), 'f', a0.half.toFixed(3), 'margin', a0.margin.toFixed(3));
for (const p of a0.picks.slice(0, 20)) console.log('  ', p.label.padEnd(22), p.odd.toFixed(2), 'p', p.p.toFixed(3), 'fair', p.pFair?.toFixed(3), 'v', p.v.toFixed(3));

const all = analyses.flatMap(([, a]) => a.picks);
const allowed = filterPicks(all, { minOdd: 1.4, maxOdd: 3.2, groups: new Set(['MS', 'CS', 'AU', 'KG', 'HND', 'TAU']), maxMbc: 3 });
const pool = buildPool(allowed);
console.log('allowed', allowed.length, 'pool', pool.length, 'top v', pool.slice(0, 5).map((p) => p.label + '@' + p.odd + ' v' + p.v.toFixed(3)));

for (const objective of ['hedef', 'kar', 'deger']) {
  const t2 = performance.now();
  const r = optimizeSystem(pool, { n: 6, sizes: [3, 4, 5, 6], misli: 2, unit: 1, objective, target: 10000, seed: 42 });
  const t3 = performance.now();
  console.log(`\n== ${objective} (${(t3 - t2).toFixed(0)} ms) stake ${r.result.stake} EV ${r.result.evRatio.toFixed(3)} P(kar) ${(r.result.pProfit * 100).toFixed(1)}% P(25%+) ${(r.result.pGood * 100).toFixed(1)}% P(10x) ${(r.result.pBig * 100).toFixed(1)}% max ${r.result.maxPay.toFixed(0)}`);
  for (const p of r.picks) console.log('  ', `${p.ev.hn} - ${p.ev.an}`.padEnd(45), p.label.padEnd(18), p.odd.toFixed(2), (p.p * 100).toFixed(1) + '%', 'v', p.v.toFixed(3), 'mbc', p.mbc);
  for (const b of r.result.byHits) if (b.k >= 3) console.log('     hits', b.k, (b.prob * 100).toFixed(1) + '%', 'pay', b.minPay.toFixed(1), '-', b.maxPay.toFixed(1));
}

const combos = findTargetCombos(filterPicks(all, { minOdd: 1.2, maxOdd: 6, groups: new Set(['MS', 'CS', 'AU', 'KG', 'HND', 'TAU']), maxMbc: 4 }), { target: 10 });
console.log('\n10 oran kombinasyonları');
for (const c of combos) console.log('  k', c.k, 'oran', c.totalOdd.toFixed(2), 'olasılık', (c.prob * 100).toFixed(1) + '%', c.picks.map((p) => `${p.ev.hn}-${p.ev.an} ${p.label}@${p.odd}`).join(' | '));

// sanity check of system maths against the user's example: 6 picks, 3-4-5-6, 2 misli = 84 TL
const s = evaluateSystem(Array.from({ length: 6 }, () => ({ p: 0.5, odd: 2 })), [3, 4, 5, 6], 2, 1);
console.log('\nsanity: columns', s.columns, 'stake', s.stake, 'max pay (all 6 at 2.00)', s.maxPay);
if (s.columns !== 42 || s.stake !== 84 || s.maxPay !== 1312) { console.error('SYSTEM MATH MISMATCH'); process.exit(1); }
