// Probability model.
// 1) Remove the bookmaker margin from every market (power method).
// 2) Fit a Dixon-Coles adjusted Poisson model (home/away expected goals + low-score
//    correlation) to all full-time markets at once, then the first-half goal share.
// 3) Optionally build a second model from team statistics (standings + last 10 matches)
//    and blend it in.
// Every pick then gets one consistent probability from the same score distribution.

import { MARKETS, normalizeMarkets, pickId, pickLabel } from './markets.js';

const G = 10; // full-time goals grid 0..G per team
const GH = 6; // per-half goals grid 0..GH per team

// ---------- helpers ----------
function poisson(lambda, n) {
  const out = new Float64Array(n + 1);
  let p = Math.exp(-lambda);
  out[0] = p;
  for (let k = 1; k <= n; k++) { p = (p * lambda) / k; out[k] = p; }
  return out;
}

function tau(h, a, lh, la, rho) {
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

// Full-time score matrix with Dixon-Coles adjustment. idx = h*(G+1)+a
function ftMatrix(lh, la, rho) {
  const ph = poisson(lh, G), pa = poisson(la, G);
  const N = G + 1;
  const m = new Float64Array(N * N);
  let sum = 0;
  for (let h = 0; h < N; h++) {
    for (let a = 0; a < N; a++) {
      let v = ph[h] * pa[a];
      if (h < 2 && a < 2) v *= Math.max(0, tau(h, a, lh, la, rho));
      m[h * N + a] = v;
      sum += v;
    }
  }
  for (let i = 0; i < m.length; i++) m[i] /= sum;
  return m;
}

// Power de-vig: find k so that sum(q_i^k) = total.
// total is 1 for normal markets, 2 for double chance (each outcome covers two results).
export function devig(odds, total = 1) {
  const q = odds.map((o) => 1 / o);
  const s = q.reduce((x, y) => x + y, 0);
  if (Math.abs(s - total) < 1e-9) return { probs: q, margin: 0 };
  // Overlapping outcomes (double chance): the power method distorts prices near 1, use proportional.
  if (total !== 1) return { probs: q.map((x) => (x / s) * total), margin: s / total - 1 };
  let lo = 0.2, hi = 6;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    const t = q.reduce((acc, x) => acc + Math.pow(x, k), 0);
    if (t > total) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const probs = q.map((x) => Math.pow(x, k));
  const ps = probs.reduce((x, y) => x + y, 0);
  return { probs: probs.map((x) => (x / ps) * total), margin: s / total - 1 };
}

// Cache of full-time cell masks per (market, line, outcome).
const maskCache = new Map();
function ftMask(key, line, no) {
  const id = `${key}|${line}|${no}`;
  let mask = maskCache.get(id);
  if (mask) return mask;
  const pred = MARKETS[key].pred(no, line);
  const N = G + 1;
  const cells = [];
  const s = { h: 0, a: 0, h1: 0, a1: 0 };
  for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) {
    s.h = h; s.a = a;
    if (pred(s)) cells.push(h * N + a);
  }
  mask = Int16Array.from(cells);
  maskCache.set(id, mask);
  return mask;
}

const htMaskCache = new Map();
function htMask(key, line, no) {
  const id = `${key}|${line}|${no}`;
  let mask = htMaskCache.get(id);
  if (mask) return mask;
  const pred = MARKETS[key].pred(no, line);
  const N = G + 1;
  const cells = [];
  const s = { h: 0, a: 0, h1: 0, a1: 0 };
  for (let h = 0; h < N; h++) for (let a = 0; a < N; a++) {
    s.h1 = h; s.a1 = a;
    if (pred(s)) cells.push(h * N + a);
  }
  mask = Int16Array.from(cells);
  htMaskCache.set(id, mask);
  return mask;
}

function sumMask(m, mask) {
  let p = 0;
  for (let i = 0; i < mask.length; i++) p += m[mask[i]];
  return p;
}

