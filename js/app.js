import { analyzeEvent } from './model.js';
import { filterPicks, buildPool, optimizeSystem, alternativesFor, findTargetCombos, OBJECTIVES, hashString } from './optimizer.js';
import { evaluateSystem, columnCount, payoutFor } from './system.js';
import { GROUPS, settlePick } from './markets.js';
import * as api from './api.js';

// ---------- settings & storage ----------
const DEFAULTS = {
  n: 6,
  sizes: [3, 4, 5, 6],
  misli: 2,
  unit: 1,
  objective: 'kar',
  oddField: 'wodd',
  minOdd: 1.3,
  maxOdd: 3.0,
  groups: ['MS', 'CS', 'AU', 'KG', 'HND', 'TAU'],
  window: 'today',
  statsWeight: 0.2,
  maxPerLeague: 2,
  noYouth: true,
  statsTop: 30,
  target: 10,
};

const store = {
  get(k, d) { try { const v = localStorage.getItem('sk:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sk:' + k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

const state = {
  settings: { ...DEFAULTS, ...store.get('settings', {}) },
  tab: store.get('tab', 'kupon'),
  phase: 'loading', // loading | ready | error
  error: null,
  events: [],
  eventsById: new Map(),
  comps: {},
  analyses: new Map(),
  pickById: new Map(),
  stats: new Map(),
  updatedAt: null,
  coupon: null, // { ids: [], locked: Set, excluded: Set }
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
function valueClass(v) { return v >= 0.89 ? 'good' : v >= 0.83 ? '' : 'bad'; }

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
  const a = analyzeEvent(e, { oddField: state.settings.oddField, statsWeight: state.settings.statsWeight, stats: st && st.ok ? st : null });
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

function eligiblePicks({ maxMbc, ignoreExcluded = false } = {}) {
  const s = state.settings;
  const now = Date.now() / 1000;
  const all = [];
  for (const a of state.analyses.values()) {
    const e = state.eventsById.get(a.eventId);
    if (!e || !eventEligible(e, now)) continue;
    all.push(...a.picks);
  }
  const excluded = new Set(ignoreExcluded ? [] : [...(state.coupon?.excluded || []), ...state.tempExcluded]);
  return filterPicks(all, {
    minOdd: s.minOdd, maxOdd: s.maxOdd, groups: new Set(s.groups),
    maxMbc: maxMbc ?? Math.min(...s.sizes), excluded,
  });
}

function optOptions(locked) {
  const s = state.settings;
  return {
    n: s.n, sizes: s.sizes, misli: s.misli, unit: s.unit, objective: s.objective,
    locked, maxPerLeague: s.maxPerLeague,
    seed: hashString(`${gameDay()}|${s.objective}|${s.n}|${s.sizes.join(',')}`),
  };
}

async function loadStatsForTop() {
  const s = state.settings;
  if (!(s.statsWeight > 0)) return;
  const pool = buildPool(eligiblePicks(), 4, 160);
  const ids = [];
  for (const p of pool) if (!ids.includes(p.eventId)) ids.push(p.eventId);
  const want = ids.slice(0, s.statsTop);
  for (const id of state.coupon?.ids || []) {
    const ev = Number(String(id).split(':')[0]);
    if (!want.includes(ev)) want.push(ev);
  }
  const missing = want.filter((id) => !state.stats.has(id) && state.eventsById.has(id));
  if (missing.length) {
    await api.pool(missing, 6, async (id) => {
      const st = await api.fetchStats(id);
      state.stats.set(id, st);
    }, (d, n) => { setStatus(`İstatistikler yükleniyor ${d}/${n}`); setProgress(0.6 + 0.35 * (d / n)); });
  }
  for (const id of want) {
    const e = state.eventsById.get(id);
    if (e) analyzeOne(e);
  }
  rebuildPickIndex();
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
  });
}

function generateCoupon({ keepIds = false } = {}) {
  const s = state.settings;
  const prev = state.coupon || { ids: [], locked: new Set(), excluded: new Set() };
  const minSize = Math.min(...s.sizes);
  let lockedPicks = prev.ids.filter((id) => prev.locked.has(id) || keepIds).map((id) => state.pickById.get(id)).filter(Boolean)
    .filter((p) => (p.mbc ?? 1) <= minSize);
  const now = Date.now() / 1000;
  lockedPicks = lockedPicks.filter((p) => p.d > now + 120).slice(0, s.n);
  const pool = buildPool(eligiblePicks(), 4, 160);
  const r = optimizeSystem(pool, optOptions(lockedPicks));
  if (!r) {
    state.coupon = { ids: lockedPicks.map((p) => p.id), locked: prev.locked, excluded: prev.excluded };
    saveCoupon();
    return false;
  }
  state.coupon = {
    ids: r.picks.map((p) => p.id),
    locked: new Set([...prev.locked].filter((id) => r.picks.some((p) => p.id === id))),
    excluded: prev.excluded,
  };
  saveCoupon();
  return true;
}

function restoreCoupon() {
  const saved = store.get('coupon', null);
  if (!saved || saved.day !== gameDay()) return false;
  state.coupon = { ids: saved.ids || [], locked: new Set(saved.locked || []), excluded: new Set(saved.excluded || []) };
  const valid = couponPicks();
  if (valid.length === state.settings.n && valid.length === state.coupon.ids.length) return true;
  // some picks are gone (market closed / match started): keep the rest and refill
  generateCoupon({ keepIds: true });
  return true;
}

function couponText() {
  const s = state.settings;
  const picks = couponPicks();
  const r = evaluateSystem(picks, s.sizes, s.misli, s.unit);
  const lines = [`Sistem ${sizesLabel(r.sizes)} · ${picks.length} maç · ${s.misli} misli · ${fmtTL(r.stake)} (${r.columns} kolon)`];
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
      <span class="badge ${valueClass(p.v)}" title="Değer = oran × olasılık">değer ${p.v.toFixed(2)}</span>
      <span class="odd">${fmtOdd(p.odd)}</span>
      <span class="prob">${fmtPct(p.p)}<br><span class="faint">olasılık</span></span>
    </div>
  </article>`;
}

function renderSummary(picks) {
  const s = state.settings;
  const r = evaluateSystem(picks, s.sizes, s.misli, s.unit);
  const minK = Math.min(...r.sizes);
  const rows = r.byHits.filter((b) => b.k >= minK).map((b) => {
    const pay = b.minPay === b.maxPay ? fmtTL(b.minPay) : `${fmtTL(b.minPay)} – ${fmtTL(b.maxPay)}`;
    return `<tr class="${b.minPay > r.stake ? 'hl' : ''}"><td>${b.k} tutarsa</td><td class="r">${fmtPct(b.prob, 1)}</td><td class="r">${pay}</td></tr>`;
  }).join('');
  const lose = r.byHits.filter((b) => b.k < minK).reduce((x, b) => x + b.prob, 0);
  const totalOdd = picks.reduce((x, p) => x * p.odd, 1);
  return `
  <div class="card mt12">
    <div class="kpis k2">
      <div class="kpi"><div class="k">Kâra geçme olasılığı</div><div class="v ${r.pProfit >= 0.2 ? 'good' : 'warn'}">${fmtPct(r.pProfit, 1)}</div></div>
      <div class="kpi"><div class="k">En az %25 kâr</div><div class="v">${fmtPct(r.pGood, 1)}</div></div>
      <div class="kpi"><div class="k">Para dönme (${minK}+ tutma)</div><div class="v">${fmtPct(r.pReturn, 0)}</div></div>
      <div class="kpi"><div class="k">Maks. kazanç</div><div class="v">${fmtTL(r.maxPay)}</div></div>
    </div>
    <table class="tbl mt12">
      <thead><tr><th>Sonuç</th><th class="r">Olasılık</th><th class="r">Kazanç</th></tr></thead>
      <tbody>
        <tr><td>${den(minK)} az</td><td class="r">${fmtPct(lose, 1)}</td><td class="r">0 TL</td></tr>
        ${rows}
      </tbody>
    </table>
    <div class="note box mt12">
      ${r.columns} kolon × ${s.misli} misli × ${fmtTL(s.unit)} = <b>${fmtTL(r.stake)}</b> · Toplam oran (hepsi): ${fmtOdd(totalOdd)}<br>
      Ortalama beklenen dönüş: <b>${fmtTL(r.ev)}</b> (yatırılana oranı ${fmtPct(r.evRatio)}). iddaa'nın kâr payı yüzünden bu oran uzun vadede %100'ün altında kalır.
    </div>
  </div>`;
}

function renderKupon() {
  const s = state.settings;
  const cols = columnCount(s.n, s.sizes.filter((k) => k <= s.n));
  const stake = cols * s.misli * s.unit;
  const head = `
  <div class="card hero">
    <div>
      <div class="cfg">${s.n} maç · Sistem ${sizesLabel(s.sizes)} · ${s.misli} misli · ${cols} kolon</div>
      <div class="cost">${fmtTL(stake).replace(' TL', '')}<small>TL</small></div>
    </div>
    <button class="btn sm" data-act="settings"><svg><use href="#i-gear"/></svg>Ayarla</button>
  </div>
  <div class="seg mt12" role="tablist">
    ${Object.entries(OBJECTIVES).map(([k, o]) => `<button data-act="obj" data-v="${k}" class="${s.objective === k ? 'on' : ''}">${esc(o.name.replace(' (önerilen)', ''))}</button>`).join('')}
  </div>
  <p class="note mt8">${esc(OBJECTIVES[s.objective].desc)}</p>`;

  if (state.phase === 'loading') return head + '<div class="mt12"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  if (state.phase === 'error') return head + errorBox();

  const picks = couponPicks();
  const locked = state.coupon?.locked || new Set();
  let body = '';
  if (picks.length < s.n) {
    body = `<div class="warnbox mt12">Ayarlarına uyan yeterli maç bulunamadı (${picks.length}/${s.n}). Oran aralığını, pazarları ya da zaman aralığını genişletmeyi dene.</div>`;
  }
  body += `<div class="section-title"><h2>Günün kuponu</h2><small>${dayLabel(Date.now() / 1000)} · ${state.updatedAt ? 'oranlar ' + fmtTime(state.updatedAt / 1000) : ''}</small></div>`;
  if (picks.length) {
    const first = Math.min(...picks.map((p) => p.d));
    const mins = Math.round((first - Date.now() / 1000) / 60);
    const cls = mins < 30 ? 'warnbox' : 'note box';
    body += `<div class="${cls}" style="margin-bottom:8px">İlk maç ${fmtTime(first)}${mins < 120 ? ` (${mins} dk sonra)` : ''} — kuponu bu saatten önce oynamalısın.</div>`;
  }
  body += picks.map((p, i) => renderPick(p, i, locked.has(p.id))).join('');
  if (picks.length >= Math.min(...s.sizes)) body += renderSummary(picks);
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
function bestPickFor(a) {
  const s = state.settings;
  const groups = new Set(s.groups);
  let best = null;
  for (const p of a.picks) {
    if (!groups.has(p.group) || p.odd < s.minOdd || p.odd > s.maxOdd) continue;
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
  if (st.h2h?.length) {
    html += '<h4>Aralarındaki son maçlar</h4><table class="tbl">' + st.h2h.map((m) => `<tr><td class="muted small">${new Date(m.t * 1000).toLocaleDateString('tr-TR')}</td><td>${esc(m.hn)}</td><td class="r"><b>${m.hs}–${m.as}</b></td><td class="r">${esc(m.an)}</td></tr>`).join('') + '</table>';
  }
  if (st.insights?.length) {
    html += '<h4>iddaa istatistik notları</h4>' + st.insights.map((t) => `<div class="insight">${esc(t)}</div>`).join('');
  }
  return html;
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
    <p class="note mt8">Oranlardan hesaplandı (ort. kâr payı ${fmtPct(a.margin, 0)}).${a.stats ? ` İstatistik modeli: ${a.stats.lh.toFixed(2)} – ${a.stats.la.toFixed(2)} gol, ağırlık ${fmtPct(a.statsWeight)}.` : ''}</p>`;
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
  if (!state.stats.has(eventId)) {
    try {
      const st = await api.fetchStats(eventId);
      state.stats.set(eventId, st);
    } catch { state.stats.set(eventId, { ok: false }); }
    const e = state.eventsById.get(eventId);
    if (e) { analyzeOne(e); rebuildPickIndex(); }
    if (sheetOpen) {
      const top = $('#sheet-body').scrollTop;
      $('#sheet-body').innerHTML = matchSheetHtml(eventId);
      $('#sheet-body').scrollTop = top;
    }
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
    for (const p of a.picks) if (groups.has(p.group) && (p.mbc ?? 1) <= 4 && p.odd >= 1.15 && p.p >= 0.08) wide.push(p);
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
  return `
  <h3>Ayarlar</h3>
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
  </div>
  <div class="two">
    <div class="field"><label for="f-min">En düşük oran</label><input id="f-min" class="inp" type="number" inputmode="decimal" step="0.05" min="1.01" value="${s.minOdd}" data-setin="minOdd"></div>
    <div class="field"><label for="f-max">En yüksek oran</label><input id="f-max" class="inp" type="number" inputmode="decimal" step="0.05" min="1.05" value="${s.maxOdd}" data-setin="maxOdd"></div>
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
    <div class="seg">${[['wodd', 'İnternet (iddaa.com)'], ['odd', 'Bayi']].map(([k, l]) => `<button class="${s.oddField === k ? 'on' : ''}" data-set="oddField" data-v="${k}">${l}</button>`).join('')}</div>
    <div class="hint">iddaa'da internetten oynanan kuponların oranı bayiden biraz düşüktür.</div>
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
    <label class="switch"><span>Kadın, genç (U21 vb.) ve amatör maçlarını alma</span><input type="checkbox" ${s.noYouth ? 'checked' : ''} data-setcb="noYouth"></label>
  </div>
  <div class="btn-row mt16">
    <button class="btn" data-set="reset">Varsayılanlar</button>
    <button class="btn primary" data-set="close">Uygula</button>
  </div>
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
  if (k === 'n') {
    s.n = Math.max(3, Math.min(8, s.n + Number(t.dataset.d)));
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
  if (d.reanalyze || d.regen) { state.tempExcluded.clear(); generateCoupon(); }
  setStatus(statusLine());
  render();
}

function infoHtml() {
  return `
  <h3>Nasıl çalışır?</h3>
  <p class="note">1. <b>Veri:</b> Bülten ve oranlar iddaa.com'dan canlı çekilir. İstatistikler (puan durumu, son 10 maç, aralarındaki maçlar, iddaa istatistik notları) iddaa istatistik servisinden gelir.</p>
  <p class="note">2. <b>Olasılık:</b> Her pazarın oranından iddaa'nın kâr payı çıkarılır. Sonra tüm pazarlara (MS, Alt/Üst, KG, handikap, takım golleri, ilk yarı…) aynı anda uyan bir gol modeli (Dixon-Coles düzeltmeli Poisson) kurulur. Böylece her seçenek için tutarlı bir olasılık elde edilir; açık olan istatistik ağırlığı kadar da takım istatistiklerinden kurulan model karıştırılır.</p>
  <p class="note">3. <b>Değer:</b> oran × olasılık. 1.00 adil oran demektir. iddaa'nın kâr payı %15-25 olduğundan çoğu seçenek 0.80-0.92 arasındadır; uygulama en yüksek değerlileri öne alır.</p>
  <p class="note">4. <b>Sistem:</b> Seçtiğin sistemdeki her kolon (örn. 6 maçta 3-4-5-6 = 20+15+6+1 = 42 kolon) ayrı hesaplanır. 2⁶ = 64 olası sonuç tek tek değerlendirilip kazanç, kâra geçme olasılığı ve beklenen dönüş bulunur.</p>
  <p class="note">5. <b>Optimizasyon:</b> Her maçtan tek seçim olacak, MBS kuralına uyacak ve aynı ligden fazla maç olmayacak şekilde, seçtiğin hedefe (kâr şansı / beklenen getiri / büyük vurgun) göre en iyi kombinasyon aranır.</p>
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
  return state.updatedAt ? `${n} maç · güncellendi ${fmtTime(state.updatedAt / 1000)}` : `${n} maç`;
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

function replaceSlot(i, newPick) {
  const ids = state.coupon.ids.slice();
  const old = ids[i];
  ids[i] = newPick.id;
  state.coupon.ids = ids;
  state.coupon.locked.delete(old);
  saveCoupon();
}

function addPickToCoupon(pickId) {
  const p = state.pickById.get(pickId);
  if (!p) return;
  const s = state.settings;
  const minSize = Math.min(...s.sizes);
  if ((p.mbc ?? 1) > minSize) { toast(`Bu seçimin MBS'si ${p.mbc}; ${minSize}'li kolonlarda oynanamaz`); return; }
  if (!state.coupon) state.coupon = { ids: [], locked: new Set(), excluded: new Set() };
  const c = state.coupon;
  c.excluded.delete(p.eventId);
  const sameEvent = c.ids.findIndex((id) => Number(String(id).split(':')[0]) === p.eventId);
  if (sameEvent >= 0) {
    c.locked.delete(c.ids[sameEvent]);
    c.ids[sameEvent] = p.id;
  } else if (c.ids.length < s.n) {
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
  const s = state.settings;
  const picks = couponPicks();
  if (picks.length < Math.min(...s.sizes)) { toast('Kupon eksik'); return; }
  const r = evaluateSystem(picks, s.sizes, s.misli, s.unit);
  const entry = {
    id: Date.now(), createdAt: Date.now(), day: gameDay(),
    sizes: r.sizes, misli: s.misli, unit: s.unit, stake: r.stake,
    pProfit: r.pProfit, evRatio: r.evRatio,
    picks: picks.map((p) => {
      const e = state.eventsById.get(p.eventId);
      return { id: p.id, eventId: p.eventId, key: p.key, line: p.line, no: p.no, label: p.label, odd: p.odd, p: p.p, d: p.d, hn: e?.hn, an: e?.an, result: null };
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
      if (state.phase === 'ready') { state.tempExcluded.clear(); generateCoupon(); }
      render();
      break;
    case 'regen':
      state.tempExcluded.clear();
      generateCoupon();
      render();
      toast('Kupon yeniden hesaplandı');
      break;
    case 'another': {
      const c = state.coupon;
      for (const p of couponPicks()) if (!c.locked.has(p.id)) state.tempExcluded.add(p.eventId);
      let ok = generateCoupon();
      if (!ok || couponPicks().length < s.n) { state.tempExcluded.clear(); ok = generateCoupon(); toast('Başka uygun kombinasyon kalmadı, en iyiye dönüldü'); }
      else toast('Farklı maçlarla yeni öneri');
      render();
      break;
    }
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
      const pool = buildPool(eligiblePicks(), 4, 160);
      const alts = alternativesFor(pool, couponPicks(), Number(t.dataset.i), optOptions([]), 1);
      if (alts.length) replaceSlot(Number(t.dataset.i), alts[0].pick);
      else { state.coupon.ids.splice(Number(t.dataset.i), 1); saveCoupon(); }
      toast('Maç çıkarıldı');
      render();
      break;
    }
    case 'swap': {
      const i = Number(t.dataset.i);
      const pool = buildPool(eligiblePicks(), 4, 160);
      const alts = alternativesFor(pool, couponPicks(), i, optOptions([]), 10);
      const cur = slotPick(i);
      const curE = state.eventsById.get(cur.eventId);
      openSheet(`<h3>Yerine ne koyalım?</h3>
        <p class="note">Şu an: ${esc(curE?.hn)} – ${esc(curE?.an)} · <b>${esc(cur.label)}</b> (${fmtOdd(cur.odd)})</p>
        <h4>Aynı maçta diğer seçenekler</h4>
        ${(state.analyses.get(cur.eventId)?.picks || []).filter((p) => p.id !== cur.id && p.odd >= s.minOdd && p.odd <= s.maxOdd && (p.mbc ?? 1) <= Math.min(...s.sizes) && s.groups.includes(p.group)).sort((a, b) => b.v - a.v).slice(0, 5).map((p) => altRow(p, i)).join('') || '<p class="note">Yok</p>'}
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
      addPickToCoupon(t.dataset.pick);
      if (sheetOpen) { const id = state.pickById.get(t.dataset.pick)?.eventId; if (id) { const top = $('#sheet-body').scrollTop; $('#sheet-body').innerHTML = matchSheetHtml(id); $('#sheet-body').scrollTop = top; } }
      render();
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
      const minSize = Math.min(...s.sizes);
      const ok = c.picks.filter((p) => (p.mbc ?? 1) <= minSize);
      if (!state.coupon) state.coupon = { ids: [], locked: new Set(), excluded: new Set() };
      state.coupon.locked = new Set(ok.map((p) => p.id));
      state.coupon.ids = ok.map((p) => p.id);
      ok.forEach((p) => state.coupon.excluded.delete(p.eventId));
      state.tempExcluded.clear();
      generateCoupon();
      state.tab = 'kupon'; store.set('tab', 'kupon');
      render();
      toast(ok.length < c.picks.length ? 'MBS nedeniyle bazı maçlar eklenemedi' : 'Kombinasyon sisteme sabitlendi');
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
    const [events, comps] = await Promise.all([api.fetchEvents(), api.fetchCompetitions().catch(() => ({}))]);
    state.comps = comps;
    const now = Date.now() / 1000;
    state.events = events.filter((e) => e.d > now - 60).sort((a, b) => a.d - b.d);
    state.eventsById = new Map(state.events.map((e) => [e.i, e]));
    state.updatedAt = Date.now();
    if (force) {
      // drop cached statistics older than this session only when user asks to refresh
      for (const [id, st] of state.stats) if (!st?.ok) state.stats.delete(id);
    }
    setProgress(0.2);
    await analyzeAll();
    await loadStatsForTop();
    state.combos = null;
    if (!state.coupon) {
      if (!restoreCoupon()) generateCoupon();
    } else {
      // refresh: keep the user's coupon, refill slots whose markets closed
      const valid = couponPicks();
      if (valid.length < state.coupon.ids.length || valid.length < state.settings.n) generateCoupon({ keepIds: true });
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
loadAll();
