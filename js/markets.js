// Market definitions for the iddaa football bulletin.
// Each market key is "<t>_<st>" as used by the iddaa API.
// Goal-based outcomes are described by a predicate on a final score
// s = { h, a, h1, a1 } (full-time and first-half goals), so the score model can price them.
// Other markets (corners, cards, ...) are priced from their own odds ("generic").

const RES = ['1', '0', '2'];
const res = (x, y) => (x > y ? '1' : x === y ? '0' : '2');
const yes = (no) => no === 1; // "Evet"/"Var" is outcome 1 in these markets
const parseScore = (name) => {
  const m = /^(\d+)\s*[:-]\s*(\d+)$/.exec(String(name || '').trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
};

export const GROUPS = {
  MS: 'Maç Sonucu',
  CS: 'Çifte Şans',
  AU: 'Alt/Üst',
  KG: 'Karşılıklı Gol',
  HND: 'Handikap',
  TAU: 'Takım Alt/Üst',
  IY: 'İlk Yarı',
  DONUS: 'İY/MS 1/2 – 2/1',
  IYMS: 'İY/MS (diğer)',
  KOMBO: 'Kombine (MS+AÜ/KG)',
  TG: 'Toplam Gol',
  SKOR: 'Skor ve Fark',
  YARI: 'Yarı Özel',
  OZEL: 'Korner, Kart, Diğer',
};

export const MARKETS = {
  '1_1': {
    group: 'MS', name: 'Maç Sonucu', fit: 3, scope: 'ft',
    pred: (no) => (s) => res(s.h, s.a) === RES[no - 1],
    label: (no) => `MS ${RES[no - 1]}`,
  },
  '2_92': {
    group: 'CS', name: 'Çifte Şans', fit: 1, scope: 'ft', sum: 2,
    pred: (no) => (s) => (no === 1 ? s.h >= s.a : no === 2 ? s.h !== s.a : s.h <= s.a),
    label: (no) => `ÇŞ ${['1-X', '1-2', 'X-2'][no - 1]}`,
  },
  '2_101': {
    group: 'AU', name: 'Alt/Üst', fit: 2, scope: 'ft', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.h + s.a < L : s.h + s.a > L),
    label: (no, L) => `${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_89': {
    group: 'KG', name: 'Karşılıklı Gol', fit: 1.5, scope: 'ft',
    pred: (no) => (s) => ((s.h > 0 && s.a > 0) === (no === 1)),
    label: (no) => `KG ${no === 1 ? 'Var' : 'Yok'}`,
  },
  '2_100': {
    group: 'HND', name: 'Handikaplı Maç Sonucu', fit: 1, scope: 'ft', line: true,
    // sov is the handicap applied to the home team (e.g. "-1": home starts one goal down).
    pred: (no, H) => (s) => res(s.h + H, s.a) === RES[no - 1],
    label: (no, H) => `HND (${H > 0 ? '+' + H : H}) ${RES[no - 1]}`,
  },
  '2_603': {
    group: 'TAU', name: 'Ev Sahibi Alt/Üst', fit: 1, scope: 'ft', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.h < L : s.h > L),
    label: (no, L) => `Ev ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_604': {
    group: 'TAU', name: 'Deplasman Alt/Üst', fit: 1, scope: 'ft', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.a < L : s.a > L),
    label: (no, L) => `Dep ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_7': {
    group: 'KOMBO', name: 'MS ve Alt/Üst', fit: 0.5, scope: 'ft', line: true,
    pred: (no, L) => (s) => res(s.h, s.a) === RES[(no - 1) % 3] && ((no <= 3) === (s.h + s.a < L)),
    label: (no, L) => `MS ${RES[(no - 1) % 3]} & ${L} ${no <= 3 ? 'Alt' : 'Üst'}`,
  },
  '2_698': {
    group: 'KOMBO', name: 'MS ve Karşılıklı Gol', fit: 0.5, scope: 'ft',
    pred: (no) => (s) => res(s.h, s.a) === RES[Math.floor((no - 1) / 2)] && ((s.h > 0 && s.a > 0) === (no % 2 === 1)),
    label: (no) => `MS ${RES[Math.floor((no - 1) / 2)]} & KG ${no % 2 === 1 ? 'Var' : 'Yok'}`,
  },
  '2_700': {
    group: 'KOMBO', name: 'Alt/Üst ve KG', fit: 0.5, scope: 'ft', line: true,
    pred: (no, L) => (s) => ((s.h + s.a > L) === (no === 2 || no === 4)) && ((s.h > 0 && s.a > 0) === (no <= 2)),
    label: (no, L) => `${L} ${no === 2 || no === 4 ? 'Üst' : 'Alt'} & KG ${no <= 2 ? 'Var' : 'Yok'}`,
  },
  '2_4': {
    group: 'TG', name: 'Toplam Gol', fit: 0.5, scope: 'ft',
    pred: (no) => (s) => {
      const t = s.h + s.a;
      return no === 1 ? t <= 1 : no === 2 ? t === 2 || t === 3 : no === 3 ? t === 4 || t === 5 : t >= 6;
    },
    label: (no) => `Toplam ${['0-1', '2-3', '4-5', '6+'][no - 1]} gol`,
  },
  '2_91': {
    group: 'TG', name: 'Tek / Çift', fit: 0, scope: 'ft',
    pred: (no) => (s) => ((s.h + s.a) % 2 === 1) === (no === 1),
    label: (no) => `Gol ${no === 1 ? 'Tek' : 'Çift'}`,
  },
  '2_60': {
    group: 'IY', name: '1. Yarı Alt/Üst', fit: 1, scope: 'ht', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.h1 + s.a1 < L : s.h1 + s.a1 > L),
    label: (no, L) => `İY ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_88': {
    group: 'IY', name: '1. Yarı Sonucu', fit: 1, scope: 'ht',
    pred: (no) => (s) => res(s.h1, s.a1) === RES[no - 1],
    label: (no) => `İY ${RES[no - 1]}`,
  },
  '2_77': {
    group: 'IY', name: '1. Yarı Çifte Şans', fit: 0, scope: 'ht', sum: 2,
    pred: (no) => (s) => (no === 1 ? s.h1 >= s.a1 : no === 2 ? s.h1 !== s.a1 : s.h1 <= s.a1),
    label: (no) => `İY ÇŞ ${['1-X', '1-2', 'X-2'][no - 1]}`,
  },
  '2_720': {
    group: 'IY', name: '1. Yarı Karşılıklı Gol', fit: 0, scope: 'ht',
    pred: (no) => (s) => ((s.h1 > 0 && s.a1 > 0) === yes(no)),
    label: (no) => `İY KG ${yes(no) ? 'Var' : 'Yok'}`,
  },
  '2_722': {
    group: 'IY', name: 'Ev Sahibi 1. Yarı Alt/Üst', fit: 0, scope: 'ht', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.h1 < L : s.h1 > L),
    label: (no, L) => `İY Ev ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_723': {
    group: 'IY', name: 'Deplasman 1. Yarı Alt/Üst', fit: 0, scope: 'ht', line: true,
    pred: (no, L) => (s) => (no === 1 ? s.a1 < L : s.a1 > L),
    label: (no, L) => `İY Dep ${L} ${no === 1 ? 'Alt' : 'Üst'}`,
  },
  '2_724': {
    group: 'IY', name: '1. Yarı Sonucu ve Alt/Üst', fit: 0, scope: 'ht', line: true,
    pred: (no, L) => (s) => res(s.h1, s.a1) === RES[(no - 1) % 3] && ((no <= 3) === (s.h1 + s.a1 < L)),
    label: (no, L) => `İY ${RES[(no - 1) % 3]} & İY ${L} ${no <= 3 ? 'Alt' : 'Üst'}`,
  },
  '2_699': {
    group: 'IY', name: '1. Yarı Sonucu ve İY KG', fit: 0, scope: 'ht',
    pred: (no) => (s) => res(s.h1, s.a1) === RES[Math.floor((no - 1) / 2)] && ((s.h1 > 0 && s.a1 > 0) === (no % 2 === 1)),
    label: (no) => `İY ${RES[Math.floor((no - 1) / 2)]} & İY KG ${no % 2 === 1 ? 'Var' : 'Yok'}`,
  },
  '2_719': {
    group: 'IY', name: '1. Yarı Tek/Çift', fit: 0, scope: 'ht',
    pred: (no) => (s) => ((s.h1 + s.a1) % 2 === 1) === (no === 1),
    label: (no) => `İY Gol ${no === 1 ? 'Tek' : 'Çift'}`,
  },
  '2_90': {
    group: 'IYMS', name: 'İY / MS', fit: 0.5, scope: 'both',
    pred: (no) => (s) => res(s.h1, s.a1) === RES[Math.floor((no - 1) / 3)] && res(s.h, s.a) === RES[(no - 1) % 3],
    label: (no) => `İY/MS ${RES[Math.floor((no - 1) / 3)]}/${RES[(no - 1) % 3]}`,
  },
  '2_86': {
    group: 'SKOR', name: 'Maç Skoru', fit: 0, scope: 'ft', named: true,
    pred: (no, L, ctx) => {
      const sc = parseScore(ctx?.name);
      if (sc) return (s) => s.h === sc[0] && s.a === sc[1];
      const listed = (ctx?.names || []).map(parseScore).filter(Boolean);
      return (s) => !listed.some(([x, y]) => s.h === x && s.a === y);
    },
    label: (no, L, ctx) => (parseScore(ctx?.name) ? `Skor ${parseScore(ctx.name).join('-')}` : 'Skor diğer'),
  },
  '2_717': {
    group: 'SKOR', name: '1. Yarı Skoru', fit: 0, scope: 'ht', named: true,
    pred: (no, L, ctx) => {
      const sc = parseScore(ctx?.name);
      if (sc) return (s) => s.h1 === sc[0] && s.a1 === sc[1];
      const listed = (ctx?.names || []).map(parseScore).filter(Boolean);
      return (s) => !listed.some(([x, y]) => s.h1 === x && s.a1 === y);
    },
    label: (no, L, ctx) => (parseScore(ctx?.name) ? `İY Skor ${parseScore(ctx.name).join('-')}` : 'İY Skor diğer'),
  },
  '2_11': {
    group: 'SKOR', name: 'Hangi Takım Kaç Farkla Kazanır', fit: 0, scope: 'ft',
    // 1: Ev 3+, 2: Ev 2, 3: Ev 1, 4: Dep 1, 5: Dep 2, 6: Dep 3+, 7: beraberlik
    pred: (no) => (s) => {
      const d = s.h - s.a;
      return [d >= 3, d === 2, d === 1, d === -1, d === -2, d <= -3, d === 0][no - 1];
    },
    label: (no) => ['Ev 3+ farkla', 'Ev 2 farkla', 'Ev 1 farkla', 'Dep 1 farkla', 'Dep 2 farkla', 'Dep 3+ farkla', 'Beraberlik'][no - 1],
  },
  '2_36': {
    group: 'YARI', name: '2. Yarı Sonucu', fit: 0, scope: 'both',
    pred: (no) => (s) => res(s.h - s.h1, s.a - s.a1) === RES[no - 1],
    label: (no) => `2.Y ${RES[no - 1]}`,
  },
  '2_821': {
    group: 'YARI', name: '2. Yarı Karşılıklı Gol', fit: 0, scope: 'both',
    pred: (no) => (s) => ((s.h - s.h1 > 0 && s.a - s.a1 > 0) === yes(no)),
    label: (no) => `2.Y KG ${yes(no) ? 'Var' : 'Yok'}`,
  },
  '2_6': {
    group: 'YARI', name: 'Hangi Yarıda Daha Fazla Gol', fit: 0, scope: 'both',
    pred: (no) => (s) => { const g1 = s.h1 + s.a1, g2 = s.h + s.a - g1; return no === 1 ? g1 > g2 : no === 2 ? g1 === g2 : g2 > g1; },
    label: (no) => ['Çok gol 1. yarı', 'Yarılar eşit gol', 'Çok gol 2. yarı'][no - 1],
  },
  '2_84': {
    group: 'YARI', name: 'Ev Sahibi Hangi Yarıda Daha Fazla Gol Atar', fit: 0, scope: 'both',
    pred: (no) => (s) => { const g1 = s.h1, g2 = s.h - s.h1; return no === 1 ? g1 > g2 : no === 2 ? g1 === g2 : g2 > g1; },
    label: (no) => ['Ev çok golü 1. yarı', 'Ev golleri yarılarda eşit', 'Ev çok golü 2. yarı'][no - 1],
  },
  '2_85': {
    group: 'YARI', name: 'Deplasman Hangi Yarıda Daha Fazla Gol Atar', fit: 0, scope: 'both',
    pred: (no) => (s) => { const g1 = s.a1, g2 = s.a - s.a1; return no === 1 ? g1 > g2 : no === 2 ? g1 === g2 : g2 > g1; },
    label: (no) => ['Dep çok golü 1. yarı', 'Dep golleri yarılarda eşit', 'Dep çok golü 2. yarı'][no - 1],
  },
  '2_727': {
    group: 'YARI', name: 'Ev Sahibi Yarı Kazanır', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.h1 > s.a1 || s.h - s.h1 > s.a - s.a1) === yes(no),
    label: (no) => `Ev bir yarıyı kazanır: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_728': {
    group: 'YARI', name: 'Deplasman Yarı Kazanır', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.a1 > s.h1 || s.a - s.a1 > s.h - s.h1) === yes(no),
    label: (no) => `Dep bir yarıyı kazanır: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_69': {
    group: 'YARI', name: 'Ev Sahibi Her İki Yarıyı Kazanır', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.h1 > s.a1 && s.h - s.h1 > s.a - s.a1) === yes(no),
    label: (no) => `Ev iki yarıyı da kazanır: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_72': {
    group: 'YARI', name: 'Deplasman Her İki Yarıyı Kazanır', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.a1 > s.h1 && s.a - s.a1 > s.h - s.h1) === yes(no),
    label: (no) => `Dep iki yarıyı da kazanır: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_861': {
    group: 'YARI', name: 'Ev Sahibi Her İki Yarıda Gol Atar', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.h1 > 0 && s.h - s.h1 > 0) === yes(no),
    label: (no) => `Ev iki yarıda da gol: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_862': {
    group: 'YARI', name: 'Deplasman Her İki Yarıda Gol Atar', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.a1 > 0 && s.a - s.a1 > 0) === yes(no),
    label: (no) => `Dep iki yarıda da gol: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_729': {
    group: 'YARI', name: 'Her İki Yarıda da Alt 1.5', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.h1 + s.a1 < 1.5 && s.h + s.a - s.h1 - s.a1 < 1.5) === yes(no),
    label: (no) => `İki yarı da 1.5 Alt: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_730': {
    group: 'YARI', name: 'Her İki Yarıda da Üst 1.5', fit: 0, scope: 'both',
    pred: (no) => (s) => (s.h1 + s.a1 > 1.5 && s.h + s.a - s.h1 - s.a1 > 1.5) === yes(no),
    label: (no) => `İki yarı da 1.5 Üst: ${yes(no) ? 'Evet' : 'Hayır'}`,
  },
  '2_866': {
    group: 'YARI', name: '1. ve 2. Yarıda Karşılıklı Gol', fit: 0, scope: 'both',
    // 1: Hayır/Hayır, 2: Evet/Hayır, 3: Evet/Evet, 4: Hayır/Evet
    pred: (no) => (s) => {
      const k1 = s.h1 > 0 && s.a1 > 0, k2 = s.h - s.h1 > 0 && s.a - s.a1 > 0;
      return [!k1 && !k2, k1 && !k2, k1 && k2, !k1 && k2][no - 1];
    },
    label: (no) => `KG İY/2.Y ${['Yok/Yok', 'Var/Yok', 'Var/Var', 'Yok/Var'][no - 1]}`,
  },
};

