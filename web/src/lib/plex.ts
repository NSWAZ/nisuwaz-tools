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

/** EVE web store prices in USD, as the refresher reads them from store.eveonline.com. */
export interface EveStore {
  omega: Array<{ months: number; plex: number; price: number; base: number }>;
  plex: Array<{ qty: number; price: number; base: number }>;
  boosts: Array<{ key: string; price: number; base: number }>;
}

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
  { mo: 24, days: 730, plex: 6600, steam: 345840, usd: 480, bonus: 1500 },
] as const;

export const SPDAY_OPT = 64800;
export const SPDAY_NOIMP = 51840;
export const PLEX_BUNDLE = { steamKRW: 851500, qty: 20000 } as const;
/** EVE web store PLEX packs (2026-06 list prices, USD), used when store prices are unavailable. */
export const PLEX_PACKS = [
  { qty: 100, usd: 5 },
  { qty: 500, usd: 25 },
  { qty: 1000, usd: 45 },
  { qty: 1500, usd: 65 },
  { qty: 3000, usd: 125 },
  { qty: 6000, usd: 240 },
  { qty: 12000, usd: 420 },
  { qty: 20000, usd: 650 },
  { qty: 64500, usd: 2000 },
] as const;
/** `key` matches the refresher's store boost keys ("undock", "3x-undock", ...). */
export const SP_BUNDLES = [
  { key: "undock", name: "언독 부스트 번들", usd: 16, sp: 648000 },
  { key: "3x-undock", name: "3x 언독 부스트 번들", usd: 32, sp: 1944000 },
  { key: "afterburn", name: "애프터버너 부스트 번들", usd: 48, sp: 1944000 },
  { key: "3x-afterburn", name: "3x 애프터버너 번들", usd: 96, sp: 5832000 },
  { key: "warp", name: "워프 부스트 번들", usd: 96, sp: 3888000 },
  { key: "3x-warp", name: "3x 워프 부스트 번들", usd: 192, sp: 11664000 },
  { key: "jump", name: "점프 부스트 번들", usd: 192, sp: 7776000 },
  { key: "3x-jump", name: "3x 점프 부스트 번들", usd: 384, sp: 23328000 },
] as const;

/** Store prices can carry cents ($3.75); whole dollars print without them. */
const usd = (v: number) => (Number.isInteger(v) ? comma(v) : v.toFixed(2));

/** " · 25% 세일" when a store price is below its list price. */
const saleNote = (price: number, base: number) => (base > price ? ` · ${Math.round((1 - price / base) * 100)}% 세일` : "");

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
  /** Live EVE web store prices; null keeps the built-in 2026-06 prices. */
  store?: EveStore | null;
  /** Take a month of SP extraction income off every Omega route; off by default (plain purchase cost). */
  extract?: boolean;
}

export interface Rankings {
  isk: RankRow[];
  sp: RankRow[];
  omega: RankRow[];
  /** Cheapest won per PLEX across stores. */
  wonPerPlex: number;
  /** Won earned per month by extracting and selling one character's trained SP. */
  extractWon: number;
}

/** Keep rows with a positive finite value, cheapest first (stable for ties). */
export function sortRank(rows: RankRow[]): RankRow[] {
  return rows.filter((x) => Number.isFinite(x.val) && x.val > 0).sort((a, b) => a.val - b.val);
}

