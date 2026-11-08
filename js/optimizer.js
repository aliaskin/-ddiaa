// Coupon optimizer: chooses one pick per match so that the chosen system
// (e.g. 3-4-5-6 with 6 matches) maximizes the selected objective.

import { quickEval, evaluateSystem, columnCount } from './system.js?v=5';

export const OBJECTIVES = {
  hedef: { name: 'Hedef kazanç', desc: 'Belirlediğin hedef kazanca (ör. 10.000 TL) ulaşma olasılığını en yükseğe çıkarır.', f: (r) => r.pTarget + 0.01 * (r.evRatio - 1) },
  kar: { name: 'Kâr şansı', desc: 'Kuponun en az %25 kârla bitme olasılığını en yükseğe çıkarır.', f: (r) => r.pGood + 1.0 * (r.evRatio - 1) },
  deger: { name: 'Beklenen getiri', desc: 'Uzun vadede TL başına beklenen dönüşü en yükseğe çıkarır.', f: (r) => r.evRatio + 0.1 * r.pProfit },
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Filter all picks to the ones allowed by the settings.
// opts: { minOdd, maxOdd, groups:Set, maxMbc, excluded:Set, minProb }
export function filterPicks(allPicks, opts) {
  return allPicks.filter((p) =>
    p.odd >= opts.minOdd && p.odd <= opts.maxOdd &&
    (!opts.groups || opts.groups.has(p.group)) &&
    (p.mbc ?? 1) <= opts.maxMbc &&
    !(opts.excluded && opts.excluded.has(p.eventId)) &&
    p.p >= (opts.minProb ?? 0.03));
}

// Keep a manageable pool: best few picks per match, ranked by value.
export function buildPool(picks, perEvent = 4, size = 160) {
  const byEvent = new Map();
  for (const p of picks) {
    if (!byEvent.has(p.eventId)) byEvent.set(p.eventId, []);
    byEvent.get(p.eventId).push(p);
  }
  const pool = [];
  for (const list of byEvent.values()) {
    list.sort((a, b) => b.v - a.v);
    pool.push(...list.slice(0, perEvent));
  }
  pool.sort((a, b) => b.v - a.v);
  return pool.slice(0, size);
}

function makeScorer(sizes, misli, unit, n, objective, target = Infinity) {
  const columns = columnCount(n, sizes);
  const stake = columns * misli * unit;
  const fn = (OBJECTIVES[objective] || OBJECTIVES.kar).f;
  const ps = new Float64Array(n), os = new Float64Array(n);
  return (set) => {
    for (let i = 0; i < n; i++) { ps[i] = set[i].p; os[i] = set[i].odd; }
    return fn(quickEval(ps, os, sizes, stake, misli * unit, target));
  };
}

function conflicts(set, cand, skip, maxPerLeague) {
  let league = 0;
  for (let i = 0; i < set.length; i++) {
    if (i === skip || !set[i]) continue;
    if (set[i].eventId === cand.eventId) return true;
    if (cand.league && set[i].league === cand.league) league++;
  }
  return maxPerLeague > 0 && league >= maxPerLeague;
}

// opts: { n, sizes, misli, unit, objective, locked:[pick], seed, maxPerLeague, effort: 'light'|'medium'|'full' }
export function optimizeSystem(pool, opts) {
  const effort = opts.effort || 'full';
  const randomStarts = effort === 'light' ? 0 : effort === 'medium' ? 2 : 4;
  const ilsRounds = effort === 'light' ? 0 : effort === 'medium' ? 3 : 8;
  const maxPasses = effort === 'light' ? 3 : 25;
  const n = opts.n;
  const sizes = opts.sizes.filter((k) => k <= n);
  const locked = (opts.locked || []).slice(0, n);
  const maxPerLeague = opts.maxPerLeague ?? 2;
  const score = makeScorer(sizes, opts.misli, opts.unit ?? 1, n, opts.objective, opts.target);
  const rnd = mulberry32(opts.seed ?? 1);
  const free = n - locked.length;
  const cand = pool.filter((c) => !locked.some((l) => l.eventId === c.eventId));
  if (cand.length === 0 && free > 0) return null;

  const fill = (order) => {
    const set = locked.slice();
    for (const c of order) {
      if (set.length >= n) break;
      if (!conflicts(set, c, -1, maxPerLeague)) set.push(c);
    }
    return set.length === n ? set : null;
  };

  const climb = (set) => {
    let best = score(set);
    let improved = true, guard = 0;
    while (improved && guard++ < maxPasses) {
      improved = false;
      for (let i = locked.length; i < n; i++) {
        let bi = null, bs = best;
        for (const c of cand) {
          if (c === set[i] || conflicts(set, c, i, maxPerLeague)) continue;
          const old = set[i];
          set[i] = c;
          const s = score(set);
          set[i] = old;
          if (s > bs + 1e-12) { bs = s; bi = c; }
        }
        if (bi) { set[i] = bi; best = bs; improved = true; }
      }
    }
    return { set, s: best };
  };

  let best = null;
  const starts = [];
  const s0 = fill(cand);
  if (s0) starts.push(s0);
  // value-ordered start restricted to a typical odds band
  const mid = fill(cand.filter((c) => c.odd >= 1.7 && c.odd <= 2.5).concat(cand));
  if (mid && effort !== 'light') starts.push(mid);
  for (let r = 0; r < randomStarts; r++) {
    const top = cand.slice(0, Math.min(cand.length, 60));
    const shuffled = top.map((c) => [rnd(), c]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    const s = fill(shuffled.concat(cand));
    if (s) starts.push(s);
  }
  if (!starts.length) return null;
  for (const st of starts) {
    const r = climb(st.slice());
    if (!best || r.s > best.s) best = { set: r.set.slice(), s: r.s };
  }
  // iterated local search: perturb two free slots and climb again
  for (let it = 0; it < ilsRounds && free >= 2; it++) {
    const set = best.set.slice();
    for (let j = 0; j < 2; j++) {
      const i = locked.length + Math.floor(rnd() * free);
      for (let tries = 0; tries < 30; tries++) {
        const c = cand[Math.floor(rnd() * cand.length)];
        if (!conflicts(set, c, i, maxPerLeague)) { set[i] = c; break; }
      }
    }
    const r = climb(set);
    if (r.s > best.s) best = { set: r.set.slice(), s: r.s };
  }
  const picks = best.set;
  return { picks, score: best.s, result: evaluateSystem(picks, sizes, opts.misli, opts.unit ?? 1, opts.target) };
}

// Alternatives for one slot of an existing coupon, best first.
export function alternativesFor(pool, picks, slot, opts, limit = 8) {
  const n = picks.length;
  const sizes = opts.sizes.filter((k) => k <= n);
  const score = makeScorer(sizes, opts.misli, opts.unit ?? 1, n, opts.objective, opts.target);
  const set = picks.slice();
  const out = [];
  for (const c of pool) {
    if (c.id === picks[slot].id || conflicts(set, c, slot, opts.maxPerLeague ?? 2)) continue;
    set[slot] = c;
    out.push({ pick: c, s: score(set) });
  }
  out.sort((a, b) => b.s - a.s);
  const seen = new Set();
  const res = [];
  for (const o of out) {
    if (seen.has(o.pick.eventId)) continue;
    seen.add(o.pick.eventId);
    res.push(o);
    if (res.length >= limit) break;
  }
  return res;
}

// Find k-match combinations whose total odds is close to a target (e.g. 10).
// Ranks by probability that every pick wins.
export function findTargetCombos(picks, { target = 10, lo = 0.9, hi = 1.15, ks = [2, 3, 4], top = 5 } = {}) {
  const results = [];
  for (const k of ks) {
    const each = Math.pow(target, 1 / k);
    const poolSize = k === 2 ? 200 : k === 3 ? 84 : k === 4 ? 42 : 30;
    const loO = each / 1.7, hiO = each * 1.7;
    // stratify by odds so the pool covers low and high prices, best value in each band
    const bins = 6;
    const banded = Array.from({ length: bins }, () => []);
    for (const p of picks) {
      if ((p.mbc ?? 1) > k || p.odd < loO || p.odd > hiO) continue;
      const b = Math.min(bins - 1, Math.floor((Math.log(p.odd / loO) / Math.log(hiO / loO)) * bins));
      banded[b].push(p);
    }
    const cand = [];
    for (const list of banded) cand.push(...buildPool(list, 2, Math.ceil(poolSize / bins)));
    const min = target * lo, max = target * hi;
    const found = [];
    const cur = [];
    const rec = (start, odd, prob) => {
      if (cur.length === k) {
        if (odd >= min && odd <= max) found.push({ picks: cur.slice(), totalOdd: odd, prob, ev: prob * odd });
        return;
      }
      for (let i = start; i < cand.length; i++) {
        const c = cand[i];
        if (cur.some((x) => x.eventId === c.eventId)) continue;
        const no = odd * c.odd;
        if (no > max) continue;
        cur.push(c);
        rec(i + 1, no, prob * c.p);
        cur.pop();
      }
    };
    rec(0, 1, 1);
    // total odds are all close to the target, so rank by expected return (prob * odds)
    found.sort((a, b) => b.ev - a.ev);
    // avoid near-duplicates: limit how often one pick appears
    const used = new Map();
    const chosen = [];
    for (const f of found) {
      if (f.picks.some((p) => (used.get(p.id) || 0) >= 2)) continue;
      f.picks.forEach((p) => used.set(p.id, (used.get(p.id) || 0) + 1));
      chosen.push({ ...f, k });
      if (chosen.length >= top) break;
    }
    results.push(...chosen);
  }
  return results;
}