// Market keys never offered as picks (player props are not mutually exclusive outcomes).
const SKIP = new Set(['2_3', '2_12', '2_859', '2_852', '2_794', '2_795', '2_796', '2_797', '2_799', '2_944', '2_945', '2_718', '2_87']);

export function marketKey(m) {
  return `${m.t}_${m.st}`;
}

function parseLine(sov) {
  if (sov === undefined || sov === null || sov === '') return null;
  const v = parseFloat(String(sov).replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

function genericDef(key, names) {
  const raw = names?.[key] || 'Özel bahis';
  return { group: 'OZEL', name: raw.replace(/\s*\{[^}]*\}\s*/g, ' ').trim(), rawName: raw, generic: true, fit: 0 };
}

// Turn raw iddaa markets of an event into normalized market objects.
// oddField: 'odd' (kral oran on iddaa.com) or 'wodd' (normal oran).
// marketNames: optional { "t_st": "name" } for markets we do not model.
export function normalizeMarkets(event, oddField = 'odd', marketNames = null) {
  const out = [];
  for (const m of event.m || []) {
    const key = marketKey(m);
    if (SKIP.has(key) || m.t === 3) continue;
    if (m.s !== 1) continue; // market not open
    let def = MARKETS[key];
    const line = parseLine(m.sov);
    const outcomes = [];
    let complete = true;
    for (const o of m.o || []) {
      const odd = Number(o[oddField] ?? o.odd);
      if (!(odd > 1.0)) { complete = false; continue; }
      outcomes.push({ no: o.no, odd, name: o.n });
    }
    // goal markets can be priced by the score model even when one side is closed (odd 1.00)
    if (outcomes.length < (def ? 1 : 2)) continue;
    complete = complete && outcomes.length === (m.o || []).length;
    if (!def) {
      // only clean partitions can be de-vigged on their own
      const s = outcomes.reduce((x, o) => x + 1 / o.odd, 0);
      if (!complete || outcomes.length > 8 || s < 1.01 || s > 1.5) continue;
      def = genericDef(key, marketNames);
    } else if (def.line && line === null) continue;
    const names = (m.o || []).map((o) => o.n);
    out.push({ id: m.i, key, def, line, mbc: m.mbc ?? event.mbc ?? 1, outcomes, names, complete });
  }
  return out;
}

export function pickId(eventId, key, line, no) {
  return `${eventId}:${key}:${line ?? ''}:${no}`;
}

export function pickPredicate(key, line, no, ctx) {
  const def = MARKETS[key];
  if (!def) return null;
  return def.pred(no, line, ctx);
}

export function pickLabel(def, line, no, ctx) {
  if (def.generic) {
    const mk = def.rawName.replace('{0}', line ?? '').replace('{h}', line ?? '').replace(/\s+/g, ' ').trim();
    return `${mk}: ${ctx?.name ?? no}`;
  }
  return def.label(no, line, ctx);
}

// Settle a pick against a final score. Returns true / false, or null when it cannot be decided
// (non-goal markets such as corners/cards, or a missing half-time score).
export function settlePick(pick, score) {
  const def = MARKETS[pick.key];
  if (!def) return null;
  const p = def.pred(pick.no, pick.line, { name: pick.name, names: pick.names });
  if (def.scope !== 'ft' && (score.h1 === undefined || score.h1 === null)) return null;
  return p({ h: score.h, a: score.a, h1: score.h1 ?? 0, a1: score.a1 ?? 0 });
}