// ---------- Nelder-Mead ----------
function nelderMead(f, x0, step, iters = 160, tol = 1e-10) {
  const n = x0.length;
  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step[i];
    simplex.push(x);
  }
  let vals = simplex.map(f);
  for (let it = 0; it < iters; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    simplex = order.map((i) => simplex[i]);
    vals = order.map((i) => vals[i]);
    if (Math.abs(vals[n] - vals[0]) < tol) break;
    const c = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n;
    const xr = c.map((cj, j) => cj + (cj - simplex[n][j]));
    const fr = f(xr);
    if (fr < vals[0]) {
      const xe = c.map((cj, j) => cj + 2 * (cj - simplex[n][j]));
      const fe = f(xe);
      if (fe < fr) { simplex[n] = xe; vals[n] = fe; } else { simplex[n] = xr; vals[n] = fr; }
    } else if (fr < vals[n - 1]) {
      simplex[n] = xr; vals[n] = fr;
    } else {
      const xc = c.map((cj, j) => cj + 0.5 * (simplex[n][j] - cj));
      const fc = f(xc);
      if (fc < vals[n]) { simplex[n] = xc; vals[n] = fc; } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((x, j) => simplex[0][j] + 0.5 * (x - simplex[0][j]));
          vals[i] = f(simplex[i]);
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i <= n; i++) if (vals[i] < vals[best]) best = i;
  return { x: simplex[best], fx: vals[best] };
}

// Poisson total-goals guess from Over 2.5 probability.
function totalFromOver25(pOver) {
  let lo = 0.3, hi = 6;
  for (let i = 0; i < 40; i++) {
    const t = (lo + hi) / 2;
    const p = poisson(t, 2);
    const over = 1 - (p[0] + p[1] + p[2]);
    if (over < pOver) lo = t; else hi = t;
  }
  return (lo + hi) / 2;
}

// ---------- fitting ----------
function buildTargets(markets) {
  const ft = [], ht = [];
  let marginSum = 0, marginN = 0;
  for (const mk of markets) {
    if (!mk.complete) continue;
    const { probs, margin } = devig(mk.outcomes.map((o) => o.odd), mk.def.sum || 1);
    mk.fair = probs;
    mk.margin = margin;
    marginSum += margin; marginN++;
    const w = mk.def.fit;
    if (!w) continue;
    const items = mk.outcomes.map((o, i) => ({ no: o.no, p: probs[i] }));
    if (mk.def.scope === 'ft') {
      ft.push({ w, items: items.map((it) => ({ ...it, mask: ftMask(mk.key, mk.line, it.no) })) });
    } else if (mk.def.scope === 'ht') {
      ht.push({ w, items: items.map((it) => ({ ...it, mask: htMask(mk.key, mk.line, it.no) })) });
    }
  }
  return { ft, ht, margin: marginN ? marginSum / marginN : null };
}

function lossFt(targets, lh, la, rho) {
  const m = ftMatrix(lh, la, rho);
  let L = 0;
  for (const t of targets) {
    for (const it of t.items) {
      const d = sumMask(m, it.mask) - it.p;
      L += t.w * d * d;
    }
  }
  return L;
}

function fitFt(targets, markets) {
  // initial guess
  let T = 2.6, sup = 0.25;
  const ou = markets.find((m) => m.key === '2_101' && m.line === 2.5 && m.fair);
  if (ou) T = totalFromOver25(ou.fair[ou.outcomes.findIndex((o) => o.no === 2)]);
  const ms = markets.find((m) => m.key === '1_1' && m.fair);
  if (ms) sup = (ms.fair[0] - ms.fair[2]) * 1.6;
  let lh0 = Math.max(0.15, (T + sup) / 2), la0 = Math.max(0.15, (T - sup) / 2);

  const f = (x) => {
    const lh = Math.exp(x[0]), la = Math.exp(x[1]);
    const rho = Math.max(-0.2, Math.min(0.2, x[2]));
    if (lh > 7 || la > 7) return 1e9;
    let L = lossFt(targets, lh, la, rho);
    L += 0.002 * rho * rho; // mild prior towards 0
    return L;
  };
  const r = nelderMead(f, [Math.log(lh0), Math.log(la0), -0.05], [0.25, 0.25, 0.08], 180);
  return {
    lh: Math.exp(r.x[0]), la: Math.exp(r.x[1]),
    rho: Math.max(-0.2, Math.min(0.2, r.x[2])), loss: r.fx,
  };
}

