import { analyzeEvent, cellMask } from './model.js?v=6';
import { filterPicks, buildPool, optimizeSystem, alternativesFor, findTargetCombos, OBJECTIVES, hashString, mulberry32 } from './optimizer.js?v=6';
import { evaluateSystem, columnCount, payoutFor } from './system.js?v=6';
import { GROUPS, MARKETS, settlePick } from './markets.js?v=6';
import { searchSystems } from './autosystem.js?v=6';
import * as api from './api.js?v=6';

// Bump together with version.json on every release: an older copy on the phone reloads itself.
const APP_VERSION = 6;

// ---------- settings & storage ----------
const SETTINGS_VERSION = 5;
// Preset the user asked for: 6 matches, system 3-4-5-6, 2 misli = 84 TL, every pick 5+ odds,
// optimized for the chance of winning 10.000 TL.
// Every goal-based bet type (used for "Hepsi" and to complete a coupon when the chosen type is short).
const ALL_GOAL_GROUPS = ['DONUS', 'MS', 'AU', 'KG', 'HND', 'TAU', 'IY', 'IYMS', 'KOMBO', 'TG', 'SKOR', 'YARI', 'OZEL'];
const HIGH_ODDS_PRESET = {
  sysMode: 'manual',
  n: 6,
  sizes: [3, 4, 5, 6],
  misli: 2,
  objective: 'hedef',
  targetWin: 10000,
  oddField: 'odd',
  minOdd: 5,
  maxOdd: 60,
  // v5: the user wants İY/MS 1/2 and 2/1 (most likely ones first)
  groups: ['DONUS'],
  // goals wanted: no unders / KG Yok / 0-0 style picks, and no "underdog wins" picks
  goalMode: true,
  noUpset: true,
};
const DEFAULTS = {
  v: SETTINGS_VERSION,
  // system: 'auto' searches every layout within the budget, 'manual' uses n/sizes/misli below
  budget: 84,
  autoMinN: 5,
  autoMaxN: 8,
  minStake: 50,
  unit: 1,
  ...HIGH_ODDS_PRESET,
  window: 'today',
  statsWeight: 0.2,
  maxPerLeague: 2,
  noYouth: true,
  statsTop: 999, // statistics for every match of the day
  target: 10,
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('sk:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sk:' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

function loadSettings() {
  const saved = store.get('settings', {});
  if ((saved.v || 1) < SETTINGS_VERSION) {
    // v3: 5+ odds, 6 matches 3-4-5-6 with 2 misli, kral oran, 10.000 TL target
    // v4: goal mode, no underdog wins, statistics for every match
    // v5: İY/MS 1/2 – 2/1 coupon by default, odds up to 60
    for (const k of Object.keys(HIGH_ODDS_PRESET)) delete saved[k];
    store.set('coupon', null);
    delete saved.statsTop;
    const migrated = { ...DEFAULTS, ...saved, v: SETTINGS_VERSION };
    store.set('settings', migrated);
    return migrated;
  }
  return { ...DEFAULTS, ...saved, v: SETTINGS_VERSION };
}

const state = {
  settings: loadSettings(),
  tab: store.get('tab', 'kupon'),
  phase: 'loading', // loading | ready | error
  error: null,
  events: [],
  eventsById: new Map(),
  comps: {},
  marketNames: null,
  detailed: new Set(), // events whose full market list is loaded
  analyses: new Map(),
  pickById: new Map(),
  stats: new Map(),
  statsExtra: new Map(),
  updatedAt: null,
  coupon: null, // { ids: [], locked: Set, excluded: Set, sys: {n,sizes,misli,unit,cols,stake}, ranking: [] }
  tempExcluded: new Set(),
  matchFilter: { q: '', day: 'all', sort: 'time' },
  history: store.get('history', []),
  combos: null,
  installPrompt: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');

// ---------- formatting ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtOdd = (x) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const fmtPct = (p, d = 0) => (Number.isFinite(p) ? `%${(p * 100).toFixed(d)}` : '–');
const fmtTL = (x) => `${(Number.isFinite(x) ? x : 0).toLocaleString('tr-TR', { maximumFractionDigits: x < 100 ? 2 : 0, minimumFractionDigits: 0 })} TL`;
const fmtTime = (d) => new Date(d * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
function dayLabel(d) {
  const t = new Date(d * 1000), now = new Date();
  const k = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const tm = new Date(now); tm.setDate(now.getDate() + 1);
  if (k(t) === k(now)) return 'Bugün';
  if (k(t) === k(tm)) return 'Yarın';
  return t.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
}
// A "game day" runs 06:00 → 06:00 so late-night matches belong to the same day.
function gameDay(ts = Date.now()) {
  const d = new Date(ts - 6 * 3600e3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function windowEnd(win) {
  const now = Date.now() / 1000;
  if (win === '24') return now + 86400;
  if (win === '48') return now + 2 * 86400 + 3600;
  const e = new Date(); e.setHours(6, 0, 0, 0);
  while (e.getTime() / 1000 < now + 12 * 3600) e.setDate(e.getDate() + 1);
  return e.getTime() / 1000;
}
const sizesLabel = (sizes) => sizes.slice().sort((a, b) => a - b).join('-');
// Turkish suffixes for numbers: 3'lü, 6'lı / 2'den, 3'ten
const li = (k) => `${k}'${({ 1: 'li', 2: 'li', 3: 'lü', 4: 'lü', 5: 'li', 6: 'lı', 7: 'li', 8: 'li', 9: 'lu', 10: 'lu' })[k] || 'li'}`;
const den = (k) => `${k}'${({ 1: 'den', 2: 'den', 3: 'ten', 4: 'ten', 5: 'ten', 6: 'dan', 7: 'den', 8: 'den', 9: 'dan', 10: 'dan' })[k] || 'den'}`;

const YOUTH_RE = /\bU-?(1[5-9]|2[0-3])\b|\(K\)|Kadın|Women|Femenin|Feminin|Frauen|Gençler|Rezerv|Reserve|Yedek|Amatör|Amateur/i;
function compOf(ci) { return state.comps[ci] || { n: `Lig #${ci}` }; }
function isYouthOrWomen(e) { return YOUTH_RE.test(e.hn) || YOUTH_RE.test(e.an) || YOUTH_RE.test(compOf(e.ci).n); }
function flagImg(ci) {
  const c = compOf(ci);
  return c.ic ? `<img src="${esc(c.ic)}" alt="" loading="lazy" onerror="this.remove()">` : '';
}
// iddaa margins are 15-25%, so ~0.89 is already a good price there.
function valueClass(v) { return v >= 0.85 ? 'good' : v >= 0.75 ? '' : 'bad'; }

// ---------- toast / sheet ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

let sheetOpen = false;
function openSheet(html) {
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
  $('#sheet-body').scrollTop = 0;
  if (!sheetOpen) { try { history.pushState({ sheet: 1 }, ''); } catch { /* ignore */ } }
  sheetOpen = true;
}
function closeSheet(fromPop = false) {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  if (!fromPop) { try { history.back(); } catch { /* ignore */ } }
  // settings changed in the sheet are applied when it closes, however it was closed
  if (settingsDirty.reanalyze || settingsDirty.regen) applySettings();
}
window.addEventListener('popstate', () => closeSheet(true));
$('#sheet-backdrop').addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

function setStatus(text) { $('#status').textContent = text; }
function setProgress(frac) {
  const p = $('#progress');
  if (frac === null) { p.hidden = true; return; }
  p.hidden = false;
  p.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- analysis ----------
function saveSettings() { store.set('settings', state.settings); }

function analyzeOne(e) {
  const st = state.stats.get(e.i);
  const a = analyzeEvent(e, {
    oddField: state.settings.oddField, statsWeight: state.settings.statsWeight,
    stats: st && st.ok ? st : null, marketNames: state.marketNames, oddRange: [1.15, Infinity],
    simRange: [state.settings.minOdd, state.settings.maxOdd], simRuns: 10000, seed: hashString(gameDay()),
  });
  if (!a) { state.analyses.delete(e.i); return; }
  for (const p of a.picks) { p.league = e.ci; p.d = e.d; }
  state.analyses.set(e.i, a);
}

function rebuildPickIndex() {
  state.pickById = new Map();
  for (const a of state.analyses.values()) for (const p of a.picks) state.pickById.set(p.id, p);
}

async function analyzeAll(label = 'Maçlar analiz ediliyor') {
  const list = state.events;
  for (let i = 0; i < list.length; i++) {
    analyzeOne(list[i]);
    if (i % 12 === 11) { setStatus(`${label} ${i + 1}/${list.length}`); setProgress(0.25 + 0.35 * (i / list.length)); await tick(); }
  }
  rebuildPickIndex();
}

function eventEligible(e, now = Date.now() / 1000) {
  const s = state.settings;
  if (e.d < now + 600 || e.d > windowEnd(s.window)) return false;
  if (s.noYouth && isYouthOrWomen(e)) return false;
  return true;
}

function manualSys() {
  const s = state.settings;
  const sizes = s.sizes.filter((k) => k <= s.n);
  const cols = columnCount(s.n, sizes);
  return { n: s.n, sizes, misli: s.misli, unit: s.unit, cols, stake: cols * s.misli * s.unit };
}
// The system the current coupon is played with (auto mode stores the layout it found).
function couponSys() {
  return state.coupon?.sys || manualSys();
}
const minSizeOf = (sys) => Math.min(...sys.sizes);

function eligiblePicks({ maxMbc, ignoreExcluded = false, groups = null } = {}) {
  const s = state.settings;
  const now = Date.now() / 1000;
  const all = [];
  for (const a of state.analyses.values()) {
    const e = state.eventsById.get(a.eventId);
    if (!e || !eventEligible(e, now)) continue;
    all.push(...a.picks);
  }
  const excluded = new Set(ignoreExcluded ? [] : [...(state.coupon?.excluded || []), ...state.tempExcluded]);
  const wanted = all.filter((p) => !(s.goalMode && p.lowGoal) && !(s.noUpset && p.upset));
  return filterPicks(wanted, {
    minOdd: s.minOdd, maxOdd: s.maxOdd, groups: new Set(groups || s.groups),
    maxMbc: maxMbc ?? minSizeOf(couponSys()), excluded,
    minProb: 0.01, // İY/MS 1/2 – 2/1 are usually 2-4 %
  });
}

function optOptions(locked, sys = couponSys()) {
  const s = state.settings;
  return {
    n: sys.n, sizes: sys.sizes, misli: sys.misli, unit: sys.unit, objective: s.objective,
    target: s.targetWin, locked, maxPerLeague: s.maxPerLeague,
    seed: hashString(`${gameDay()}|${s.objective}|${sys.n}|${sys.sizes.join(',')}`),
  };
}

// Team statistics (standings, last 10 matches incl. half-time scores) for every match of the day.
async function loadStatsForTop() {
  const s = state.settings;
  if (!(s.statsWeight > 0)) return;
  const now = Date.now() / 1000;
  const want = state.events.filter((e) => eventEligible(e, now)).map((e) => e.i).slice(0, s.statsTop || 999);
  for (const id of state.coupon?.ids || []) {
    const ev = Number(String(id).split(':')[0]);
    if (!want.includes(ev)) want.push(ev);
  }
  const missing = want.filter((id) => !state.stats.has(id) && state.eventsById.has(id));
  if (missing.length) {
    await api.pool(missing, 8, async (id) => {
      const st = await api.fetchStats(id);
      state.stats.set(id, st);
    }, (d, n) => { setStatus(`Takım istatistikleri ${d}/${n}`); setProgress(0.6 + 0.3 * (d / n)); });
  }
  setStatus('Maçlar 10.000 kez simüle ediliyor…');
  await tick();
  for (let i = 0; i < want.length; i++) {
    const e = state.eventsById.get(want[i]);
    if (e) analyzeOne(e);
    if (i % 15 === 14) await tick();
  }
  rebuildPickIndex();
}

// Full market lists (İY/MS, skor, yarı, korner, kart...) for the day's matches.
async function loadDetails(list) {
  const todo = list.filter((e) => !state.detailed.has(e.i));
  if (!todo.length) return;
  await api.pool(todo, 8, async (e) => {
    const d = await api.fetchEventDetail(e.i);
    if (d?.m?.length) {
      e.m = d.m;
      if (d.mbc) e.mbc = d.mbc;
      state.detailed.add(e.i);
    }
  }, (d, n) => { setStatus(`Tüm bahis seçenekleri yükleniyor ${d}/${n}`); setProgress(0.1 + 0.15 * (d / n)); });
}

// ---------- coupon ----------
function couponPicks() {
  if (!state.coupon) return [];
  return state.coupon.ids.map((id) => state.pickById.get(id)).filter(Boolean);
}

function saveCoupon() {
  if (!state.coupon) return;
  // keep the coupon in kick-off order
  const when = (id) => state.pickById.get(id)?.d ?? Infinity;
  state.coupon.ids = state.coupon.ids.slice().sort((a, b) => when(a) - when(b));
  store.set('coupon', {
    day: gameDay(), ids: state.coupon.ids,
    locked: [...state.coupon.locked], excluded: [...state.coupon.excluded],
    sys: state.coupon.sys || null, ranking: state.coupon.ranking || null,
  });
}

function lockedFrom(prev, keepIds) {
  const now = Date.now() / 1000;
  return prev.ids.filter((id) => prev.locked.has(id) || keepIds)
    .map((id) => state.pickById.get(id)).filter(Boolean)
    .filter((p) => p.d > now + 120);
}

// Fill the coupon for a fixed system layout (manual mode, or refilling an auto coupon).
function fillCoupon(sys, { keepIds = false } = {}) {
  const prev = state.coupon || { ids: [], locked: new Set(), excluded: new Set() };
  let lockedPicks = lockedFrom(prev, keepIds).filter((p) => (p.mbc ?? 1) <= minSizeOf(sys)).slice(0, sys.n);
  let pool = buildPool(eligiblePicks({ maxMbc: minSizeOf(sys) }), 4, 160);
  const lockedEvents = new Set(lockedPicks.map((p) => p.eventId));
  const poolEvents = new Set(pool.map((p) => p.eventId).filter((id) => !lockedEvents.has(id)));
  if (lockedPicks.length + poolEvents.size < sys.n && !sameSet(state.settings.groups, ALL_GOAL_GROUPS)) {
    // Not enough matches offer the chosen bet type today: take the most likely one per match,
    // then complete the coupon with the most suitable high-odds goal bets.
    const bestPer = new Map();
    for (const p of pool) {
      if (lockedEvents.has(p.eventId)) continue;
      const cur = bestPer.get(p.eventId);
      if (!cur || p.p > cur.p) bestPer.set(p.eventId, p);
    }
    lockedPicks = lockedPicks.concat([...bestPer.values()].sort((a, b) => b.p - a.p)).slice(0, sys.n);
    pool = buildPool(eligiblePicks({ maxMbc: minSizeOf(sys), groups: ALL_GOAL_GROUPS }), 4, 160);
  }
  const r = optimizeSystem(pool, optOptions(lockedPicks, sys));
  const base = { locked: prev.locked, excluded: prev.excluded, sys, ranking: prev.ranking || null };
  if (!r) {
    state.coupon = { ...base, ids: lockedPicks.map((p) => p.id) };
    saveCoupon();
    return false;
  }
  state.coupon = { ...base, ids: r.picks.map((p) => p.id), locked: new Set([...prev.locked].filter((id) => r.picks.some((p) => p.id === id))) };
  saveCoupon();
  return true;
}

// Build a fresh coupon: in auto mode this searches every system layout within the budget.
async function buildCoupon({ keepIds = false } = {}) {
  const s = state.settings;
  if (s.sysMode !== 'auto') { state.coupon && (state.coupon.ranking = null); return fillCoupon(manualSys(), { keepIds }); }
  if (keepIds && state.coupon?.sys) return fillCoupon(state.coupon.sys, { keepIds });
  const prev = state.coupon || { ids: [], locked: new Set(), excluded: new Set() };
  const locked = lockedFrom(prev, false);
  setStatus('En iyi sistem aranıyor…');
  setProgress(0.97);
  await tick();
  const picks = eligiblePicks({ maxMbc: 99 });
  for (const p of locked) if (!picks.includes(p)) picks.push(p);
  const res = searchSystems(picks, {
    minN: s.autoMinN, maxN: s.autoMaxN, budget: s.budget, minStake: s.minStake, unit: s.unit,
  }, { objective: s.objective, target: s.targetWin, locked, maxPerLeague: s.maxPerLeague, seedBase: `${gameDay()}|${s.objective}` });
  setProgress(null);
  setStatus(statusLine());
  const best = res.ranking[0];
  if (!best) {
    state.coupon = { ids: locked.map((p) => p.id), locked: prev.locked, excluded: prev.excluded, sys: null, ranking: [] };
    saveCoupon();
    return false;
  }
  state.coupon = {
    ids: best.ids.slice(),
    locked: new Set([...prev.locked].filter((id) => best.ids.includes(id))),
    excluded: prev.excluded,
    sys: best.sys,
    ranking: res.ranking.slice(0, 6).map((r) => ({ sys: r.sys, ids: r.ids, m: r.metrics })),
  };
  saveCoupon();
  return true;
}

function useRanking(i) {
  const r = state.coupon?.ranking?.[i];
  if (!r) return;
  const missing = r.ids.some((id) => !state.pickById.has(id));
  state.coupon.sys = r.sys;
  state.coupon.ids = r.ids.filter((id) => state.pickById.has(id));
  state.coupon.locked = new Set([...state.coupon.locked].filter((id) => r.ids.includes(id)));
  if (missing) fillCoupon(r.sys, { keepIds: true }); else saveCoupon();
}

function restoreCoupon() {
  const saved = store.get('coupon', null);
  if (!saved || saved.day !== gameDay()) return false;
  if (state.settings.sysMode === 'auto' && !saved.sys) return false;
  state.coupon = {
    ids: saved.ids || [], locked: new Set(saved.locked || []), excluded: new Set(saved.excluded || []),
    sys: state.settings.sysMode === 'auto' ? saved.sys : manualSys(), ranking: saved.ranking || null,
  };
  const valid = couponPicks();
  if (valid.length === couponSys().n && valid.length === state.coupon.ids.length) return true;
  // some picks are gone (market closed / match started): keep the rest and refill
  fillCoupon(couponSys(), { keepIds: true });
  return true;
}

function sysName(sys) {
  return sys.sizes.length === 1 ? `${li(sys.sizes[0])}` : sizesLabel(sys.sizes);
}

function couponText() {
  const sys = couponSys();
  const picks = couponPicks();
  const r = evaluateSystem(picks, sys.sizes, sys.misli, sys.unit);
  const lines = [`Sistem ${sysName(sys)} · ${picks.length} maç · ${sys.misli} misli · ${fmtTL(r.stake)} (${r.columns} kolon)`];
  picks.forEach((p, i) => {
    const e = state.eventsById.get(p.eventId);
    lines.push(`${i + 1}) ${fmtTime(p.d)} ${e ? `${e.hn} - ${e.an}` : ''} → ${p.label} (${fmtOdd(p.odd)})`);
  });
  lines.push(`Maks. kazanç: ${fmtTL(r.maxPay)}`);
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast('Kopyalandı');
}

// ---------- rendering: coupon ----------
function renderPick(p, i, locked) {
  const e = state.eventsById.get(p.eventId);
  const c = compOf(p.league);
  return `
  <article class="pick ${locked ? 'locked' : ''}">
    <div class="pick-actions">
      <button data-act="lock" data-i="${i}" class="${locked ? 'on' : ''}" aria-label="${locked ? 'Kilidi aç' : 'Sabitle'}"><svg><use href="#${locked ? 'i-lock' : 'i-unlock'}"/></svg></button>
      <button data-act="swap" data-i="${i}" aria-label="Değiştir"><svg><use href="#i-swap"/></svg></button>
      <button data-act="remove" data-i="${i}" aria-label="Maçı çıkar"><svg><use href="#i-x"/></svg></button>
    </div>
    <div class="meta">${flagImg(p.league)}<span class="ellipsis">${fmtTime(p.d)} · ${esc(c.n)}</span></div>
    <div class="teams" data-act="match" data-id="${p.eventId}">${e ? `${esc(e.hn)} – ${esc(e.an)}` : 'Maç'}</div>
    <div class="sel">
      <span class="label">${esc(p.label)}</span>
      <span class="odd">${fmtOdd(p.odd)}</span>
    </div>
    <div class="pick-stats">
      <span>olasılık <b>${fmtPct(p.p, p.p < 0.2 ? 1 : 0)}</b></span>
      <span>adil oran <b>${fmtOdd(1 / p.p)}</b></span>
      ${p.simHits !== null && p.simHits !== undefined ? `<span>10.000 simülasyonda <b>${p.simHits.toLocaleString('tr-TR')}</b> kez</span>` : ''}
      <span class="badge ${valueClass(p.v)}" title="Değer = oran × olasılık">değer ${p.v.toFixed(2)}</span>
    </div>
  </article>`;
}

// The day's simulation: in run r every match has the score it got in its own r-th simulation,
// so the coupon is judged on the same 10.000 simulated days as the match screens.
function simulateDay(picks, sys, target) {
  const runs = 10000;
  const tests = picks.map((p) => {
    const a = state.analyses.get(p.eventId);
    if (a?.sim && a.sim.length >= runs && !p.generic && MARKETS[p.key]) {
      const mask = cellMask(a.cells, MARKETS[p.key].pred(p.no, p.line, { name: p.name, names: p.names }));
      return (r) => mask[a.sim[r]] === 1;
    }
    const rnd = mulberry32(hashString(p.id + gameDay()));
    const arr = new Uint8Array(runs);
    for (let r = 0; r < runs; r++) arr[r] = rnd() < p.p ? 1 : 0;
    return (r) => arr[r] === 1;
  });
  const n = picks.length;
  const stake = columnCount(n, sys.sizes) * sys.misli * sys.unit;
  const hits = new Array(n + 1).fill(0);
  let profit = 0, reached = 0, sum = 0, best = 0, anyPay = 0;
  const odds = [];
  for (let r = 0; r < runs; r++) {
    odds.length = 0;
    for (let i = 0; i < n; i++) if (tests[i](r)) odds.push(picks[i].odd);
    hits[odds.length]++;
    const pay = payoutFor(odds, sys.sizes, sys.misli, sys.unit);
    sum += pay;
    if (pay > 0) anyPay++;
    if (pay > stake) profit++;
    if (pay >= target) reached++;
    if (pay > best) best = pay;
  }
  return { runs, stake, hits, anyPay, profit, reached, avgPay: sum / runs, best, target };
}

function renderSummary(picks) {
  const s = state.settings;
  const sys = couponSys();
  const target = s.targetWin || Infinity;
  const r = evaluateSystem(picks, sys.sizes, sys.misli, sys.unit, target);
  const minK = Math.min(...r.sizes);
  const pct = (p) => (p > 0 && p < 0.0001 ? '<%0.01' : fmtPct(p, p < 0.01 ? 2 : 1));
  const rows = r.byHits.filter((b) => b.k >= minK).map((b) => {
    const pay = b.minPay === b.maxPay ? fmtTL(b.minPay) : `${fmtTL(b.minPay)} – ${fmtTL(b.maxPay)}`;
    return `<tr class="${b.minPay > r.stake ? 'hl' : ''}"><td>${b.k} tutarsa</td><td class="r">${pct(b.prob)}</td><td class="r">${pay}</td></tr>`;
  }).join('');
  const lose = r.byHits.filter((b) => b.k < minK).reduce((x, b) => x + b.prob, 0);
  const totalOdd = picks.reduce((x, p) => x * p.odd, 1);
  const profitAt = r.byHits.find((b) => b.k >= minK && b.minPay > r.stake);
  const sim = simulateDay(picks, sys, target);
  const oneIn = (p) => (p > 0 ? `${Math.max(1, Math.round(1 / p)).toLocaleString('tr-TR')} günde 1` : '–');
  return `
  <div class="card mt12">
    <div class="kpis k2">
      <div class="kpi"><div class="k">Para alma (${minK}+ tutma)</div><div class="v">${pct(r.pReturn)}</div><div class="small muted">${oneIn(r.pReturn)}</div></div>
      <div class="kpi"><div class="k">${fmtTL(target)}+ kazanç</div><div class="v ${r.pTarget > 0 ? 'good' : 'warn'}">${pct(r.pTarget)}</div><div class="small muted">${oneIn(r.pTarget)}</div></div>
      <div class="kpi"><div class="k">Kâr için</div><div class="v">${profitAt ? `${profitAt.k}/${picks.length} tutmalı` : '–'}</div></div>
      <div class="kpi"><div class="k">Maks. kazanç</div><div class="v">${fmtTL(r.maxPay)}</div></div>
    </div>
    <table class="tbl mt12">
      <thead><tr><th>Sonuç</th><th class="r">Olasılık</th><th class="r">Kazanç</th></tr></thead>
      <tbody>
        <tr><td>${den(minK)} az</td><td class="r">${pct(lose)}</td><td class="r">0 TL</td></tr>
        ${rows}
      </tbody>
    </table>
    <div class="note box mt12">
      ${r.columns} kolon × ${sys.misli} misli × ${fmtTL(sys.unit)} = <b>${fmtTL(r.stake)}</b> · Ortalama oran ${fmtOdd(picks.reduce((x, p) => x + p.odd, 0) / picks.length)} · Hepsinin çarpımı ${totalOdd >= 1000 ? Math.round(totalOdd).toLocaleString('tr-TR') : fmtOdd(totalOdd)}<br>
      Ortalama beklenen dönüş: <b>${fmtTL(r.ev)}</b> (yatırılana oranı ${fmtPct(r.evRatio)}). iddaa'nın kâr payı yüzünden bu oran uzun vadede %100'ün altında kalır.
    </div>
  </div>
  <div class="section-title"><h2>Günün 10.000 simülasyonu</h2><small>bütün maçlar 10.000 kez oynandı</small></div>
  <div class="card">
    <table class="tbl">
      <tbody>
        ${sim.hits.map((c, k) => ({ c, k })).filter((x) => x.k >= 2).reverse().map((x) => `<tr class="${x.k >= minK ? '' : 'muted'}"><td>${x.k} maç tuttu</td><td class="r"><b>${x.c.toLocaleString('tr-TR')}</b> kez</td></tr>`).join('')}
        <tr><td>Para aldın</td><td class="r"><b>${sim.anyPay.toLocaleString('tr-TR')}</b> kez</td></tr>
        <tr class="hl"><td>${fmtTL(target)}+ kazandın</td><td class="r">${sim.reached.toLocaleString('tr-TR')} kez</td></tr>
        <tr><td>En büyük kazanç</td><td class="r">${fmtTL(sim.best)}</td></tr>
      </tbody>
    </table>
    <p class="note mt8">Her maç kendi gol modeline göre 10.000 kez oynatıldı; her turda kupon o turun skorlarıyla değerlendirildi. Toplam yatırılan ${fmtTL(sim.stake * sim.runs)}, toplam dönen ${fmtTL(sim.avgPay * sim.runs)}.</p>
  </div>`;
}

// Comparison of the best system layouts found by the automatic search.
function renderRanking() {
  const list = state.coupon?.ranking;
  if (state.settings.sysMode !== 'auto' || !list?.length) return '';
  const cur = couponSys();
  const same = (a) => a.n === cur.n && a.sizes.join() === cur.sizes.join();
  return `
  <div class="section-title"><h2>Sistem karşılaştırması</h2><small>bütçe ${fmtTL(state.settings.budget)}</small></div>
  <div class="card">
    <table class="tbl">
      <thead><tr><th>Sistem</th><th class="r">${state.settings.objective === 'hedef' ? 'Hedef' : 'Kâr'}</th><th class="r">Getiri</th><th class="r">Maks.</th><th></th></tr></thead>
      <tbody>${list.map((r, i) => `
        <tr class="${same(r.sys) ? 'hl' : ''}">
          <td><b>${r.sys.n} maç · ${esc(sysName(r.sys))}</b><div class="small muted">${r.sys.cols} kolon × ${r.sys.misli} misli = ${fmtTL(r.sys.stake)}</div></td>
          <td class="r">${state.settings.objective === 'hedef' ? fmtPct(r.m.pTarget ?? 0, 2) : fmtPct(r.m.pProfit)}</td>
          <td class="r">${fmtPct(r.m.evRatio)}</td>
          <td class="r">${fmtTL(r.m.maxPay)}</td>
          <td class="r">${same(r.sys) ? '<span class="badge good">seçili</span>' : `<button class="btn sm" data-act="use-sys" data-i="${i}">Seç</button>`}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p class="note mt8">Hedef: hedef kazanca ulaşma · Kâr: kâra geçme olasılığı · Getiri: 1 TL'ye beklenen dönüş. Küçük kolonlu sistemler (2'li, 3'lü) her gün en yüksek getiriyi verir; 2'li kolon için maçların MBS'si en fazla 2 olmalı.</p>
  </div>`;
}

const QUICK_GROUPS = [
  ['İY/MS 1/2 – 2/1', ['DONUS']],
  ['Hepsi', ALL_GOAL_GROUPS],
  ['Tüm İY/MS', ['DONUS', 'IYMS']],
  ['Maç sonucu', ['MS', 'HND']],
  ['Skor', ['SKOR']],
  ['Gol & kombine', ['AU', 'KG', 'TAU', 'KOMBO', 'TG']],
  ['İlk yarı', ['IY', 'YARI']],
];
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function renderKupon() {
  const s = state.settings;
  const sys = state.phase === 'ready' && state.coupon?.sys ? state.coupon.sys : (s.sysMode === 'auto' ? null : manualSys());
  const head = `
  <div class="card hero">
    <div>
      ${sys
    ? `<div class="cfg">${s.sysMode === 'auto' ? '<span class="badge good">Otomatik</span> ' : ''}${sys.n} maç · Sistem ${esc(sysName(sys))} · ${sys.misli} misli · ${sys.cols} kolon</div>
         <div class="cost">${fmtTL(sys.stake).replace(' TL', '')}<small>TL</small></div>`
    : `<div class="cfg"><span class="badge good">Otomatik</span> ${s.autoMinN}-${s.autoMaxN} maç · oran ${fmtOdd(s.minOdd)}–${fmtOdd(s.maxOdd)}</div>
         <div class="cost">≤${fmtTL(s.budget).replace(' TL', '')}<small>TL</small></div>`}
    </div>
    <button class="btn sm" data-act="settings"><svg><use href="#i-gear"/></svg>Ayarla</button>
  </div>
  <div class="seg mt12" role="tablist">
    ${Object.entries(OBJECTIVES).map(([k, o]) => `<button data-act="obj" data-v="${k}" class="${s.objective === k ? 'on' : ''}">${esc(o.name.replace(' (önerilen)', ''))}</button>`).join('')}
  </div>
  <p class="note mt8">${esc(OBJECTIVES[s.objective].desc)}</p>
  <div class="chips mt8" aria-label="Bahis türü">
    ${QUICK_GROUPS.map(([l, g], i) => `<button class="chip ${sameSet(s.groups, g) ? 'on' : ''}" data-act="qgroup" data-i="${i}">${esc(l)}</button>`).join('')}
  </div>`;

  if (state.phase === 'loading') return head + '<div class="mt12"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  if (state.phase === 'error') return head + errorBox();

  const picks = couponPicks();
  const locked = state.coupon?.locked || new Set();
  const need = couponSys().n;
  let body = '';
  if (!picks.length || picks.length < need) {
    body = `<div class="warnbox mt12">Ayarlarına uyan yeterli maç bulunamadı (${picks.length}/${need}). Oran aralığını, bahis türlerini ya da maç zamanını genişletmeyi dene.</div>`;
  }
  body += `<div class="section-title"><h2>Günün kuponu</h2><small>${dayLabel(Date.now() / 1000)} · ${state.updatedAt ? 'oranlar ' + fmtTime(state.updatedAt / 1000) : ''}</small></div>`;
  if (picks.length) {
    const first = Math.min(...picks.map((p) => p.d));
    const mins = Math.round((first - Date.now() / 1000) / 60);
    const cls = mins < 30 ? 'warnbox' : 'note box';
    body += `<div class="${cls}" style="margin-bottom:8px">İlk maç ${fmtTime(first)}${mins < 120 ? ` (${mins} dk sonra)` : ''} — kuponu bu saatten önce oynamalısın.</div>`;
  }
  const own = picks.filter((p) => s.groups.includes(p.group)).length;
  if (picks.length && own < picks.length) {
    const names = s.groups.map((g) => GROUPS[g] || g).join(', ');
    body += `<div class="note box" style="margin-bottom:8px">Bugünkü bültende <b>${esc(names)}</b> sunulan uygun maç sayısı ${own}. iddaa bu bahsi genelde büyük liglerde açıyor. Kalan ${picks.length - own} maç, en yüksek ihtimalli yüksek oranlı gol bahisleriyle tamamlandı.</div>`;
  }
  body += picks.map((p, i) => renderPick(p, i, locked.has(p.id))).join('');
  if (picks.length >= minSizeOf(couponSys())) body += renderSummary(picks);
  body += renderRanking();
  body += `
  <div class="btn-row mt12">
    <button class="btn" data-act="regen"><svg><use href="#i-refresh"/></svg>En iyisi</button>
    <button class="btn" data-act="another"><svg><use href="#i-swap"/></svg>Başka öneri</button>
  </div>
  <div class="btn-row mt8">
    <button class="btn" data-act="copy"><svg><use href="#i-copy"/></svg>Kopyala</button>
    <button class="btn primary" data-act="save"><svg><use href="#i-save"/></svg>Oynadım</button>
  </div>
  <p class="note center mt12">Kilitle sabitlediğin maçlar yeniden hesaplamada korunur. "Oynadım" kuponu Geçmiş'e kaydeder. Takım adına dokun: istatistikler ve tüm oranlar.</p>
  <p class="note center"><button class="btn ghost sm" data-act="info"><svg><use href="#i-info"/></svg>Nasıl çalışır?</button></p>`;
  return head + body;
}

function errorBox() {
  return `<div class="errbox mt12"><b>Veriler alınamadı.</b><br>${esc(state.error || '')}<br><span class="muted small">İnternet bağlantını kontrol edip yenile.</span>
    <div class="mt8"><button class="btn sm" data-act="reload"><svg><use href="#i-refresh"/></svg>Tekrar dene</button></div></div>`;
}

// ---------- rendering: matches ----------
// The user's rules: goals wanted, no underdog wins.
function wantedPick(p) {
  const s = state.settings;
  return !(s.goalMode && p.lowGoal) && !(s.noUpset && p.upset);
}

function bestPickFor(a) {
  const s = state.settings;
  const groups = new Set(s.groups);
  let best = null;
  for (const p of a.picks) {
    if (!groups.has(p.group) || p.odd < s.minOdd || p.odd > s.maxOdd || !wantedPick(p)) continue;
    if (!best || p.v > best.v) best = p;
  }
  return best;
}

function renderMaclar() {
  if (state.phase === 'loading' && !state.events.length) return '<div class="skeleton"></div><div class="skeleton"></div>';
  if (state.phase === 'error') return errorBox();
  const f = state.matchFilter;
  const now = Date.now() / 1000;
  const q = f.q.trim().toLocaleLowerCase('tr-TR');
  let list = state.events.filter((e) => e.d > now);
  if (f.day === 'today') list = list.filter((e) => dayLabel(e.d) === 'Bugün');
  if (f.day === 'tomorrow') list = list.filter((e) => dayLabel(e.d) === 'Yarın');
  if (q) list = list.filter((e) => `${e.hn} ${e.an} ${compOf(e.ci).n}`.toLocaleLowerCase('tr-TR').includes(q));
  const rows = list.map((e) => ({ e, a: state.analyses.get(e.i) })).map((x) => ({ ...x, best: x.a ? bestPickFor(x.a) : null }));
  if (f.sort === 'value') rows.sort((x, y) => (y.best?.v ?? 0) - (x.best?.v ?? 0));
  else rows.sort((x, y) => x.e.d - y.e.d);

  let html = `
  <input class="search" type="search" placeholder="Takım veya lig ara" value="${esc(f.q)}" data-input="q" aria-label="Ara">
  <div class="chips mt8">
    ${[['all', 'Tümü'], ['today', 'Bugün'], ['tomorrow', 'Yarın']].map(([k, l]) => `<button class="chip ${f.day === k ? 'on' : ''}" data-act="day" data-v="${k}">${l}</button>`).join('')}
    <span style="flex:none;width:8px"></span>
    ${[['time', 'Saate göre'], ['value', 'Değere göre']].map(([k, l]) => `<button class="chip ${f.sort === k ? 'on' : ''}" data-act="sort" data-v="${k}">${l}</button>`).join('')}
  </div>
  <p class="note mt8">${rows.length} maç. Değer = oran × modelin olasılığı (1.00 = adil oran).</p>`;
  let lastDay = '';
  for (const { e, a, best } of rows.slice(0, 300)) {
    const dl = dayLabel(e.d);
    if (f.sort === 'time' && dl !== lastDay) { html += `<div class="day-head">${esc(dl)}</div>`; lastDay = dl; }
    const ms = a?.picks.filter((p) => p.key === '1_1') || [];
    const o = (no) => ms.find((p) => p.no === no);
    const youth = isYouthOrWomen(e);
    html += `
    <button class="match" data-act="match" data-id="${e.i}">
      <div class="time">${fmtTime(e.d)}<small>MBS ${e.mbc}</small></div>
      <div class="grow">
        <div class="lg">${flagImg(e.ci)}<span class="ellipsis">${esc(compOf(e.ci).n)}</span>${youth ? '<span class="badge">K/Genç</span>' : ''}</div>
        <div class="t">${esc(e.hn)} – ${esc(e.an)}</div>
        ${ms.length ? `<div class="odds3">${[1, 2, 3].map((no) => `<span><i>${['1', 'X', '2'][no - 1]}</i>${fmtOdd(o(no)?.odd)}</span>`).join('')}</div>` : ''}
      </div>
      <div class="best">${best ? `<b>${esc(best.label)}</b>${fmtOdd(best.odd)} · ${fmtPct(best.p)}<br><span class="badge ${valueClass(best.v)}">${best.v.toFixed(2)}</span>` : '<span class="faint">–</span>'}</div>
    </button>`;
  }
  if (!rows.length) html += '<div class="empty">Maç bulunamadı.</div>';
  return html;
}

// ---------- rendering: match detail sheet ----------
function statsBlock(e, st) {
  if (!st) return '<div class="note box">İstatistikler yükleniyor…</div>';
  if (!st.ok) return '<div class="note box">Bu maç için istatistik bulunamadı.</div>';
  let html = '';
  const rh = st.recentHome, ra = st.recentAway;
  const form = (r) => (r ? `<span class="form">${r.list.slice(0, 5).map((m) => `<i class="${m.r}">${m.r}</i>`).join('')}</span>` : '–');
  const sd = st.standings;
  const row = (id) => sd?.rows.find((r) => r.si === id);
  const th = sd ? row(sd.homeId) : null, ta = sd ? row(sd.awayId) : null;
  const pct = (x, n) => (n ? `%${Math.round((x / n) * 100)}` : '–');
  const avg = (x, n) => (n ? (x / n).toFixed(2) : '–');
  html += `<div class="stat-grid">
    <div class="l ellipsis">${esc(e.hn)}</div><div class="c"></div><div class="rr ellipsis">${esc(e.an)}</div>
    <div class="l">${form(rh)}</div><div class="c">Son 5</div><div class="rr">${form(ra)}</div>
    ${th && ta ? `
    <div class="l">${th.r}. · ${th.pt} puan</div><div class="c">Sıra</div><div class="rr">${ta.r}. · ${ta.pt} puan</div>
    <div class="l">${th.gf}:${th.ga} (${th.p} m)</div><div class="c">Gol A:Y</div><div class="rr">${ta.gf}:${ta.ga} (${ta.p} m)</div>` : ''}
    ${rh && ra ? `
    <div class="l">${rh.w}-${rh.d}-${rh.l}</div><div class="c">Son ${rh.games}/${ra.games} G-B-M</div><div class="rr">${ra.w}-${ra.d}-${ra.l}</div>
    <div class="l">${avg(rh.gf, rh.games)} / ${avg(rh.ga, rh.games)}</div><div class="c">Ort. attı / yedi</div><div class="rr">${avg(ra.gf, ra.games)} / ${avg(ra.ga, ra.games)}</div>
    <div class="l">${pct(rh.over25, rh.games)}</div><div class="c">2.5 Üst</div><div class="rr">${pct(ra.over25, ra.games)}</div>
    <div class="l">${pct(rh.btts, rh.games)}</div><div class="c">KG Var</div><div class="rr">${pct(ra.btts, ra.games)}</div>` : ''}
  </div>`;
  if (sd) html += `<p class="note mt8">Puan durumu: ${esc(sd.season)}</p>`;
  const ex = state.statsExtra.get(e.i) || {};
  if (rh?.htGames && ra?.htGames) {
    html += `<h4>İlk yarı (son maçlar)</h4><div class="stat-grid">
      <div class="l">${(rh.htFor / rh.htGames).toFixed(2)} / ${(rh.htAgainst / rh.htGames).toFixed(2)}</div><div class="c">İY attı / yedi</div><div class="rr">${(ra.htFor / ra.htGames).toFixed(2)} / ${(ra.htAgainst / ra.htGames).toFixed(2)}</div>
      <div class="l">${pct(rh.htScored, rh.htGames)}</div><div class="c">İY gol oldu</div><div class="rr">${pct(ra.htScored, ra.htGames)}</div>
      <div class="l">${pct(rh.htTotal, rh.ftTotalHt)}</div><div class="c">Gollerin İY payı</div><div class="rr">${pct(ra.htTotal, ra.ftTotalHt)}</div>
      ${rh.comeback !== undefined && ra.comeback !== undefined ? `
      <div class="l">${rh.comeback}/${rh.htGames}</div><div class="c">İY geride → kazandı</div><div class="rr">${ra.comeback}/${ra.htGames}</div>
      <div class="l">${rh.blown}/${rh.htGames}</div><div class="c">İY önde → kaybetti</div><div class="rr">${ra.blown}/${ra.htGames}</div>` : ''}
    </div>`;
  }
  if (ex.h2h?.length) {
    html += '<h4>Aralarındaki son maçlar</h4><table class="tbl">' + ex.h2h.map((m) => `<tr><td class="muted small">${new Date(m.t * 1000).toLocaleDateString('tr-TR')}</td><td>${esc(m.hn)}</td><td class="r"><b>${m.hs}–${m.as}</b></td><td class="r">${esc(m.an)}</td></tr>`).join('') + '</table>';
  }
  if (ex.insights?.length) {
    html += '<h4>iddaa istatistik notları</h4>' + ex.insights.map((t) => `<div class="insight">${esc(t)}</div>`).join('');
  }
  return html;
}

// What happened when this match was played 10.000 times.
function simSection(a) {
  if (!a?.sim) return '';
  const { cells, sim } = a;
  const N = sim.length;
  const score = new Map(), ht = [0, 0, 0];
  let o25 = 0, btts = 0, htGoal = 0, both = 0;
  for (let r = 0; r < N; r++) {
    const i = sim[r];
    const h = cells.H[i], aw = cells.A[i], h1 = cells.H1[i], a1 = cells.A1[i];
    const k = `${h}-${aw}`;
    score.set(k, (score.get(k) || 0) + 1);
    ht[h1 > a1 ? 0 : h1 === a1 ? 1 : 2]++;
    if (h + aw > 2.5) o25++;
    if (h > 0 && aw > 0) btts++;
    if (h1 + a1 > 0) htGoal++;
    if (h1 + a1 > 0 && h + aw - h1 - a1 > 0) both++;
  }
  const top = [...score.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5);
  const c = (x) => x.toLocaleString('tr-TR');
  return `<h4>10.000 simülasyon</h4>
    <div class="stat-grid">
      <div class="l">${c(htGoal)}</div><div class="c">İlk yarıda gol oldu</div><div class="rr">%${Math.round((htGoal / N) * 100)}</div>
      <div class="l">${c(both)}</div><div class="c">İki yarıda da gol</div><div class="rr">%${Math.round((both / N) * 100)}</div>
      <div class="l">${c(o25)}</div><div class="c">2.5 Üst</div><div class="rr">%${Math.round((o25 / N) * 100)}</div>
      <div class="l">${c(btts)}</div><div class="c">KG Var</div><div class="rr">%${Math.round((btts / N) * 100)}</div>
      <div class="l">${c(ht[0])} / ${c(ht[1])} / ${c(ht[2])}</div><div class="c">İY 1 / 0 / 2</div><div class="rr"></div>
    </div>
    <p class="note mt8">En sık skorlar: ${top.map(([k, v]) => `<b>${k}</b> (${c(v)})`).join(' · ')}</p>`;
}

function matchSheetHtml(eventId) {
  const e = state.eventsById.get(eventId);
  const a = state.analyses.get(eventId);
  if (!e) return '<p>Maç bulunamadı.</p>';
  const inCoupon = new Set(state.coupon?.ids || []);
  let html = `
    <div class="meta muted small row">${flagImg(e.ci)}<span>${esc(compOf(e.ci).n)} · ${dayLabel(e.d)} ${fmtTime(e.d)} · MBS ${e.mbc}</span></div>
    <h3>${esc(e.hn)} – ${esc(e.an)}</h3>
    <a class="btn sm mt8" href="${api.iddaaMatchUrl(e.i)}" target="_blank" rel="noopener"><svg><use href="#i-ext"/></svg>iddaa.com'da aç</a>`;
  if (a) {
    const pr = a.probs;
    html += `
    <h4>Model</h4>
    <div class="kpis">
      <div class="kpi"><div class="k">Ev / X / Dep</div><div class="v" style="font-size:15px">${fmtPct(pr.home)} · ${fmtPct(pr.draw)} · ${fmtPct(pr.away)}</div></div>
      <div class="kpi"><div class="k">2.5 Üst · KG</div><div class="v" style="font-size:15px">${fmtPct(pr.over25)} · ${fmtPct(pr.btts)}</div></div>
      <div class="kpi"><div class="k">Beklenen gol</div><div class="v" style="font-size:15px">${a.lh.toFixed(2)} – ${a.la.toFixed(2)}</div></div>
    </div>
    <p class="note mt8">Oranlardan hesaplandı (ort. kâr payı ${fmtPct(a.margin, 0)}).${a.stats?.blend ? ` İstatistikle düzeltilmiş beklenti ${a.stats.blend.lh.toFixed(2)} – ${a.stats.blend.la.toFixed(2)} gol, gollerin %${Math.round(a.stats.blend.half * 100)}'i ilk yarıda.` : ''}</p>
    ${simSection(a)}`;
  }
  html += `<h4>İstatistikler</h4><div id="stats-slot">${statsBlock(e, state.stats.get(eventId))}</div>`;
  if (a) {
    const byMarket = new Map();
    for (const p of a.picks) {
      const k = p.market + (p.line !== null ? ` ${p.line}` : '');
      if (!byMarket.has(k)) byMarket.set(k, []);
      byMarket.get(k).push(p);
    }
    html += '<h4>Tüm seçenekler</h4>';
    for (const [name, list] of byMarket) {
      html += `<div class="muted small mt12" style="font-weight:700">${esc(name)}</div>`;
      html += list.map((p) => `
        <div class="mk-row ${inCoupon.has(p.id) ? 'in' : ''}">
          <div>${esc(p.label)} <span class="badge ${valueClass(p.v)}">${p.v.toFixed(2)}</span></div>
          <div class="p">${fmtPct(p.p)}</div>
          <div class="o">${fmtOdd(p.odd)}</div>
          <button class="add" data-act="add" data-pick="${esc(p.id)}" aria-label="Kupona ekle"><svg><use href="#${inCoupon.has(p.id) ? 'i-save' : 'i-plus'}"/></svg></button>
        </div>`).join('');
    }
  }
  return html;
}

async function openMatch(eventId) {
  openSheet(matchSheetHtml(eventId));
  const e = state.eventsById.get(eventId);
  const jobs = [];
  if (e && !state.detailed.has(eventId)) jobs.push(loadDetails([e]).catch(() => {}));
  if (!state.stats.has(eventId)) {
    jobs.push(api.fetchStats(eventId).then((st) => state.stats.set(eventId, st)).catch(() => state.stats.set(eventId, { ok: false })));
  }
  if (!state.statsExtra.has(eventId)) {
    jobs.push(api.fetchStatsExtra(eventId).then((x) => state.statsExtra.set(eventId, x)).catch(() => state.statsExtra.set(eventId, { h2h: [], insights: [] })));
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (e) { analyzeOne(e); rebuildPickIndex(); }
  if (sheetOpen) {
    const top = $('#sheet-body').scrollTop;
    $('#sheet-body').innerHTML = matchSheetHtml(eventId);
    $('#sheet-body').scrollTop = top;
  }
}

// ---------- rendering: 10 odds finder ----------
function computeCombos() {
  const s = state.settings;
  const picks = eligiblePicks({ maxMbc: 4, ignoreExcluded: true });
  const wide = [];
  const groups = new Set(s.groups);
  for (const a of state.analyses.values()) {
    const e = state.eventsById.get(a.eventId);
    if (!e || !eventEligible(e)) continue;
    for (const p of a.picks) if (groups.has(p.group) && (p.mbc ?? 1) <= 4 && p.odd >= 1.15 && p.p >= 0.08 && wantedPick(p)) wide.push(p);
  }
  state.combos = findTargetCombos(wide.length ? wide : picks, { target: s.target, ks: [2, 3, 4], top: 4 });
}

function renderOran() {
  if (state.phase === 'loading') return '<div class="skeleton"></div><div class="skeleton"></div>';
  if (state.phase === 'error') return errorBox();
  const s = state.settings;
  if (!state.combos) computeCombos();
  let html = `
  <div class="card">
    <div class="row between">
      <div><b>Hedef oran</b><div class="note">2, 3 ve 4 maçlık kombinasyonlar (MBS kurallarına uygun)</div></div>
      <div class="stepper">
        <button data-act="target" data-v="-1" aria-label="Azalt">−</button>
        <input type="number" inputmode="decimal" min="2" max="200" step="1" value="${s.target}" data-input="target" aria-label="Hedef oran">
        <button data-act="target" data-v="1" aria-label="Artır">+</button>
      </div>
    </div>
  </div>`;
  const groups = [2, 3, 4];
  for (const k of groups) {
    const list = state.combos.filter((c) => c.k === k);
    html += `<div class="section-title"><h2>${li(k)} kombinasyonlar</h2><small>${list.length ? 'en yüksek beklenen getiri' : ''}</small></div>`;
    if (!list.length) { html += `<div class="note box">Bu hedefe uygun ${li(k)} kombinasyon yok.</div>`; continue; }
    list.forEach((c) => {
      const idx = state.combos.indexOf(c);
      html += `<div class="card">
        <div class="row between"><div><span class="badge good">Oran ${fmtOdd(c.totalOdd)}</span> <span class="badge">Tutma olasılığı ${fmtPct(c.prob, 1)}</span></div><span class="badge ${valueClass(c.ev)}">değer ${c.ev.toFixed(2)}</span></div>
        ${c.picks.map((p) => {
          const e = state.eventsById.get(p.eventId);
          return `<div class="mk-row"><div><div class="small muted">${fmtTime(p.d)} · ${esc(compOf(p.league).n)}</div><span data-act="match" data-id="${p.eventId}">${e ? `${esc(e.hn)} – ${esc(e.an)}` : ''}</span><div><b>${esc(p.label)}</b></div></div><div class="p">${fmtPct(p.p)}</div><div class="o">${fmtOdd(p.odd)}</div><div></div></div>`;
        }).join('')}
        <div class="btn-row mt8">
          <button class="btn sm" data-act="combo-copy" data-i="${idx}"><svg><use href="#i-copy"/></svg>Kopyala</button>
          <button class="btn sm" data-act="combo-use" data-i="${idx}"><svg><use href="#i-lock"/></svg>Sisteme sabitle</button>
        </div>
      </div>`;
    });
  }
  html += '<p class="note mt12">"Sisteme sabitle" bu maçları günün sistem kuponuna kilitler; kalan maçları uygulama tamamlar.</p>';
  return html;
}

// ---------- rendering: history ----------
function couponOutcome(c) {
  const settled = c.picks.every((p) => p.result === true || p.result === false);
  const hits = c.picks.filter((p) => p.result === true).map((p) => p.odd);
  const pay = payoutFor(hits, c.sizes, c.misli, c.unit);
  return { settled, pay, hits: hits.length };
}

function renderGecmis() {
  const hist = state.history;
  if (!hist.length) return '<div class="empty">Henüz kayıtlı kupon yok.<br><span class="small">Kupon sekmesinde "Oynadım, kaydet"e bastığında burada takip edilir.</span></div>';
  let stake = 0, ret = 0, settledN = 0, wins = 0;
  for (const c of hist) {
    const o = couponOutcome(c);
    if (o.settled) { stake += c.stake; ret += o.pay; settledN++; if (o.pay > c.stake) wins++; }
  }
  const net = ret - stake;
  let html = `
  <div class="kpis">
    <div class="kpi"><div class="k">Yatırılan</div><div class="v">${fmtTL(stake)}</div></div>
    <div class="kpi"><div class="k">Dönen</div><div class="v">${fmtTL(ret)}</div></div>
    <div class="kpi"><div class="k">Net</div><div class="v ${net >= 0 ? 'good' : 'warn'}">${net >= 0 ? '+' : ''}${fmtTL(net)}</div></div>
  </div>
  <p class="note mt8">${settledN} sonuçlanan kupon · ${wins} kârlı. Sadece sonuçlanan kuponlar sayılır.</p>
  <button class="btn block mt8" data-act="hist-check"><svg><use href="#i-refresh"/></svg>Sonuçları kontrol et</button>`;
  hist.slice().reverse().forEach((c) => {
    const o = couponOutcome(c);
    const status = o.settled ? (o.pay > c.stake ? `<span class="badge good">+${fmtTL(o.pay - c.stake)}</span>` : `<span class="badge bad">${fmtTL(o.pay - c.stake)}</span>`) : '<span class="badge warn">Bekliyor</span>';
    html += `<div class="card mt12">
      <div class="row between"><div><b>${esc(new Date(c.createdAt).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'short' }))}</b><div class="small muted">Sistem ${sizesLabel(c.sizes)} · ${c.misli} misli · ${fmtTL(c.stake)} · ${o.hits}/${c.picks.length} tuttu</div></div>${status}</div>
      <div class="mt8">${c.picks.map((p, j) => `
        <div class="hist-pick">
          <button class="res ${p.result === true ? 'w' : p.result === false ? 'l' : ''}" data-act="hist-res" data-h="${c.id}" data-p="${j}" aria-label="Sonucu değiştir">${p.result === true ? '✓' : p.result === false ? '✕' : '·'}</button>
          <div class="grow"><div class="ellipsis">${esc(p.hn)} – ${esc(p.an)}</div><div class="small muted">${fmtTime(p.d)} · ${esc(p.label)}${p.score ? ` · <b>${p.score.h}-${p.score.a}</b>${p.score.h1 !== null && p.score.h1 !== undefined ? ` (İY ${p.score.h1}-${p.score.a1})` : ''}` : ''}</div></div>
          <div class="o"><b>${fmtOdd(p.odd)}</b></div>
        </div>`).join('')}</div>
      <div class="row between mt8"><span class="small muted">${o.settled ? `Dönen: ${fmtTL(o.pay)}` : `Şu ana kadar: ${fmtTL(o.pay)}`}</span><button class="btn ghost sm" data-act="hist-del" data-h="${c.id}">Sil</button></div>
    </div>`;
  });
  html += '<p class="note mt12">Sonuçlar iddaa istatistik servisinden otomatik alınır; bulunamazsa kutucuğa dokunarak elle işaretleyebilirsin.</p>';
  return html;
}

async function checkResults() {
  const now = Date.now() / 1000;
  const jobs = [];
  for (const c of state.history) for (const p of c.picks) {
    if (p.result === true || p.result === false) continue;
    if (now < p.d + 2.1 * 3600) continue;
    jobs.push(p);
  }
  if (!jobs.length) { toast('Sonuçlanmayı bekleyen maç yok'); return; }
  setStatus('Sonuçlar kontrol ediliyor…');
  let found = 0;
  await api.pool(jobs, 4, async (p) => {
    const score = await api.fetchResult(p.eventId, p.d, p.hn);
    if (!score) return;
    const r = settlePick(p, score);
    if (r === null) return;
    p.result = r; p.score = score; found++;
  });
  store.set('history', state.history);
  setStatus(statusLine());
  toast(found ? `${found} maç sonuçlandı` : 'Henüz sonuç bulunamadı');
  render();
}

// ---------- settings sheet ----------
function settingsHtml() {
  const s = state.settings;
  const cols = columnCount(s.n, s.sizes.filter((k) => k <= s.n));
  const auto = s.sysMode === 'auto';
  return `
  <h3>Ayarlar</h3>
  <div class="field">
    <span class="lbl">Sistem seçimi</span>
    <div class="seg">${[['auto', 'Otomatik (en iyisi)'], ['manual', 'Elle']].map(([k, l]) => `<button class="${s.sysMode === k ? 'on' : ''}" data-set="sysMode" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="hint">${auto ? 'Bütçene sığan tüm sistemler (maç sayısı × 2\'li/3\'lü/… kolonlar) tek tek denenir, en iyisi seçilir.' : 'Maç sayısını, sistemi ve misliyi sen belirlersin.'}</div>
  </div>
  ${auto ? `
  <div class="two">
    <div class="field"><label for="f-budget">Bütçe (TL)</label><input id="f-budget" class="inp" type="number" inputmode="decimal" min="1" step="1" value="${s.budget}" data-setin="budget"></div>
    <div class="field"><label for="f-minstake">Asgari kupon bedeli</label><input id="f-minstake" class="inp" type="number" inputmode="decimal" min="0" step="1" value="${s.minStake}" data-setin="minStake"></div>
  </div>
  <div class="two">
    <div class="field"><span class="lbl">En az maç</span>
      <div class="stepper"><button data-set="autoMinN" data-d="-1">−</button><input value="${s.autoMinN}" readonly aria-label="En az maç"><button data-set="autoMinN" data-d="1">+</button></div></div>
    <div class="field"><span class="lbl">En çok maç</span>
      <div class="stepper"><button data-set="autoMaxN" data-d="-1">−</button><input value="${s.autoMaxN}" readonly aria-label="En çok maç"><button data-set="autoMaxN" data-d="1">+</button></div></div>
  </div>` : `
  <div class="field">
    <span class="lbl">Maç sayısı</span>
    <div class="stepper"><button data-set="n" data-d="-1">−</button><input value="${s.n}" readonly aria-label="Maç sayısı"><button data-set="n" data-d="1">+</button></div>
  </div>
  <div class="field">
    <span class="lbl">Sistem</span>
    <div class="chips wrap">${Array.from({ length: s.n }, (_, i) => i + 1).filter((k) => k >= 2).map((k) => `<button class="chip ${s.sizes.includes(k) ? 'on' : ''}" data-set="size" data-v="${k}">${li(k)}</button>`).join('')}</div>
    <div class="hint">${cols} kolon · ${fmtTL(cols * s.misli * s.unit)}</div>
  </div>
  <div class="two">
    <div class="field"><span class="lbl">Misli</span>
      <div class="stepper"><button data-set="misli" data-d="-1">−</button><input value="${s.misli}" readonly aria-label="Misli"><button data-set="misli" data-d="1">+</button></div></div>
    <div class="field"><label for="f-unit">Misli bedeli (TL)</label><input id="f-unit" class="inp" type="number" inputmode="decimal" min="0.25" step="0.25" value="${s.unit}" data-setin="unit"></div>
  </div>`}
  <div class="two">
    <div class="field"><label for="f-min">En düşük oran</label><input id="f-min" class="inp" type="number" inputmode="decimal" step="0.05" min="1.01" value="${s.minOdd}" data-setin="minOdd"></div>
    <div class="field"><label for="f-max">En yüksek oran</label><input id="f-max" class="inp" type="number" inputmode="decimal" step="0.05" min="1.05" value="${s.maxOdd}" data-setin="maxOdd"></div>
  </div>
  <div class="field">
    <label for="f-target">Hedef kazanç (TL)</label><input id="f-target" class="inp" type="number" inputmode="numeric" step="1000" min="100" value="${s.targetWin}" data-setin="targetWin">
    <div class="hint">"Hedef kazanç" seçiliyken kupon bu tutara ulaşma olasılığı en yüksek olacak şekilde kurulur.</div>
  </div>
  <div class="field">
    <span class="lbl">Bahis türleri</span>
    <div class="chips wrap">${Object.entries(GROUPS).map(([k, n]) => `<button class="chip ${s.groups.includes(k) ? 'on' : ''}" data-set="group" data-v="${k}">${esc(n)}</button>`).join('')}</div>
  </div>
  <div class="field">
    <span class="lbl">Maç zamanı</span>
    <div class="seg">${[['today', 'Bugün'], ['24', '24 saat'], ['48', '2 gün']].map(([k, l]) => `<button class="${s.window === k ? 'on' : ''}" data-set="window" data-v="${k}">${l}</button>`).join('')}</div>
  </div>
  <div class="field">
    <span class="lbl">Oran tipi</span>
    <div class="seg">${[['odd', 'Kral oran (iddaa.com)'], ['wodd', 'Normal oran']].map(([k, l]) => `<button class="${s.oddField === k ? 'on' : ''}" data-set="oddField" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="hint">iddaa.com'da taç işaretli kral oranlar gösterilir ve kazanç onlarla hesaplanır.</div>
  </div>
  <div class="field">
    <span class="lbl">İstatistik ağırlığı</span>
    <div class="seg">${[[0, 'Kapalı'], [0.2, '%20'], [0.35, '%35']].map(([k, l]) => `<button class="${s.statsWeight === k ? 'on' : ''}" data-set="statsWeight" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="hint">Takımların puan durumu ve son 10 maçından kurulan modelin, oranlardan gelen modele katkısı.</div>
  </div>
  <div class="field">
    <span class="lbl">Aynı ligden en fazla</span>
    <div class="seg">${[[1, '1'], [2, '2'], [3, '3'], [0, 'Sınırsız']].map(([k, l]) => `<button class="${s.maxPerLeague === k ? 'on' : ''}" data-set="maxPerLeague" data-v="${k}">${l}</button>`).join('')}</div>
  </div>
  <div class="field">
    <label class="switch"><span>Gol bekle: Alt, KG Yok, 0-0 gibi az gollü seçimleri alma</span><input type="checkbox" ${s.goalMode ? 'checked' : ''} data-setcb="goalMode"></label>
    <label class="switch"><span>Sürpriz galibiyet oynama (kazanma ihtimali %22'nin altındaki takıma "kazanır" yok; İY/MS 1/2 – 2/1 favori kazanıyorsa serbest)</span><input type="checkbox" ${s.noUpset ? 'checked' : ''} data-setcb="noUpset"></label>
    <label class="switch"><span>Kadın, genç (U21 vb.) ve amatör maçlarını alma</span><input type="checkbox" ${s.noYouth ? 'checked' : ''} data-setcb="noYouth"></label>
  </div>
  <div class="btn-row mt16">
    <button class="btn" data-set="reset">Varsayılanlar</button>
    <button class="btn primary" data-set="close">Uygula</button>
  </div>
  <div class="row between mt16"><span class="small muted">Sürüm ${APP_VERSION}</span><button class="btn sm" data-set="update"><svg><use href="#i-refresh"/></svg>Güncellemeyi zorla</button></div>
  ${installHint()}`;
}

function installHint() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return '';
  if (state.installPrompt) return '<button class="btn block mt12" data-set="install">Ana ekrana ekle</button>';
  return '<p class="note box mt12">Telefonda uygulama gibi kullanmak için: iPhone\'da Safari → Paylaş → <b>Ana Ekrana Ekle</b>; Android\'de Chrome menüsü → <b>Ana ekrana ekle</b>.</p>';
}

let settingsDirty = { reanalyze: false, regen: false };
function onSettingsAction(t) {
  const s = state.settings;
  const k = t.dataset.set;
  if (k === 'sysMode') {
    s.sysMode = t.dataset.v;
    settingsDirty.regen = true;
  } else if (k === 'autoMinN') {
    s.autoMinN = Math.max(2, Math.min(s.autoMaxN, s.autoMinN + Number(t.dataset.d)));
    settingsDirty.regen = true;
  } else if (k === 'autoMaxN') {
    s.autoMaxN = Math.max(s.autoMinN, Math.min(10, s.autoMaxN + Number(t.dataset.d)));
    settingsDirty.regen = true;
  } else if (k === 'n') {
    s.n = Math.max(3, Math.min(10, s.n + Number(t.dataset.d)));
    s.sizes = s.sizes.filter((x) => x <= s.n);
    if (!s.sizes.length) s.sizes = [s.n];
    settingsDirty.regen = true;
  } else if (k === 'size') {
    const v = Number(t.dataset.v);
    s.sizes = s.sizes.includes(v) ? s.sizes.filter((x) => x !== v) : [...s.sizes, v].sort((a, b) => a - b);
    if (!s.sizes.length) s.sizes = [v];
    settingsDirty.regen = true;
  } else if (k === 'misli') {
    s.misli = Math.max(1, Math.min(500, s.misli + Number(t.dataset.d)));
    settingsDirty.regen = true;
  } else if (k === 'group') {
    const v = t.dataset.v;
    s.groups = s.groups.includes(v) ? s.groups.filter((x) => x !== v) : [...s.groups, v];
    if (!s.groups.length) s.groups = ['MS'];
    settingsDirty.regen = true;
  } else if (k === 'window') { s.window = t.dataset.v; settingsDirty.regen = true; }
  else if (k === 'oddField') { s.oddField = t.dataset.v; settingsDirty.reanalyze = true; }
  else if (k === 'statsWeight') { s.statsWeight = Number(t.dataset.v); settingsDirty.reanalyze = true; }
  else if (k === 'maxPerLeague') { s.maxPerLeague = Number(t.dataset.v); settingsDirty.regen = true; }
  else if (k === 'reset') { state.settings = { ...DEFAULTS }; settingsDirty = { reanalyze: true, regen: true }; }
  else if (k === 'install') { state.installPrompt?.prompt(); state.installPrompt = null; return; }
  else if (k === 'update') { forceUpdate(); return; }
  else if (k === 'close') { closeSheet(); return; }
  saveSettings();
  const top = $('#sheet-body').scrollTop;
  $('#sheet-body').innerHTML = settingsHtml();
  $('#sheet-body').scrollTop = top;
}

function onSettingsInput(t) {
  const s = state.settings;
  if (t.dataset.setin) {
    const v = parseFloat(String(t.value).replace(',', '.'));
    if (!Number.isFinite(v)) return;
    const k = t.dataset.setin;
    if (k === 'unit') s.unit = Math.max(0.25, v);
    if (k === 'budget') s.budget = Math.max(1, v);
    if (k === 'targetWin') s.targetWin = Math.max(100, v);
    if (k === 'minStake') s.minStake = Math.max(0, v);
    if (k === 'minOdd') s.minOdd = Math.max(1.01, v);
    if (k === 'maxOdd') s.maxOdd = Math.max(s.minOdd + 0.05, v);
    settingsDirty.regen = true;
  }
  if (t.dataset.setcb) { s[t.dataset.setcb] = t.checked; settingsDirty.regen = true; }
  saveSettings();
}

async function applySettings() {
  const d = settingsDirty;
  settingsDirty = { reanalyze: false, regen: false };
  if (state.phase !== 'ready') { render(); return; }
  state.combos = null;
  if (d.reanalyze) {
    await analyzeAll('Yeniden hesaplanıyor');
    await loadStatsForTop();
    setProgress(null);
  }
  if (d.reanalyze || d.regen) { state.tempExcluded.clear(); await buildCoupon(); }
  setStatus(statusLine());
  render();
}

function infoHtml() {
  return `
  <h3>Nasıl çalışır?</h3>
  <p class="note"><b>Gol bekle + sürpriz yok (varsayılan):</b> Alt, KG Yok, 0-0, "0-1 gol" gibi ya da ancak az gollü maçta tutan seçimler alınmaz. Kazanma ihtimali %22'nin altındaki takıma "kazanır" oynanmaz; favori maçı kazanıyorsa İY/MS 1/2 veya 2/1 serbesttir.</p>
  <p class="note"><b>Simülasyon:</b> Günün her maçı, oranlardan ve takım istatistiklerinden (puan durumu, son 10 maç, attığı/yediği goller, ilk yarı golleri) kurulan gol modeliyle 10.000 kez oynatılır. Her seçimin kaç kez tuttuğu ve kuponun bu 10.000 günde ne kazandırdığı gösterilir.</p>
  <p class="note">0. <b>Yüksek oran modu (varsayılan):</b> Günün bütün maçlarının bütün bahis seçenekleri (MS, İY/MS 1/2-2/1, maç skoru, İY skoru, kaç farkla, yarı bahisleri, MS+Alt/Üst, korner, kart…) incelenir; oranı 5-30 arasındaki her seçeneğin gerçek olasılığı hesaplanır ve 6 maçlık 3-4-5-6 sisteme (2 misli = 84 TL) en uygun 6 seçim seçilir. Kupon 10.000 kez simüle edilir.</p>
  <p class="note"><b>İY/MS 1/2 – 2/1 hakkında:</b> Bunlar her gün değerlendirilir, ama iddaa'nın en yüksek kâr payını koyduğu bahislerdir (1 TL'ye ortalama ~0.60 TL döner; MS ve skor kombinlerinde ~0.85-0.90). Bu yüzden ancak gerçekten en iyisiyse kupona girer. Sadece İY/MS istiyorsan kupon ekranındaki "İY/MS" kısayolunu seç.</p>
  <p class="note">1. <b>Veri:</b> Bülten ve oranlar iddaa.com'dan canlı çekilir. İstatistikler (puan durumu, son 10 maç, aralarındaki maçlar, iddaa istatistik notları) iddaa istatistik servisinden gelir.</p>
  <p class="note">2. <b>Olasılık:</b> Her pazarın oranından iddaa'nın kâr payı çıkarılır. Sonra tüm pazarlara (MS, Alt/Üst, KG, handikap, takım golleri, ilk yarı…) aynı anda uyan bir gol modeli (Dixon-Coles düzeltmeli Poisson) kurulur. Böylece her seçenek için tutarlı bir olasılık elde edilir; açık olan istatistik ağırlığı kadar da takım istatistiklerinden kurulan model karıştırılır.</p>
  <p class="note">3. <b>Değer:</b> oran × olasılık. 1.00 adil oran demektir. iddaa'nın kâr payı %15-25 olduğundan çoğu seçenek 0.80-0.92 arasındadır; uygulama en yüksek değerlileri öne alır.</p>
  <p class="note">4. <b>Sistem hesabı:</b> Her kolon ayrı hesaplanır (örn. 6 maçta 3-4-5-6 = 20+15+6+1 = 42 kolon). Tüm olası sonuçlar (6 maçta 2⁶ = 64) tek tek değerlendirilip kazanç, kâra geçme olasılığı ve beklenen dönüş bulunur.</p>
  <p class="note">5. <b>En iyi sistem (Otomatik):</b> Bütçene sığan bütün sistemler (ör. 5 maç 2'li, 6 maç 3'lü, 7 maç 3-4, 6 maç 3-4-5-6…) denenir; her biri için maçlar ayrı ayrı optimize edilir ve seçtiğin hedefe göre en iyisi seçilir. Karşılaştırma tablosundan diğerlerine geçebilirsin.</p>
  <p class="note">6. <b>Neden küçük kolonlar?</b> Bir kolondaki her maç iddaa'nın kâr payını bir kez daha çarpar: 2'li kolon 1 TL'ye ~0.75 TL, 3'lü ~0.64, 4'lü ~0.55, 6'lı ~0.41 TL geri döndürür. Bu yüzden 5-6'lı kolonlar sadece büyük ikramiye şansı katar, kâr şansını ve getiriyi düşürür. 2'li kolon için kupondaki maçların MBS'si en fazla 2 olmalıdır; uygulama bunu otomatik kontrol eder.</p>
  <div class="warnbox mt12"><b>Önemli:</b> Hiçbir model kazanç garanti etmez. Kâr payı nedeniyle sistem kuponlarının uzun vadeli beklenen dönüşü yatırılanın altındadır; uygulama bu kaybı küçültmeye ve en olası kombinasyonları bulmaya çalışır. Kaybetmeyi göze alabileceğin tutarla oyna. 18 yaş altına yasaktır.</div>`;
}

// ---------- main render ----------
function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  const fn = { kupon: renderKupon, maclar: renderMaclar, oran: renderOran, gecmis: renderGecmis }[state.tab] || renderKupon;
  view.innerHTML = fn();
}

function statusLine() {
  const n = state.events.length;
  return `${state.updatedAt ? `${n} maç · güncellendi ${fmtTime(state.updatedAt / 1000)}` : `${n} maç`} · v${APP_VERSION}`;
}

// Drop every cached copy of the app and load it again from the server.
async function forceUpdate() {
  try {
    if ('caches' in window) for (const k of await caches.keys()) await caches.delete(k);
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    for (const r of regs) await r.unregister();
  } catch { /* ignore */ }
  location.replace(`${location.pathname}?v=${Date.now()}`);
}

// If the server has a newer version than this copy, update once automatically.
async function checkForUpdate() {
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { v } = await r.json();
    if (v > APP_VERSION && sessionStorage.getItem('sk-updated') !== String(v)) {
      sessionStorage.setItem('sk-updated', String(v));
      toast('Yeni sürüm yükleniyor…');
      forceUpdate();
    }
  } catch { /* offline: keep running this copy */ }
}

// ---------- events ----------
document.querySelector('.tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  store.set('tab', state.tab);
  render();
  window.scrollTo({ top: 0 });
});

$('#btn-refresh').addEventListener('click', () => loadAll(true));
$('#btn-settings').addEventListener('click', () => openSheet(settingsHtml()));

function slotPick(i) { return couponPicks()[Number(i)]; }
// Alternatives come from the chosen bet types, or from all goal bets for a filler slot.
function slotPool(p) {
  const s = state.settings;
  const own = buildPool(eligiblePicks(), 4, 160);
  if (p && s.groups.includes(p.group) && own.length >= 3) return own;
  return buildPool(eligiblePicks({ groups: ALL_GOAL_GROUPS }), 4, 160);
}

function replaceSlot(i, newPick) {
  const ids = state.coupon.ids.slice();
  const old = ids[i];
  ids[i] = newPick.id;
  state.coupon.ids = ids;
  state.coupon.locked.delete(old);
  saveCoupon();
}

async function addPickToCoupon(pickId) {
  const p = state.pickById.get(pickId);
  if (!p) return;
  const s = state.settings;
  if (!state.coupon) state.coupon = { ids: [], locked: new Set(), excluded: new Set(), sys: null, ranking: null };
  const c = state.coupon;
  c.excluded.delete(p.eventId);
  state.tempExcluded.delete(p.eventId);
  // drop any other pick from the same match
  const sameEvent = c.ids.find((id) => Number(String(id).split(':')[0]) === p.eventId);
  if (sameEvent) { c.ids = c.ids.filter((id) => id !== sameEvent); c.locked.delete(sameEvent); }
  if (s.sysMode === 'auto') {
    // lock it and search again: the best system may change to fit this pick's MBS
    c.ids.push(p.id);
    c.locked.add(p.id);
    await buildCoupon();
    toast(couponPicks().some((q) => q.id === p.id) ? 'Eklendi, sistem yeniden hesaplandı' : 'Bu seçim bütçeye uyan bir sisteme sığmadı');
    return;
  }
  const sys = couponSys();
  const minSize = minSizeOf(sys);
  if ((p.mbc ?? 1) > minSize) { toast(`Bu seçimin MBS'si ${p.mbc}; ${li(minSize)} kolonlarda oynanamaz`); return; }
  if (c.ids.length < sys.n) {
    c.ids.push(p.id);
  } else {
    // replace the weakest unlocked pick
    const picks = couponPicks();
    let worst = -1;
    picks.forEach((q, i) => { if (!c.locked.has(q.id) && (worst < 0 || q.v < picks[worst].v)) worst = i; });
    if (worst < 0) { toast('Kupondaki tüm maçlar kilitli'); return; }
    c.ids[worst] = p.id;
  }
  c.locked.add(p.id);
  saveCoupon();
  toast('Kupona eklendi ve sabitlendi');
}

function saveToHistory() {
  const sys = couponSys();
  const picks = couponPicks();
  if (picks.length < minSizeOf(sys)) { toast('Kupon eksik'); return; }
  const r = evaluateSystem(picks, sys.sizes, sys.misli, sys.unit);
  const entry = {
    id: Date.now(), createdAt: Date.now(), day: gameDay(),
    sizes: r.sizes, misli: sys.misli, unit: sys.unit, stake: r.stake,
    pProfit: r.pProfit, evRatio: r.evRatio,
    picks: picks.map((p) => {
      const e = state.eventsById.get(p.eventId);
      return { id: p.id, eventId: p.eventId, key: p.key, line: p.line, no: p.no, name: p.name, names: p.names, label: p.label, odd: p.odd, p: p.p, d: p.d, hn: e?.hn, an: e?.an, result: null };
    }),
  };
  const dup = state.history.find((h) => h.day === entry.day && h.picks.map((p) => p.id).join() === entry.picks.map((p) => p.id).join());
  if (dup) { toast('Bu kupon zaten kayıtlı'); return; }
  state.history.push(entry);
  store.set('history', state.history);
  toast('Kupon geçmişe kaydedildi');
}

view.addEventListener('click', onAction);
$('#sheet-body').addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-set]');
  if (t) { onSettingsAction(t); return; }
  onAction(ev);
});
$('#sheet-body').addEventListener('change', (ev) => onSettingsInput(ev.target));

let searchTimer;
view.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.input === 'q') {
    state.matchFilter.q = t.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const pos = t.selectionStart;
      render();
      const inp = view.querySelector('[data-input="q"]');
      if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch { /* ignore */ } }
    }, 250);
  }
});
view.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.dataset.input === 'target') {
    const v = parseFloat(String(t.value).replace(',', '.'));
    if (Number.isFinite(v) && v >= 2) { state.settings.target = Math.min(200, v); saveSettings(); state.combos = null; render(); }
  }
});

