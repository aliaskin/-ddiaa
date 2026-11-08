// Market definitions for iddaa football bulletin.
// Each market key is "<t>_<st>" as used by the iddaa API.
// Every outcome is described by a predicate on a final score
// s = { h, a, h1, a1 } (full-time and first-half goals).

const RES = ['1', '0', '2'];
const res = (x, y) => (x > y ? '1' : x === y ? '0' : '2');

export const GROUPS = {
  MS: 'Maç Sonucu',
  CS: 'Çifte Şans',
  AU: 'Alt/Üst',
  KG: 'Karşılıklı Gol',
  HND: 'Handikap',
  TAU: 'Takım Alt/Üst',
  IY: 'İlk Yarı',
  KOMBO: 'Kombine (MS+AÜ/KG)',
  TG: 'Toplam Gol',
  IYMS: 'İY/MS',
};

export const MARKETS = {
  '1_1': {
    group: 'MS', name: 'Maç Sonucu', short: 'MS', fit: 3, scope: 'ft',
    pred: (no) => (s) => res(s.h, s.a) === RES[no - 1],
    label: (no) => `MS ${RES[no - 1]}`,
  },
  '2_92': {
    group: 'CS', name: 'Çifte Şans', short: 'ÇŞ', fit: 1, scope: 'ft', sum: 2,
    pred: (no) => (s) => (no === 1 ? s.h >= s.a : no === 2 ? s.h !== s.a : s.h <= s.a),
    label: (no) => `ÇŞ ${['1-X', '1-2', 'X-2'][no - 1]}`,
  },
  '2_101': {
    group: 'AU', name: 'Alt/Üst', short: 'AÜ', fit: 2, scope: 'ft', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.h + s.a < L : s.h + s.a > L),
    label: (no, L) => `${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_89': {
    group: 'KG', name: 'Karşılıklı Gol', short: 'KG', fit: 1.5, scope: 'ft',
    pred: (no) => (s) => ((s.h > 0 && s.a > 0) === (no === 1)),
    label: (no) => `KG ${no === 1 ? 'Var' : 'Yok'}`,
  },
  '2_100': {
    group: 'HND', name: 'Handikaplı Maç Sonucu', short: 'HND', fit: 1, scope: 'ft', line: true,
    // sov is the handicap applied to the home team (e.g. "-1": home starts one goal down).
    pred: (no, H) => (s) => res(s.h + H, s.a) === RES[no - 1],
    label: (no, H) => `HND (${H > 0 ? '+' + H : H}) ${RES[no - 1]}`,
  },
  '2_603': {
    group: 'TAU', name: 'Ev Sahibi Alt/Üst', short: 'Ev AÜ', fit: 1, scope: 'ft', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.h < L : s.h > L),
    label: (no, L) => `Ev ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_604': {
    group: 'TAU', name: 'Deplasman Alt/Üst', short: 'Dep AÜ', fit: 1, scope: 'ft', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.a < L : s.a > L),
    label: (no, L) => `Dep ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_7': {
    group: 'KOMBO', name: 'MS ve Alt/Üst', short: 'MS+AÜ', fit: 0.5, scope: 'ft', line: true,
    pred: (no, L) => (s) => res(s.h, s.a) === RES[(no - 1) % 3] && ((no <= 3) === (s.h + s.a < L)),
    label: (no, L) => `MS ${RES[(no - 1) % 3]} & ${L} ${no <= 3 ? 'Alt' : 'Üst'}`,
  },
  '2_698': {
    group: 'KOMBO', name: 'MS ve Karşılıklı Gol', short: 'MS+KG', fit: 0.5, scope: 'ft',
    pred: (no) => (s) => res(s.h, s.a) === RES[Math.floor((no - 1) / 2)] && ((s.h > 0 && s.a > 0) === (no % 2 === 1)),
    label: (no) => `MS ${RES[Math.floor((no - 1) / 2)]} & KG ${no % 2 === 1 ? 'Var' : 'Yok'}`,
  },
  '2_700': {
    group: 'KOMBO', name: 'Alt/Üst ve KG', short: 'AÜ+KG', fit: 0.5, scope: 'ft', line: true,
    pred: (no, L) => (s) => ((s.h + s.a > L) === (no === 2 || no === 4)) && ((s.h > 0 && s.a > 0) === (no <= 2)),
    label: (no, L) => `${L} ${no === 2 || no === 4 ? 'Üst' : 'Alt'} & KG ${no <= 2 ? 'Var' : 'Yok'}`,
  },
  '2_4': {
    group: 'TG', name: 'Toplam Gol', short: 'TG', fit: 0.5, scope: 'ft',
    pred: (no) => (s) => {
      const t = s.h + s.a;
      return no === 1 ? t <= 1 : no === 2 ? t === 2 || t === 3 : no === 3 ? t === 4 || t === 5 : t >= 6;
    },
    label: (no) => `TG ${['0-1', '2-3', '4-5', '6+'][no - 1]}`,
  },
  '2_60': {
    group: 'IY', name: '1. Yarı Alt/Üst', short: 'İY AÜ', fit: 1, scope: 'ht', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.h1 + s.a1 < L : s.h1 + s.a1 > L),
    label: (no, L) => `İY ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_88': {
    group: 'IY', name: '1. Yarı Sonucu', short: 'İY', fit: 1, scope: 'ht',
    pred: (no) => (s) => res(s.h1, s.a1) === RES[no - 1],
    label: (no) => `İY ${RES[no - 1]}`,
  },
  '2_90': {
    group: 'IYMS', name: 'İY / MS', short: 'İY/MS', fit: 0.5, scope: 'both',
    pred: (no) => (s) => res(s.h1, s.a1) === RES[Math.floor((no - 1) / 3)] && res(s.h, s.a) === RES[(no - 1) % 3],
    label: (no) => `İY/MS ${RES[Math.floor((no - 1) / 3)]}/${RES[(no - 1) % 3]}`,
  },
};

