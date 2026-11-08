// High-odds check: full event markets, odds 5-30, 6 matches system 3-4-5-6, 2 misli, 10k target.
// Usage: NODE_USE_ENV_PROXY=1 node tests/high-odds-check.mjs
import { analyzeEvent } from '../js/model.js';
import { filterPicks, buildPool, optimizeSystem } from '../js/optimizer.js';
import { simulateCoupon } from '../js/system.js';

const SB = 'https://sportsbookv2.iddaa.com/sportsbook';
const get = async (u) => (await (await fetch(u)).json()).data;
const now = Date.now() / 1000;
const end = now + 20 * 3600;
const YOUTH = /\bU-?(1[5-9]|2[0-3])\b|\(K\)|Kadın|Women|Femenin|Rezerv|Reserve|Amatör/i;
let events = (await get(`${SB}/events?st=1&type=0&version=0`)).events.filter((e) => e.sid === 1 && e.d > now + 600 && e.d < end && !YOUTH.test(e.hn + e.an));
const mc = (await get(`${SB}/get_market_config`)).m;
const names = Object.fromEntries(Object.entries(mc).map(([k, v]) => [k, v.n]));
let t = performance.now();
const details = [];
for (let i = 0; i < events.length; i += 8) {
  details.push(...await Promise.all(events.slice(i, i + 8).map((e) => get(`${SB}/event/${e.i}`).catch(() => null))));
}
console.log(`events ${events.length}, details in ${((performance.now() - t) / 1000).toFixed(1)} s`);
events = events.map((e, i) => (details[i]?.m?.length ? { ...e, m: details[i].m } : e));

t = performance.now();
const all = [];
const byEv = new Map(events.map((e) => [e.i, e]));
for (const e of events) {
  const a = analyzeEvent(e, { oddField: 'odd', oddRange: [5, 30], marketNames: names });
  if (a) for (const p of a.picks) { p.league = e.ci; all.push(p); }
}
console.log(`analysed in ${(performance.now() - t).toFixed(0)} ms, picks 5-30: ${all.length}`);

// how far the model is from each market's own fair price, by market group
const g = {};
for (const p of all) if (p.pModel !== null && p.pFair !== null) {
  const x = (g[p.group] ||= { n: 0, model: 0, fair: 0, v: 0 });
  x.n++; x.model += p.pModel * p.odd; x.fair += p.pFair * p.odd; x.v += p.v;
}
for (const [k, x] of Object.entries(g)) console.log(k.padEnd(6), 'n', String(x.n).padStart(4), 'v_model', (x.model / x.n).toFixed(3), 'v_fair', (x.fair / x.n).toFixed(3), 'v', (x.v / x.n).toFixed(3));

const picks = filterPicks(all, { minOdd: 5, maxOdd: 30, maxMbc: 3, minProb: 0.03 });
const pool = buildPool(picks, 4, 160);
console.log('top value picks:');
for (const p of pool.slice(0, 12)) { const e = byEv.get(p.eventId); console.log('  ', `${e.hn} - ${e.an}`.padEnd(42), p.label.padEnd(28), p.odd.toFixed(2), (p.p * 100).toFixed(1) + '%', 'v', p.v.toFixed(3)); }

for (const objective of ['hedef', 'kar', 'deger']) {
  t = performance.now();
  const r = optimizeSystem(pool, { n: 6, sizes: [3, 4, 5, 6], misli: 2, unit: 1, objective, target: 10000, seed: 3, maxPerLeague: 2 });
  const x = r.result;
  console.log(`\n== ${objective} (${(performance.now() - t).toFixed(0)} ms) stake ${x.stake} EV ${x.evRatio.toFixed(3)} P(para) ${(x.pReturn * 100).toFixed(2)}% P(kâr) ${(x.pProfit * 100).toFixed(2)}% P(>=10k) ${(x.pTarget * 100).toFixed(3)}% max ${Math.round(x.maxPay)}`);
  for (const p of r.picks) { const e = byEv.get(p.eventId); console.log('  ', `${e.hn} - ${e.an}`.padEnd(42), p.label.padEnd(28), p.odd.toFixed(2), (p.p * 100).toFixed(1) + '%', 'v', p.v.toFixed(3), 'mbc', p.mbc); }
  for (const b of x.byHits) if (b.k >= 3) console.log('     ', b.k, 'tutarsa', (b.prob * 100).toFixed(3) + '%', Math.round(b.minPay), '-', Math.round(b.maxPay), 'TL');
  const sim = simulateCoupon(r.picks, [3, 4, 5, 6], 2, 1, { runs: 10000, seed: 11, target: 10000 });
  console.log('     10.000 simülasyon: hits', sim.hits.join('/'), 'para aldı', sim.anyPay, 'kâr', sim.profit, '>=10k', sim.reached, 'en iyi', Math.round(sim.best));
}
