// System bet maths (e.g. 6 picks, system 3-4-5-6).
// A column wins only if every pick in it wins; payout of a winning column = misli * unit * product(odds).

// "Good day" threshold: payout at least 25% above the stake.
export const GOOD = 1.25;

export function nCr(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

export function columnCount(n, sizes) {
  return sizes.reduce((s, k) => s + nCr(n, k), 0);
}

// elementary symmetric polynomials e_0..e_n of values xs
function elemSym(xs) {
  const e = new Float64Array(xs.length + 1);
  e[0] = 1;
  for (const x of xs) {
    for (let k = e.length - 1; k >= 1; k--) e[k] += e[k - 1] * x;
  }
  return e;
}

// Total payout for the subset of winning odds.
export function payoutFor(hitOdds, sizes, misli = 1, unit = 1) {
  const e = elemSym(hitOdds);
  let sum = 0;
  for (const k of sizes) if (k <= hitOdds.length) sum += e[k];
  return sum * misli * unit;
}

// picks: [{p, odd}] ; returns full outcome distribution summary.
export function evaluateSystem(picks, sizes, misli = 1, unit = 1) {
  const n = picks.length;
  const valid = sizes.filter((k) => k >= 1 && k <= n);
  const columns = columnCount(n, valid);
  const stake = columns * misli * unit;
  const byHits = Array.from({ length: n + 1 }, (_, k) => ({ k, prob: 0, minPay: Infinity, maxPay: 0, wsum: 0 }));
  let ev = 0, pProfit = 0, pReturn = 0, pBig = 0, pGood = 0;
  const total = 1 << n;
  const odds = new Array(n);
  for (let mask = 0; mask < total; mask++) {
    let prob = 1, c = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { prob *= picks[i].p; odds[c++] = picks[i].odd; }
      else prob *= 1 - picks[i].p;
    }
    const pay = c >= Math.min(...valid) ? payoutFor(odds.slice(0, c), valid, misli, unit) : 0;
    ev += prob * pay;
    if (pay > stake) pProfit += prob;
    if (pay >= stake * GOOD) pGood += prob;
    if (pay > 0) pReturn += prob;
    if (pay >= stake * 10) pBig += prob;
    const b = byHits[c];
    b.prob += prob;
    b.wsum += prob * pay;
    if (pay < b.minPay) b.minPay = pay;
    if (pay > b.maxPay) b.maxPay = pay;
  }
  for (const b of byHits) {
    b.avgPay = b.prob > 0 ? b.wsum / b.prob : 0;
    if (b.minPay === Infinity) b.minPay = 0;
    delete b.wsum;
  }
  const allOdds = picks.map((p) => p.odd);
  return {
    n, sizes: valid, columns, stake, misli, unit,
    ev, evRatio: stake > 0 ? ev / stake : 0,
    pProfit, pGood, pReturn, pBig,
    maxPay: payoutFor(allOdds, valid, misli, unit),
    byHits,
  };
}

// Fast objective evaluation (no per-hit table), used inside the optimizer.
// Depth-first over hit/miss of each pick, updating the symmetric polynomials incrementally,
// and skipping branches that can no longer reach the smallest column size (they pay 0).
const stackCache = new Map();
export function quickEval(ps, os, sizes, stake, misliUnit) {
  const n = ps.length;
  const minK = Math.min(...sizes);
  let st = stackCache.get(n);
  if (!st) { st = Array.from({ length: n + 1 }, () => new Float64Array(n + 1)); stackCache.set(n, st); }
  st[0].fill(0); st[0][0] = 1;
  const nS = sizes.length;
  let ev = 0, pProfit = 0, pBig = 0, pGood = 0;
  const good = stake * GOOD, big = stake * 10;
  const rec = (i, c, prob) => {
    if (c + (n - i) < minK) return;
    if (i === n) {
      const e = st[n];
      let pay = 0;
      for (let j = 0; j < nS; j++) { const k = sizes[j]; if (k <= c) pay += e[k]; }
      pay *= misliUnit;
      ev += prob * pay;
      if (pay > stake) pProfit += prob;
      if (pay >= good) pGood += prob;
      if (pay >= big) pBig += prob;
      return;
    }
    const cur = st[i], nxt = st[i + 1];
    // hit
    const x = os[i];
    nxt[0] = 1;
    for (let k = 1; k <= c + 1; k++) nxt[k] = cur[k] + cur[k - 1] * x;
    for (let k = c + 2; k <= n; k++) nxt[k] = 0;
    rec(i + 1, c + 1, prob * ps[i]);
    // miss
    for (let k = 0; k <= c; k++) nxt[k] = cur[k];
    for (let k = c + 1; k <= n; k++) nxt[k] = 0;
    rec(i + 1, c, prob * (1 - ps[i]));
  };
  rec(0, 0, 1);
  return { ev, evRatio: ev / stake, pProfit, pGood, pBig };
}
