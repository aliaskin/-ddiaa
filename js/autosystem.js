// Automatic system finder.
// Tries every system layout (number of matches x contiguous column sizes) that fits the budget,
// optimizes the picks for each one and ranks the layouts by the chosen objective.
//
// Why this matters: a column of k picks returns about v^k per TL (v = odds x probability,
// ~0.85-0.88 on iddaa), so small columns (2'li, 3'lü) lose far less than big ones (5'li, 6'lı).
// Which small layout is possible depends on the day's MBS values, so the best system changes daily.

import { buildPool, optimizeSystem, hashString } from './optimizer.js?v=6';
import { columnCount } from './system.js?v=6';

// cfg: { minN, maxN, budget, minStake, unit, minSize (default 2), lockedCount, lockedMbc }
export function systemLayouts(cfg) {
  const out = [];
  const unit = cfg.unit || 1;
  for (let n = Math.max(cfg.minN, cfg.lockedCount || 0, 2); n <= cfg.maxN; n++) {
    for (let a = Math.max(cfg.minSize || 2, cfg.lockedMbc || 1); a <= n; a++) {
      for (let b = a; b <= n; b++) {
        const sizes = [];
        for (let k = a; k <= b; k++) sizes.push(k);
        const cols = columnCount(n, sizes);
        const misli = Math.floor(cfg.budget / (cols * unit) + 1e-9);
        if (misli < 1) continue;
        const stake = cols * misli * unit;
        if (stake < (cfg.minStake || 0)) continue;
        out.push({ n, sizes, cols, misli, unit, stake });
      }
    }
  }
  return out;
}

// picks: eligible picks of all MBS values. opts: { objective, locked, maxPerLeague, seedBase }
// Returns { ranking: [{ sys, ids, score, metrics }] } best first.
export function searchSystems(picks, cfg, opts, onProgress) {
  const locked = opts.locked || [];
  const lockedMbc = locked.reduce((m, p) => Math.max(m, p.mbc ?? 1), 1);
  const layouts = systemLayouts({ ...cfg, lockedCount: locked.length, lockedMbc });
  const pools = new Map();
  const poolFor = (a, size) => {
    const key = `${a}|${size}`;
    if (!pools.has(key)) pools.set(key, buildPool(picks.filter((p) => (p.mbc ?? 1) <= a), 3, size));
    return pools.get(key);
  };
  const run = (L, effort, poolSize) => {
    const pool = poolFor(L.sizes[0], poolSize);
    if (pool.length + locked.length < L.n) return null;
    const r = optimizeSystem(pool, {
      n: L.n, sizes: L.sizes, misli: L.misli, unit: L.unit, objective: opts.objective, target: opts.target,
      locked, maxPerLeague: opts.maxPerLeague, effort,
      seed: hashString(`${opts.seedBase}|${L.n}|${L.sizes.join(',')}`),
    });
    if (!r || r.picks.length < L.n) return null;
    return { sys: L, ids: r.picks.map((p) => p.id), score: r.score, metrics: pickMetrics(r.result) };
  };

  // Stage 1: quick pass over every layout.
  const quick = [];
  const total = layouts.length + 4;
  layouts.forEach((L, i) => {
    const r = run(L, 'light', 45);
    if (r) quick.push(r);
    if (onProgress) onProgress(i + 1, total);
  });
  quick.sort((x, y) => y.score - x.score);

  // Stage 2: thorough optimization of the most promising layouts.
  const finals = [];
  quick.slice(0, 4).forEach((q, i) => {
    const r = run(q.sys, 'medium', 90);
    finals.push(r && r.score >= q.score ? r : q);
    if (onProgress) onProgress(layouts.length + i + 1, total);
  });
  finals.sort((x, y) => y.score - x.score);
  const seen = new Set(finals.map((f) => key(f.sys)));
  const ranking = finals.concat(quick.filter((q) => !seen.has(key(q.sys))).slice(0, 4));
  return { ranking, tried: layouts.length };
}

function key(s) { return `${s.n}|${s.sizes.join(',')}`; }

function pickMetrics(r) {
  return { ev: r.ev, evRatio: r.evRatio, pProfit: r.pProfit, pGood: r.pGood, pBig: r.pBig, pTarget: r.pTarget, pReturn: r.pReturn, maxPay: r.maxPay };
}