function onAction(ev) {
  const t = ev.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  const s = state.settings;
  switch (act) {
    case 'settings': openSheet(settingsHtml()); break;
    case 'info': openSheet(infoHtml()); break;
    case 'reload': loadAll(true); break;
    case 'obj':
      s.objective = t.dataset.v; saveSettings();
      if (state.phase === 'ready') { state.tempExcluded.clear(); buildCoupon().then(render); }
      render();
      break;
    case 'regen':
      if (state.phase !== 'ready') break;
      state.tempExcluded.clear();
      buildCoupon().then(() => { render(); toast('Kupon yeniden hesaplandı'); });
      break;
    case 'another': {
      if (state.phase !== 'ready' || !state.coupon) break;
      const c = state.coupon;
      for (const p of couponPicks()) if (!c.locked.has(p.id)) state.tempExcluded.add(p.eventId);
      buildCoupon().then(async (ok) => {
        if (!ok || couponPicks().length < couponSys().n) {
          state.tempExcluded.clear();
          await buildCoupon();
          toast('Başka uygun kombinasyon kalmadı, en iyiye dönüldü');
        } else toast('Farklı maçlarla yeni öneri');
        render();
      });
      break;
    }
    case 'qgroup': {
      const g = QUICK_GROUPS[Number(t.dataset.i)];
      if (!g) break;
      s.groups = g[1].slice(); saveSettings();
      state.combos = null;
      if (state.phase === 'ready') {
        state.tempExcluded.clear();
        buildCoupon().then(() => { render(); toast(`${g[0]}: kupon yeniden kuruldu`); });
      }
      render();
      break;
    }
    case 'use-sys':
      useRanking(Number(t.dataset.i));
      render();
      toast('Sistem değiştirildi');
      break;
    case 'lock': {
      const p = slotPick(t.dataset.i);
      if (!p) break;
      const L = state.coupon.locked;
      if (L.has(p.id)) L.delete(p.id); else L.add(p.id);
      saveCoupon(); render();
      break;
    }
    case 'remove': {
      const p = slotPick(t.dataset.i);
      if (!p) break;
      state.coupon.excluded.add(p.eventId);
      state.coupon.locked.delete(p.id);
      const pool = slotPool(p);
      const alts = alternativesFor(pool, couponPicks(), Number(t.dataset.i), optOptions([]), 1);
      if (alts.length) replaceSlot(Number(t.dataset.i), alts[0].pick);
      else { state.coupon.ids.splice(Number(t.dataset.i), 1); saveCoupon(); }
      toast('Maç çıkarıldı');
      render();
      break;
    }
    case 'swap': {
      const i = Number(t.dataset.i);
      const pool = slotPool(slotPick(i));
      const alts = alternativesFor(pool, couponPicks(), i, optOptions([]), 10);
      const cur = slotPick(i);
      const curE = state.eventsById.get(cur.eventId);
      openSheet(`<h3>Yerine ne koyalım?</h3>
        <p class="note">Şu an: ${esc(curE?.hn)} – ${esc(curE?.an)} · <b>${esc(cur.label)}</b> (${fmtOdd(cur.odd)})</p>
        <h4>Aynı maçta diğer seçenekler</h4>
        ${(state.analyses.get(cur.eventId)?.picks || []).filter((p) => p.id !== cur.id && p.odd >= s.minOdd && p.odd <= s.maxOdd && (p.mbc ?? 1) <= minSizeOf(couponSys()) && s.groups.includes(p.group) && wantedPick(p)).sort((a, b) => b.v - a.v).slice(0, 5).map((p) => altRow(p, i)).join('') || '<p class="note">Yok</p>'}
        <h4>Başka maçlar (kupona en iyi uyanlar)</h4>
        ${alts.map((a) => altRow(a.pick, i)).join('') || '<p class="note">Uygun alternatif yok</p>'}`);
      break;
    }
    case 'alt': {
      const p = state.pickById.get(t.dataset.pick);
      if (p) { replaceSlot(Number(t.dataset.i), p); closeSheet(); render(); toast('Değiştirildi'); }
      break;
    }
    case 'match': openMatch(Number(t.dataset.id)); break;
    case 'add':
      addPickToCoupon(t.dataset.pick).then(() => {
        if (sheetOpen) { const id = state.pickById.get(t.dataset.pick)?.eventId; if (id) { const top = $('#sheet-body').scrollTop; $('#sheet-body').innerHTML = matchSheetHtml(id); $('#sheet-body').scrollTop = top; } }
        render();
      });
      break;
    case 'copy': copyText(couponText()); break;
    case 'save': saveToHistory(); break;
    case 'day': state.matchFilter.day = t.dataset.v; render(); break;
    case 'sort': state.matchFilter.sort = t.dataset.v; render(); break;
    case 'target':
      s.target = Math.max(2, Math.min(200, Math.round(s.target + Number(t.dataset.v))));
      saveSettings(); state.combos = null; render();
      break;
    case 'combo-copy': {
      const c = state.combos?.[Number(t.dataset.i)];
      if (!c) break;
      const lines = [`${li(c.k)} kombine · toplam oran ${fmtOdd(c.totalOdd)}`];
      c.picks.forEach((p, j) => { const e = state.eventsById.get(p.eventId); lines.push(`${j + 1}) ${fmtTime(p.d)} ${e?.hn} - ${e?.an} → ${p.label} (${fmtOdd(p.odd)})`); });
      copyText(lines.join('\n'));
      break;
    }
    case 'combo-use': {
      const c = state.combos?.[Number(t.dataset.i)];
      if (!c) break;
      // in auto mode the search adapts the system to the picks' MBS; in manual mode MBS must fit
      const minSize = s.sysMode === 'auto' ? 99 : minSizeOf(manualSys());
      const ok = c.picks.filter((p) => (p.mbc ?? 1) <= minSize);
      if (!state.coupon) state.coupon = { ids: [], locked: new Set(), excluded: new Set(), sys: null, ranking: null };
      state.coupon.locked = new Set(ok.map((p) => p.id));
      state.coupon.ids = ok.map((p) => p.id);
      ok.forEach((p) => state.coupon.excluded.delete(p.eventId));
      state.tempExcluded.clear();
      state.tab = 'kupon'; store.set('tab', 'kupon');
      buildCoupon().then(() => {
        render();
        const inCoupon = ok.filter((p) => state.coupon.ids.includes(p.id)).length;
        toast(inCoupon < c.picks.length ? 'Bazı maçlar MBS/bütçe nedeniyle eklenemedi' : 'Kombinasyon sisteme sabitlendi');
      });
      break;
    }
    case 'hist-check': checkResults(); break;
    case 'hist-res': {
      const c = state.history.find((h) => String(h.id) === t.dataset.h);
      const p = c?.picks[Number(t.dataset.p)];
      if (!p) break;
      p.result = p.result === null || p.result === undefined ? true : p.result === true ? false : null;
      store.set('history', state.history);
      render();
      break;
    }
    case 'hist-del':
      if (confirm('Bu kupon geçmişten silinsin mi?')) {
        state.history = state.history.filter((h) => String(h.id) !== t.dataset.h);
        store.set('history', state.history);
        render();
      }
      break;
    default: break;
  }
}

