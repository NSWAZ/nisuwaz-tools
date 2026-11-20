/*
 * PLEX 현질 효율 계산 — ported from the original plex.html without the DOM.
 * test/plex.test.ts runs the original page in jsdom and checks these functions
 * produce the same ranking rows.
 */
import { comma } from "./format";

export const TYPES = { PLEX: "44992", LSI: "40520", EXT: "40519" } as const;
export type QuoteType = keyof typeof TYPES;

export interface QuoteSide {
  [field: string]: string | number | undefined;
}
export interface Quote {
  buy: QuoteSide;
  sell: QuoteSide;
}
export type Aggregates = Record<string, Quote | undefined>;

/** Steam live Omega prices keyed by months: {final, initial, disc} in KRW. */
export type SteamLive = Record<string, { final: number; initial: number; disc: number } | undefined>;

export const PRICE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["buy.max", "매수 최고가 (즉시 매도가)"],
  ["buy.percentile", "매수 백분위"],
  ["buy.weightedAverage", "매수 가중평균"],
  ["buy.median", "매수 중앙값"],
  ["buy.min", "매수 최저가"],
  ["sell.min", "매도 최저가 (즉시 매수가)"],
  ["sell.percentile", "매도 백분위"],
  ["sell.weightedAverage", "매도 가중평균"],
  ["sell.median", "매도 중앙값"],
  ["sell.max", "매도 최고가"],
];

export const DEFAULT_DIRECTION: Record<QuoteType, string> = {
  PLEX: "buy.max",
  LSI: "buy.max",
  EXT: "sell.min",
};

/** Verified reference prices used before live quotes arrive. */
export const DEFAULT_PRICES: Prices = { plex: 4713000, lsi: 700200000, ext: 460400000 };

/** Read "side.field" from a Fuzzwork quote; null when absent or not a number. */
export function pickQuote(q: Quote | null | undefined, key: string): number | null {
  if (!q) return null;
  const [side, field] = key.split(".");
  const s = (q as unknown as Record<string, QuoteSide | undefined>)[side];
  if (!s) return null;
  const v = parseFloat(String(s[field]));
  return Number.isFinite(v) ? v : null;
}

/** A usable aggregates payload has a positive PLEX buy.max (rejects empty or redirected bodies). */
export function isUsableAggregates(data: unknown): data is Aggregates {
  if (!data || typeof data !== "object") return false;
  const q = (data as Aggregates)[TYPES.PLEX];
  const probe = q && q.buy ? parseFloat(String(q.buy.max)) : NaN;
  return probe > 0;
}

// ---- constants (2026-06 public prices) ----
export const OMEGA_TIERS = [
  { mo: 1, days: 30, plex: 500, steam: 26200, usd: 20, bonus: 0 },
  { mo: 3, days: 90, plex: 1200, steam: 62880, usd: 60, bonus: 200 },
  { mo: 6, days: 180, plex: 2100, steam: 110040, usd: 120, bonus: 500 },
  { mo: 12, days: 365, plex: 3600, steam: 188640, usd: 240, bonus: 1000 },
  { mo: 24, days: 730, plex: 4950, steam: 345840, usd: 480, bonus: 1500 },
] as const;

export const SPDAY_OPT = 64800;
export const SPDAY_NOIMP = 51840;
export const PLEX_BUNDLE = { steamKRW: 851500, webUSD: 649.99, qty: 20000 } as const;
export const SP_BUNDLES = [
  { name: "언독 부스트 번들", usd: 16, sp: 648000 },
  { name: "3x 언독 부스트 번들", usd: 32, sp: 1944000 },
  { name: "애프터버너 부스트 번들", usd: 48, sp: 1944000 },
  { name: "3x 애프터버너 번들", usd: 96, sp: 5832000 },
  { name: "워프 부스트 번들", usd: 96, sp: 3888000 },
  { name: "3x 워프 부스트 번들", usd: 192, sp: 11664000 },
  { name: "점프 부스트 번들", usd: 192, sp: 7776000 },
  { name: "3x 점프 부스트 번들", usd: 384, sp: 23328000 },
] as const;

export const INJECTOR_TIERS = [
  { value: 500000, label: "5M 미만 · LSI당 500k" },
  { value: 400000, label: "5M ~ 50M · LSI당 400k" },
  { value: 300000, label: "50M ~ 80M · LSI당 300k" },
  { value: 150000, label: "80M 초과 · LSI당 150k" },
] as const;

const MONTH_DAYS = 30.4167;

export interface Prices {
  plex: number;
  lsi: number;
  ext: number;
}

/** Skill-farm assumptions; the page keeps these in a folded section. */
export interface FarmInputs {
  budget: number;
  omegaPlex: number;
  mctPlex: number;
  mctCount: number;
  farmMonths: number;
  spPerDay: number;
  boosterOn: boolean;
  boosterMul: number;
  floorSp: number;
  spPerLsi: number;
  taxPercent: number;
  nesQty: number;
  nesPlex: number;
}