export function marketKey(m) {
  return `${m.t}_${m.st}`;
}

function parseLine(sov) {
  if (sov === undefined || sov === null || sov === '') return null;
  const v = parseFloat(String(sov).replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// Turn raw iddaa markets of an event into normalized market objects we understand.
// oddField: 'odd' (bayi) or 'wodd' (internet).
export function normalizeMarkets(event, oddField = 'odd') {
  const out = [];
  for (const m of event.m || []) {
    const key = marketKey(m);
    const def = MARKETS[key];
    if (!def) continue;
    if (m.s !== 1) continue; // market not open
    const line = def.line ? parseLine(m.sov) : null;
    if (def.line && line === null) continue;
    const outcomes = [];
    let complete = true;
    for (const o of m.o || []) {
      const odd = Number(o[oddField] ?? o.odd);
      if (!(odd > 1.0)) { complete = false; continue; }
      outcomes.push({ no: o.no, odd, name: o.n });
    }
    if (outcomes.length < 2) continue;
    out.push({
      id: m.i, key, def, line, mbc: m.mbc ?? event.mbc ?? 1,
      outcomes, complete: complete && outcomes.length === (m.o || []).length,
    });
  }
  return out;
}

export function pickId(eventId, key, line, no) {
  return `${eventId}:${key}:${line ?? ''}:${no}`;
}

export function pickPredicate(key, line, no) {
  const def = MARKETS[key];
  if (!def) return null;
  return def.pred(no, line);
}

export function pickLabel(key, line, no) {
  const def = MARKETS[key];
  return def ? def.label(no, line) : key;
}

// Settle a pick against a final score. Returns true / false.
export function settlePick(pick, score) {
  const p = pickPredicate(pick.key, pick.line, pick.no);
  if (!p) return null;
  const s = { h: score.h, a: score.a, h1: score.h1 ?? 0, a1: score.a1 ?? 0 };
  if (MARKETS[pick.key].scope !== 'ft' && (score.h1 === undefined || score.h1 === null)) return null;
  return p(s);
}