function fitHalf(targets, lh, la, rho) {
  if (!targets.length) return 0.445;
  const f = (x) => {
    const m = ftMatrix(lh * x, la * x, rho);
    let L = 0;
    for (const t of targets) for (const it of t.items) {
      const d = sumMask(m, it.mask) - it.p;
      L += t.w * d * d;
    }
    return L + 0.05 * (x - 0.445) * (x - 0.445);
  };
  let a = 0.34, b = 0.52;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < 30; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

// Joint distribution of (h1, a1, h2, a2) -> compact list of cells.
export function jointCells(lh, la, rho, f) {
  const p1h = poisson(lh * f, GH), p1a = poisson(la * f, GH);
  const p2h = poisson(lh * (1 - f), GH), p2a = poisson(la * (1 - f), GH);
  const H = [], A = [], H1 = [], A1 = [], P = [];
  let sum = 0;
  for (let h1 = 0; h1 <= GH; h1++) for (let a1 = 0; a1 <= GH; a1++) {
    const p1 = p1h[h1] * p1a[a1];
    if (p1 < 1e-10) continue;
    for (let h2 = 0; h2 <= GH; h2++) for (let a2 = 0; a2 <= GH; a2++) {
      let p = p1 * p2h[h2] * p2a[a2];
      if (p < 1e-11) continue;
      const h = h1 + h2, a = a1 + a2;
      if (h < 2 && a < 2) p *= Math.max(0, tau(h, a, lh, la, rho));
      H.push(h); A.push(a); H1.push(h1); A1.push(a1); P.push(p);
      sum += p;
    }
  }
  const n = P.length;
  const cells = { n, H: Int8Array.from(H), A: Int8Array.from(A), H1: Int8Array.from(H1), A1: Int8Array.from(A1), P: new Float64Array(n) };
  for (let i = 0; i < n; i++) cells.P[i] = P[i] / sum;
  return cells;
}

export function probOf(cells, pred) {
  const s = { h: 0, a: 0, h1: 0, a1: 0 };
  let p = 0;
  for (let i = 0; i < cells.n; i++) {
    s.h = cells.H[i]; s.a = cells.A[i]; s.h1 = cells.H1[i]; s.a1 = cells.A1[i];
    if (pred(s)) p += cells.P[i];
  }
  return p;
}

// ---------- statistics model ----------
// stats: trimmed object produced by api.js (see trimStats there)
export function statsLambdas(stats) {
  if (!stats) return null;
  const parts = [];
  const detail = {};

  // 1) Season table: attack / defence strengths with shrinkage.
  const st = stats.standings;
  if (st && st.rows && st.rows.length >= 6) {
    const rows = st.rows.filter((r) => r.p > 0);
    const tp = rows.reduce((s, r) => s + r.p, 0);
    const tg = rows.reduce((s, r) => s + r.gf, 0);
    const home = rows.find((r) => r.si === st.homeId);
    const away = rows.find((r) => r.si === st.awayId);
    if (home && away && tp > 0 && tg > 0) {
      const mu = tg / tp; // goals per team per game
      const k = 4;
      const att = (r) => (r.gf + mu * k) / ((r.p + k) * mu);
      const def = (r) => (r.ga + mu * k) / ((r.p + k) * mu);
      const HA = 1.12;
      const lh = mu * att(home) * def(away) * HA;
      const la = (mu * att(away) * def(home)) / HA;
      parts.push({ lh, la, w: Math.min(1, (home.p + away.p) / 16) });
      detail.table = { lh, la, mu, home, away };
    }
  }

  // 2) Last 10 matches of each team (all competitions).
  const rh = stats.recentHome, ra = stats.recentAway;
  if (rh && ra && rh.games >= 4 && ra.games >= 4) {
    const k = 3, base = 1.3;
    const shrink = (x, n) => (x * n + base * k) / (n + k);
    const hs = shrink(rh.gf / rh.games, rh.games), hc = shrink(rh.ga / rh.games, rh.games);
    const as = shrink(ra.gf / ra.games, ra.games), ac = shrink(ra.ga / ra.games, ra.games);
    const lh = Math.sqrt(hs * ac) * 1.08;
    const la = Math.sqrt(as * hc) / 1.08;
    parts.push({ lh, la, w: 0.8 });
    detail.recent = { lh, la };
  }
  if (!parts.length) return null;
  const ws = parts.reduce((s, p) => s + p.w, 0);
  const lh = Math.exp(parts.reduce((s, p) => s + p.w * Math.log(p.lh), 0) / ws);
  const la = Math.exp(parts.reduce((s, p) => s + p.w * Math.log(p.la), 0) / ws);
  return { lh: clampL(lh), la: clampL(la), detail };
}

function clampL(x) { return Math.max(0.15, Math.min(4.5, x)); }

// ---------- main entry ----------
// Analyse one event. opts: { oddField, statsWeight, stats }
export function analyzeEvent(event, opts = {}) {
  const oddField = opts.oddField || 'odd';
  const markets = normalizeMarkets(event, oddField, opts.marketNames);
  const [loOdd, hiOdd] = opts.oddRange || [1.0, Infinity];
  if (!markets.find((m) => m.key === '1_1')) return null;
  const targets = buildTargets(markets);
  if (targets.ft.length < 1) return null;
  const fit = fitFt(targets.ft, markets);
  const f = fitHalf(targets.ht, fit.lh, fit.la, fit.rho);
  const cellsMkt = jointCells(fit.lh, fit.la, fit.rho, f);

  let sl = null, cellsStats = null;
  const w = opts.stats ? (opts.statsWeight ?? 0.2) : 0;
  if (w > 0) {
    sl = statsLambdas(opts.stats);
    // Statistics nudge the expected goals (geometric blend); they do not override the market.
    // Mixing raw stats probabilities in directly would hugely inflate long shots.
    if (sl) {
      const lhB = Math.exp((1 - w) * Math.log(fit.lh) + w * Math.log(sl.lh));
      const laB = Math.exp((1 - w) * Math.log(fit.la) + w * Math.log(sl.la));
      sl.blend = { lh: lhB, la: laB };
      cellsStats = jointCells(lhB, laB, fit.rho, f);
    }
  }

  const picks = [];
  for (const mk of markets) {
    if (mk.def.generic && !mk.fair) {
      const { probs, margin } = devig(mk.outcomes.map((o) => o.odd));
      mk.fair = probs; mk.margin = margin;
    }
    mk.outcomes.forEach((o, i) => {
      if (o.odd < loOdd || o.odd > hiOdd) return;
      const ctx = { name: o.name, names: mk.names };
      const pFair = mk.fair ? mk.fair[i] : null;
      let pModel = null, pStats = null, p;
      if (mk.def.generic) {
        // corners, cards, ...: no goal model, use the market's own margin-free price
        p = pFair;
      } else {
        const pred = mk.def.pred(o.no, mk.line, ctx);
        pModel = probOf(cellsMkt, pred);
        if (cellsStats) pStats = probOf(cellsStats, pred);
        const pGoal = pStats ?? pModel;
        // consensus: goal model fitted on all markets, mixed with this market's own fair price
        p = pFair === null ? pGoal : 0.5 * pGoal + 0.5 * pFair;
      }
      if (!(p > 0)) return;
      const named = mk.def.named;
      picks.push({
        id: pickId(event.i, mk.key, mk.line, o.no),
        eventId: event.i,
        key: mk.key, line: mk.line, no: o.no,
        name: o.name, names: named ? mk.names : undefined,
        group: mk.def.group,
        market: mk.def.name,
        generic: !!mk.def.generic,
        label: pickLabel(mk.def, mk.line, o.no, ctx),
        odd: o.odd,
        p, pModel, pFair, pStats,
        v: p * o.odd,
        mbc: mk.mbc,
        margin: mk.margin ?? null,
      });
    });
  }

  const P = (key, line, no) => probOf(cellsMkt, MARKETS[key].pred(no, line));
  const PS = cellsStats ? (key, line, no) => probOf(cellsStats, MARKETS[key].pred(no, line)) : null;
  const summary = (fn) => fn && ({
    home: fn('1_1', null, 1), draw: fn('1_1', null, 2), away: fn('1_1', null, 3),
    over25: fn('2_101', 2.5, 2), btts: fn('2_89', null, 1), over15: fn('2_101', 1.5, 2),
  });

  return {
    eventId: event.i,
    lh: fit.lh, la: fit.la, rho: fit.rho, half: f, fitLoss: fit.loss,
    margin: targets.margin, nMarkets: markets.length,
    stats: sl, statsWeight: cellsStats ? w : 0,
    probs: summary(P), probsStats: summary(PS),
    picks,
  };
}