export const DEFAULT_FARM: FarmInputs = {
  budget: 20000,
  omegaPlex: 6600,
  mctPlex: 4400,
  mctCount: 2,
  farmMonths: 24,
  spPerDay: 64800,
  boosterOn: false,
  boosterMul: 1,
  floorSp: 5000000,
  spPerLsi: 500000,
  taxPercent: 2.0,
  nesQty: 50,
  nesPlex: 5600,
};

export interface FarmResult {
  plexPrice: number;
  lsiPrice: number;
  extMarket: number;
  budget: number;
  chars: number;
  days: number;
  spPerChar: number;
  totalSp: number;
  lsiCount: number;
  extNeeded: number;
  nesIsk: number;
  extUnit: number;
  extSrc: string;
  setupPlex: number;
  leftoverPlex: number;
  leftoverIsk: number;
  iskA: number;
  lsiGross: number;
  lsiNet: number;
  extCost: number;
  iskB_pre: number;
  iskB: number;
  tax: number;
}

const n = (v: number) => (Number.isFinite(v) ? v : 0);

export function computeFarm(p: Prices, f: FarmInputs): FarmResult {
  const plexPrice = n(p.plex);
  const lsiPrice = n(p.lsi);
  const extMarket = n(p.ext);
  const budget = n(f.budget);
  const omegaPlex = n(f.omegaPlex);
  const mctPlex = n(f.mctPlex);
  const mctCount = n(f.mctCount);
  const farmM = n(f.farmMonths);
  let spDay = n(f.spPerDay);
  const floorSp = n(f.floorSp);
  const spLsi = n(f.spPerLsi) || 500000;
  const tax = n(f.taxPercent) / 100;
  const nesQty = n(f.nesQty) || 1;
  const nesPlex = n(f.nesPlex);

  if (f.boosterOn) spDay *= n(f.boosterMul) || 1;

  const chars = 1 + mctCount;
  const days = farmM * MONTH_DAYS;
  const spPerChar = spDay * days - floorSp;
  const totalSp = spPerChar * chars;
  const lsiCount = Math.floor(totalSp / spLsi);
  const extNeeded = lsiCount;

  const nesIsk = (nesPlex / nesQty) * plexPrice;
  const extUnit = Math.min(extMarket, nesIsk);
  const extSrc = extMarket <= nesIsk ? "시장 매수" : "NES PLEX 환산";

  const setupPlex = omegaPlex + mctCount * mctPlex;
  const leftoverPlex = budget - setupPlex;
  const leftoverIsk = leftoverPlex * plexPrice;

  const iskA = budget * plexPrice;
  const lsiGross = lsiCount * lsiPrice;
  const lsiNet = lsiGross * (1 - tax);
  const extCost = extNeeded * extUnit;
  const iskB_pre = lsiGross - extCost + leftoverIsk;
  const iskB = lsiNet - extCost + leftoverIsk;

  return {
    plexPrice, lsiPrice, extMarket, budget, chars, days, spPerChar, totalSp,
    lsiCount, extNeeded, nesIsk, extUnit, extSrc, setupPlex, leftoverPlex, leftoverIsk,
    iskA, lsiGross, lsiNet, extCost, iskB_pre, iskB, tax,
  };
}

export interface RankRow {
  id: string;
  label: string;
  /** 원 per unit; lower is better. */
  val: number;
  /** Replaces the won figure (self-funding Omega that pays for itself). */
  disp?: string;
  note: string;
}

export interface RankOptions {
  usdKrw: number;
  /** Effective SP per LSI for the viewer's SP bracket. */
  injectorSp: number;
  steamLive: SteamLive | null;
}

export interface Rankings {
  isk: RankRow[];
  sp: RankRow[];
  omega: RankRow[];
  /** Cheapest won per PLEX across stores. */
  wonPerPlex: number;
}

/** Keep rows with a positive finite value, cheapest first (stable for ties). */
export function sortRank(rows: RankRow[]): RankRow[] {
  return rows.filter((x) => Number.isFinite(x.val) && x.val > 0).sort((a, b) => a.val - b.val);
}