function altRow(p, slot) {
  const e = state.eventsById.get(p.eventId);
  return `<div class="mk-row">
    <div><div class="small muted">${fmtTime(p.d)} · ${esc(compOf(p.league).n)}</div>${e ? `${esc(e.hn)} – ${esc(e.an)}` : ''}<div><b>${esc(p.label)}</b> <span class="badge ${valueClass(p.v)}">${p.v.toFixed(2)}</span></div></div>
    <div class="p">${fmtPct(p.p)}</div><div class="o">${fmtOdd(p.odd)}</div>
    <button class="add" data-act="alt" data-pick="${esc(p.id)}" data-i="${slot}" aria-label="Bunu seç"><svg><use href="#i-swap"/></svg></button>
  </div>`;
}

// ---------- loading ----------
let loading = false;
async function loadAll(force = false) {
  if (loading) return;
  loading = true;
  const btn = $('#btn-refresh');
  btn.classList.add('spin');
  const first = state.phase !== 'ready';
  try {
    setStatus('Bülten indiriliyor…');
    setProgress(0.08);
    if (first) render();
    const [events, comps, names] = await Promise.all([
      api.fetchEvents(), api.fetchCompetitions().catch(() => ({})), api.fetchMarketNames().catch(() => ({})),
    ]);
    state.comps = comps;
    state.marketNames = names;
    const now = Date.now() / 1000;
    state.events = events.filter((e) => e.d > now - 60).sort((a, b) => a.d - b.d);
    state.eventsById = new Map(state.events.map((e) => [e.i, e]));
    state.detailed = new Set();
    state.updatedAt = Date.now();
    await loadDetails(state.events.filter((e) => eventEligible(e, now)));
    if (force) {
      // drop cached statistics older than this session only when user asks to refresh
      for (const [id, st] of state.stats) if (!st?.ok) state.stats.delete(id);
    }
    setProgress(0.2);
    await analyzeAll();
    await loadStatsForTop();
    state.combos = null;
    if (!state.coupon) {
      if (!restoreCoupon()) await buildCoupon();
    } else {
      // refresh: keep the user's coupon, refill slots whose markets closed
      const valid = couponPicks();
      if (valid.length < state.coupon.ids.length || valid.length < couponSys().n) await buildCoupon({ keepIds: true });
    }
    state.phase = 'ready';
    state.error = null;
    setStatus(statusLine());
    if (force) toast('Oranlar güncellendi');
  } catch (err) {
    console.error(err);
    if (state.phase !== 'ready') { state.phase = 'error'; }
    state.error = err?.message || String(err);
    setStatus('Bağlantı hatası');
    toast('Veriler alınamadı');
  } finally {
    setProgress(null);
    btn.classList.remove('spin');
    loading = false;
    render();
  }
}

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installPrompt = e; });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* ignore */ });
}

api.cleanCache();
render();
checkForUpdate();
loadAll();
// a phone can keep the app open for days: check again whenever it comes back to the screen
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
