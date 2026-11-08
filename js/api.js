// Data access for iddaa.com public APIs (CORS enabled, no key needed).

const SB = 'https://sportsbookv2.iddaa.com/sportsbook';
const ST = 'https://statisticsv2.iddaa.com/statistics';

async function getJson(url, timeoutMs = 20000) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(url, { signal: ctl?.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j && j.isSuccess === false) throw new Error(j.message || 'API hatası');
    return j ? j.data : null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------- small localStorage cache ----------
const PREFIX = 'sk1:';
function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > maxAgeMs) return null;
    return v;
  } catch { return null; }
}
function cacheSet(key, v) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ t: Date.now(), v })); } catch { /* full or blocked */ }
}
export function cleanCache(maxAgeMs = 2 * 864e5) {
  try {
    const now = Date.now();
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      try {
        const { t } = JSON.parse(localStorage.getItem(k));
        if (now - t > maxAgeMs) localStorage.removeItem(k);
      } catch { localStorage.removeItem(k); }
    }
  } catch { /* ignore */ }
}

// ---------- bulletin ----------
export async function fetchEvents() {
  const data = await getJson(`${SB}/events?st=1&type=0&version=0`);
  return (data?.events || []).filter((e) => e.sid === 1);
}

export async function fetchCompetitions() {
  const cached = cacheGet('comps', 12 * 3600e3);
  if (cached) return cached;
  const data = await getJson(`${SB}/competitions`);
  const out = {};
  for (const c of data || []) {
    if (String(c.si) !== '1') continue;
    out[c.i] = { n: c.n, sn: c.sn, cc: c.cid, ic: c.ic };
  }
  cacheSet('comps', out);
  return out;
}

// ---------- statistics ----------
function summarizeRecent(d, side) {
  if (!d || !Array.isArray(d.m)) return null;
  const team = side === 'h' ? d.h?.n : d.a?.n;
  const list = [];
  let gf = 0, ga = 0, w = 0, dr = 0, l = 0, over25 = 0, btts = 0, games = 0;
  for (const m of d.m.slice(0, 10)) {
    const hs = Number(m.h?.rs), as = Number(m.a?.rs);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
    let mine = null;
    if (m.h?.n === team) mine = 'h'; else if (m.a?.n === team) mine = 'a';
    let f, g;
    if (mine) { f = mine === 'h' ? hs : as; g = mine === 'h' ? as : hs; }
    else if (m.mr === 'G') { f = Math.max(hs, as); g = Math.min(hs, as); }
    else if (m.mr === 'M') { f = Math.min(hs, as); g = Math.max(hs, as); }
    else { f = hs; g = as; }
    games++; gf += f; ga += g;
    if (f > g) w++; else if (f === g) dr++; else l++;
    if (hs + as > 2.5) over25++;
    if (hs > 0 && as > 0) btts++;
    list.push({ t: m.t, hn: m.h?.n, an: m.a?.n, hs, as, hs1: m.h?.fhs, as1: m.a?.fhs, r: f > g ? 'G' : f === g ? 'B' : 'M', lg: m.l?.a || m.l?.n });
  }
  if (!games) return null;
  return { team, games, gf, ga, w, d: dr, l, over25, btts, list };
}

function trimStandings(d) {
  if (!d || !Array.isArray(d.g)) return null;
  const rows = [];
  for (const g of d.g) for (const t of g.t || []) {
    rows.push({ si: String(t.si), r: t.r, n: t.n, p: t.p, w: t.w, d: t.d, l: t.l, gf: t.gf, ga: t.ga, pt: t.pt, f5: t.lfive || [] });
  }
  if (!rows.length) return null;
  return { homeId: String(d.shi), awayId: String(d.sai), season: d.ss?.n || '', rows };
}

export async function fetchStats(eventId) {
  const key = `st:${eventId}`;
  const cached = cacheGet(key, 4 * 3600e3);
  if (cached) return cached;
  const safe = (p) => p.catch(() => null);
  const [st, r0, r1, h2h, bi] = await Promise.all([
    safe(getJson(`${ST}/soccer/standings/${eventId}?standingType=1&isLive=false`)),
    safe(getJson(`${ST}/soccer/recent-matches/${eventId}?matchHistoryType=0&isOnlyCurrentTournament=false`)),
    safe(getJson(`${ST}/soccer/recent-matches/${eventId}?matchHistoryType=1&isOnlyCurrentTournament=false`)),
    safe(getJson(`${ST}/soccer/recent-matches/${eventId}?matchHistoryType=2&isOnlyCurrentTournament=false`)),
    safe(getJson(`${ST}/soccer/bet-insights/${eventId}`)),
  ]);
  const out = {
    standings: trimStandings(st),
    recentHome: summarizeRecent(r0, 'h'),
    recentAway: summarizeRecent(r1, 'a'),
    h2h: (h2h?.m || []).slice(0, 6).map((m) => ({ t: m.t, hn: m.h?.n, an: m.a?.n, hs: m.h?.rs, as: m.a?.rs })),
    insights: (bi?.bi || []).map((b) => b.f).filter(Boolean).slice(0, 8),
  };
  out.ok = !!(out.standings || out.recentHome || out.recentAway);
  if (out.ok) cacheSet(key, out);
  return out;
}

// Run async jobs with limited concurrency.
export async function pool(items, limit, fn, onProgress) {
  let i = 0, done = 0;
  const results = new Array(items.length);
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); } catch { results[idx] = null; }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------- results (for history) ----------
// Looks the finished match up in the home team's recent matches.
export async function fetchResult(eventId, kickoff, homeName) {
  const tryType = async (type) => {
    const d = await getJson(`${ST}/soccer/recent-matches/${eventId}?matchHistoryType=${type}&isOnlyCurrentTournament=false`);
    for (const m of d?.m || []) {
      if (Math.abs(Number(m.t) - kickoff) > 3 * 3600) continue;
      const hs = Number(m.h?.rs), as = Number(m.a?.rs);
      if (!Number.isFinite(hs) || !Number.isFinite(as)) continue;
      const swapped = homeName && m.a?.n === homeName && m.h?.n !== homeName;
      const h1 = m.h?.fhs, a1 = m.a?.fhs;
      return swapped
        ? { h: as, a: hs, h1: a1 ?? null, a1: h1 ?? null }
        : { h: hs, a: as, h1: h1 ?? null, a1: a1 ?? null };
    }
    return null;
  };
  return (await tryType(0)) || (await tryType(2)) || null;
}

export function iddaaMatchUrl(eventId) {
  return `https://www.iddaa.com/program/futbol/mac-detay/1/${eventId}/tum-oranlar`;
}