export function buildRankings(r: FarmResult, f: FarmInputs, o: RankOptions): Rankings {
  const usdKrw = n(o.usdKrw) || 1545;
  const px = r.plexPrice;
  const lsi = r.lsiPrice;

  const chans = [
    { store: "Steam 20k 번들", per: PLEX_BUNDLE.steamKRW / PLEX_BUNDLE.qty },
    { store: "EVE웹 20k 번들", per: (PLEX_BUNDLE.webUSD * usdKrw) / PLEX_BUNDLE.qty },
  ].filter((c) => c.per > 0);
  const kpp = chans.length ? Math.min(...chans.map((c) => c.per)) : 0;

  // ③ 원 / 오메가 1개월
  const om: RankRow[] = [];
  for (const t of OMEGA_TIERS) {
    om.push({ id: `plex-omega-${t.mo}`, label: `PLEX-오메가 ${t.mo}개월`, val: (t.plex * kpp) / t.mo, note: `${comma(t.plex)} PLEX` });
    const sL = o.steamLive ? o.steamLive[String(t.mo)] : undefined;
    const sPrice = sL ? sL.final : t.steam;
    const sNote = sL
      ? sL.disc > 0
        ? `₩${comma(sPrice)} · ${sL.disc}% 세일`
        : `₩${comma(sPrice)}`
      : `₩${comma(t.steam)} 정가`;
    om.push({ id: `steam-omega-${t.mo}`, label: `Steam 직접 ${t.mo}개월`, val: sPrice / t.mo, note: sNote });
    om.push({
      id: `web-omega-${t.mo}`,
      label: `EVE웹 ${t.mo}개월`,
      val: (t.usd * usdKrw - t.bonus * kpp) / t.mo,
      note: `$${t.usd}${t.bonus ? ` +${comma(t.bonus)}P` : ""}`,
    });
  }
  const pureVals = om.map((x) => x.val).filter((v) => Number.isFinite(v) && v > 0);
  const bestOmegaMonth = pureVals.length ? Math.min(...pureVals) : NaN;
  const bestOmegaDay = bestOmegaMonth / MONTH_DAYS;

  {
    const sfFloor = n(f.floorSp) || 5000000;
    const sfSpLsi = n(f.spPerLsi) || 500000;
    const sfDays = 24 * MONTH_DAYS;
    const sfLsiPerChar = Math.floor(Math.max(0, SPDAY_OPT * sfDays - sfFloor) / sfSpLsi);
    const sfWonPerIsk = px > 0 ? kpp / px : NaN;
    let best: { ch: number; net: number; lsiTot: number } | null = null;
    for (let ch = 1; ch <= 3; ch++) {
      const lsiTot = sfLsiPerChar * ch;
      const incomeIsk = lsiTot * lsi * (1 - r.tax) - lsiTot * r.extUnit;
      const net = ((4950 + (ch - 1) * 4600) * kpp - incomeIsk * sfWonPerIsk) / 24;
      if (best === null || net < best.net) best = { ch, net, lsiTot };
    }
    if (best && Number.isFinite(best.net)) {
      const neg = best.net < 0;
      const mctN = best.ch - 1;
      om.push({
        id: "self-funded-omega",
        label: `스킬팜 자가펀딩 오메가 (${mctN ? `MCT ${mctN}개·${best.ch}캐릭` : "오메가만 1캐릭"})`,
        val: neg ? 0.0001 : best.net,
        disp: neg ? `이득 ₩${comma(-best.net)}/월` : undefined,
        note: `24mo 오메가${mctN ? ` + MCT ${mctN}개` : ""}·+5임플 풀팜 → LSI ${comma(best.lsiTot)}개 판매수익 차감`,
      });
    }
  }

  // ① 원 / 1B ISK
  const isk: RankRow[] = chans.map((c, i) => ({
    id: i === 0 ? "steam-plex-sell" : "web-plex-sell",
    label: `${c.store}에서 PLEX 사서 판매`,
    val: px > 0 ? (c.per / px) * 1e9 : NaN,
    note: `${comma(Math.round(c.per))}원/PLEX 구매 → PLEX 판매가 ${comma(px)} ISK/개`,
  }));
  isk.push({
    id: "skill-farm-isk",
    label: "스킬팜 (최저가 PLEX로 오메가+MCT)",
    val: r.iskB > 0 ? (kpp * r.budget) / (r.iskB / 1e9) : NaN,
    note: `${comma(Math.round(kpp))}원/PLEX로 팜 → LSI ${comma(r.lsiCount)}개 판매 (장기)`,
  });

  // ② 원 / 1M SP
  const spLsi = n(o.injectorSp) || 400000;
  const wonPerLsi = px > 0 ? lsi * (kpp / px) : NaN;
  const sp: RankRow[] = [
    { id: "injector", label: "인젝터 주입(LSI 구매)", val: wonPerLsi / (spLsi / 1e6), note: `LSI당 ${comma(spLsi)} SP (선택 구간)` },
    { id: "train-opt", label: "훈련 +5임플 (64,800/일)", val: bestOmegaDay / (SPDAY_OPT / 1e6), note: "최적 리맵·임플" },
    { id: "train-noimp", label: "훈련 임플없음 (51,840/일)", val: bestOmegaDay / (SPDAY_NOIMP / 1e6), note: "+5임플 없음" },
  ];
  SP_BUNDLES.forEach((b, i) => {
    sp.push({
      id: `sp-bundle-${i}`,
      label: `EVE웹 ${b.name}`,
      val: (b.usd * usdKrw) / (b.sp / 1e6),
      note: `$${b.usd} / ${comma(b.sp)} SP · +대뇌가속기 보너스(미반영)`,
    });
  });

  return { isk: sortRank(isk), sp: sortRank(sp), omega: sortRank(om), wonPerPlex: kpp };
}