export function buildRankings(r: FarmResult, f: FarmInputs, o: RankOptions): Rankings {
  const usdKrw = n(o.usdKrw) || 1545;
  const px = r.plexPrice;
  const lsi = r.lsiPrice;

  const store = o.store ?? null;
  // Every web PLEX pack: the cheapest store offer per size, or the built-in list without store prices.
  const cheapest = new Map<number, { qty: number; price: number; base: number }>();
  const packs = store?.plex.length ? store.plex : PLEX_PACKS.map((p) => ({ qty: p.qty, price: p.usd, base: p.usd }));
  for (const p of packs) {
    const had = cheapest.get(p.qty);
    if (p.qty > 0 && (!had || p.price < had.price)) cheapest.set(p.qty, p);
  }
  const chans = [
    { id: "steam-plex-sell", src: "Steam 20k 번들", label: "Steam 20k 번들에서 PLEX 사서 판매", sale: "", per: PLEX_BUNDLE.steamKRW / PLEX_BUNDLE.qty },
    ...[...cheapest.values()].map((p) => ({
      id: `web-plex-sell-${p.qty}`,
      src: `EVE웹 ${comma(p.qty)} PLEX팩`,
      label: `EVE웹 ${comma(p.qty)} PLEX팩 사서 판매`,
      sale: saleNote(p.price, p.base),
      per: (p.price * usdKrw) / p.qty,
    })),
  ].filter((c) => Number.isFinite(c.per) && c.per > 0);
  const kpp = chans.length ? Math.min(...chans.map((c) => c.per)) : 0;

  // ③ 원 / 오메가 1개월
  const om: RankRow[] = [];
  for (const t of OMEGA_TIERS) {
    // PLEX bought with each pack, then Omega bought in game; priced per PLEX, so leftover PLEX keeps its value.
    for (const c of chans) {
      om.push({
        id: `plex-omega-${t.mo}-${c.id}`,
        label: `PLEX-오메가 ${t.mo}개월 · ${c.src}`,
        val: (t.plex * c.per) / t.mo,
        note: `${c.src} ${c.per.toFixed(1)}원/PLEX로 ${comma(t.plex)} PLEX 구매${c.sale} → 인게임 오메가`,
      });
    }
    const sL = o.steamLive ? o.steamLive[String(t.mo)] : undefined;
    const sPrice = sL ? sL.final : t.steam;
    const sNote = sL
      ? sL.disc > 0
        ? `₩${comma(sPrice)} · ${sL.disc}% 세일`
        : `₩${comma(sPrice)}`
      : `₩${comma(t.steam)} 정가`;
    om.push({ id: `steam-omega-${t.mo}`, label: `Steam 직접 ${t.mo}개월`, val: sPrice / t.mo, note: sNote });
    // With store prices: the cheapest offer for this length (bonus PLEX counted at won/PLEX); a length the store
    // no longer sells drops out. Without them: the built-in 2026-06 price.
    const offers = store
      ? store.omega.filter((x) => x.months === t.mo)
      : [{ months: t.mo, plex: t.bonus, price: t.usd, base: t.usd }];
    // Only a positive cost can be ranked; an offer whose bonus outweighs its price is skipped, not picked.
    const web = offers
      .map((x) => ({ ...x, val: (x.price * usdKrw - x.plex * kpp) / t.mo }))
      .filter((x) => Number.isFinite(x.val) && x.val > 0)
      .sort((a, b) => a.val - b.val)[0];
    if (web) {
      om.push({
        id: `web-omega-${t.mo}`,
        label: `EVE웹 ${t.mo}개월`,
        val: web.val,
        note: `$${usd(web.price)}${web.plex ? ` +${comma(web.plex)}P` : ""}${saleNote(web.price, web.base)}`,
      });
    }
  }
  const pureVals = om.map((x) => x.val).filter((v) => Number.isFinite(v) && v > 0);
  const bestOmegaMonth = pureVals.length ? Math.min(...pureVals) : NaN;
  const bestOmegaDay = bestOmegaMonth / MONTH_DAYS;

  // One month of +5 implant training on a character already above the floor, all extracted and sold;
  // the ISK is valued at what buying it would cost (cheapest PLEX, sold at the PLEX price).
  const lsiPerMonth = (SPDAY_OPT * MONTH_DAYS) / (n(f.spPerLsi) || 500000);
  const extractIsk = lsiPerMonth * (lsi * (1 - r.tax) - r.extUnit);
  const extractWon = px > 0 ? extractIsk * (kpp / px) : NaN;
  const omega =
    // Ignored when extraction would lose money (LSI sells for less than the extractor and tax cost).
    o.extract && Number.isFinite(extractWon) && extractWon > 0
      ? om.map((x): RankRow => {
          const net = x.val - extractWon;
          const note = `${x.note} · 추출 수익 −₩${comma(Math.round(extractWon))}`;
          // A route that pays for itself shows its gain; bigger gains rank first.
          const gain = Math.round(-net);
          return gain < 1 ? { ...x, val: Math.max(net, 1e-3), note } : { ...x, val: 1e-3 / (1 + gain), disp: `이득 ₩${comma(gain)}/월`, note };
        })
      : om;

  // ① 원 / 1B ISK
  const isk: RankRow[] = chans.map((c) => ({
    id: c.id,
    label: c.label,
    val: px > 0 ? (c.per / px) * 1e9 : NaN,
    note: `${comma(Math.round(c.per))}원/PLEX 구매${c.sale} → PLEX 판매가 ${comma(px)} ISK/개`,
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
    const live = store ? store.boosts.find((x) => x.key === b.key) : { price: b.usd, base: b.usd };
    if (!live) return; // not on sale in the store right now
    sp.push({
      id: `sp-bundle-${i}`,
      label: `EVE웹 ${b.name}`,
      val: (live.price * usdKrw) / (b.sp / 1e6),
      note: `$${usd(live.price)} / ${comma(b.sp)} SP${saleNote(live.price, live.base)} · +대뇌가속기 보너스(미반영)`,
    });
  });

  return { isk: sortRank(isk), sp: sortRank(sp), omega: sortRank(omega), wonPerPlex: kpp, extractWon };
}
