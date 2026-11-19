/*
 * 냉장고 계산기 — parsing and shopping-list math ported from the original fridge.html.
 * test/fridge.test.ts renders the original page in jsdom and compares the table,
 * the summary and the Multibuy text against these functions.
 */

export interface PriceEntry {
  /** Lowest Jita 4-4 sell price in ISK; 0 means no sell orders. */
  p: number;
  /** Epoch ms when fetched. */
  t: number;
}
export interface PriceCache {
  /** lower-case item name → type id (0 = ESI did not know the name). */
  ids: Record<string, number>;
  prices: Record<string, PriceEntry>;
  /** type id → packaged volume per unit (m³). */
  vol: Record<string, number>;
}
export const emptyCache = (): PriceCache => ({ ids: {}, prices: {}, vol: {} });

export interface Fit {
  id: string;
  qty: number;
  text: string;
  collapsed?: boolean;
}

export interface Counted {
  name: string;
  qty: number;
}
export type CountMap = Record<string, Counted>;

export function qtyOf(s: unknown): number {
  if (s == null) return NaN;
  const d = String(s).replace(/[\s,.' ]/g, "");
  return /^\d+$/.test(d) ? parseInt(d, 10) : NaN;
}

/** A name-keyed map with no prototype, so pasted names like "__proto__" are ordinary keys. */
export function newCountMap(): CountMap {
  return Object.create(null) as CountMap;
}

/** Longer lines are not item lines; skipping them also keeps the quantity regexes linear. */
export const MAX_LINE = 300;

function clip(line: string): string {
  return line.length > 60 ? line.slice(0, 60) + "…" : line;
}

export function addCount(map: CountMap, rawName: string, qty: number): void {
  const name = rawName.replace(/\s+/g, " ").trim();
  if (!name || !(qty > 0)) return;
  const k = name.toLowerCase();
  if (!map[k]) map[k] = { name, qty: 0 };
  map[k].qty += qty;
}

export interface ParsedFit {
  map: CountMap;
  skipped: string[];
  hull: string;
  name: string;
}

/** EFT / in-game "Copy to clipboard" fitting text. */
export function parseFit(text: string, withHull: boolean): ParsedFit {
  const map = newCountMap();
  const skipped: string[] = [];
  let hullName = "";
  let fitName = "";
  text.split(/\r?\n/).forEach((raw) => {
    let line = raw.trim();
    if (!line) return;
    if (line.length > MAX_LINE) {
      skipped.push(clip(line));
      return;
    }
    if (/^\[empty .*slot\]$/i.test(line)) return;
    const hull = line.match(/^\[([^,\]]+),\s*(.*)\]$/);
    if (hull) {
      if (!hullName) {
        hullName = hull[1].trim();
        fitName = hull[2].trim();
      }
      if (withHull) addCount(map, hull[1], 1);
      return;
    }
    if (/^\[.*\]$/.test(line)) {
      skipped.push(line);
      return;
    }
    line = line.replace(/\s*\/offline$/i, "");
    const m = line.match(/^(.*?)\s+x\s?([\d,.]+)$/i);
    if (m) {
      addCount(map, m[1], qtyOf(m[2]));
      return;
    }
    const comma = line.indexOf(",");
    if (comma > 0) line = line.slice(0, comma);
    addCount(map, line, 1);
  });
  return { map, skipped, hull: hullName, name: fitName };
}

/** Hangar list view copy (tab separated), or "Name x3" / "3 Name" lines. */
export function parseInv(text: string): CountMap {
  const map = newCountMap();
  text.split(/\r?\n/).forEach((raw) => {
    if (!raw.trim() || raw.length > MAX_LINE) return;
    if (raw.indexOf("\t") >= 0) {
      const p = raw.split("\t");
      const q = qtyOf(p[1]);
      addCount(map, p[0], Number.isNaN(q) ? 1 : q);
      return;
    }
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(.*?)\s+x\s?([\d,.]+)$/i))) {
      addCount(map, m[1], qtyOf(m[2]));
      return;
    }
    if ((m = line.match(/^([\d,.]+)\s*x?\s+(.+)$/i))) {
      addCount(map, m[2], qtyOf(m[1]));
      return;
    }
    addCount(map, line, 1);
  });
  return map;
}

/** number (ISK), 0 = no sell orders, null = not loaded yet, false = name not found. */
export type PriceState = number | null | false;

/** Type id for a name: 0 when unknown or not found. Never reads inherited keys ("constructor"). */
export function idOf(cache: PriceCache, name: string): number {
  const k = name.toLowerCase();
  const id = Object.hasOwn(cache.ids, k) ? cache.ids[k] : 0;
  return typeof id === "number" && id > 0 ? id : 0;
}

export function priceOf(cache: PriceCache, name: string): PriceState {
  if (!Object.hasOwn(cache.ids, name.toLowerCase())) return null;
  const id = idOf(cache, name);
  if (!id) return false;
  const p = cache.prices[id];
  return p ? p.p : null;
}

export function typeIdOf(cache: PriceCache, name: string): number | null {
  const id = idOf(cache, name);
  return id ? id : null;
}

export function volOf(cache: PriceCache, name: string): number | null {
  const id = idOf(cache, name);
  return id && typeof cache.vol[id] === "number" ? cache.vol[id] : null;
}

export function m3(v: number | null): string {
  if (v == null) return "–";
  return v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : v < 100 ? 1 : 0 }) + " m³";
}

export function isk(v: number | null | false): string {
  if (v == null || v === false) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "b";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "m";
  if (a >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return v.toFixed(a < 10 ? 2 : 0);
}

export const fmtCount = (v: number) => v.toLocaleString("en-US");

export interface FitSummary {
  id: string;
  title: string;
  subtitle: string;
  empty: boolean;
  qty: number;
  /** "1척 12.3m · 합계 24.6m" style text, empty when the card has no items. */
  costText: string;
}

export interface ShoppingRow {
  name: string;
  need: number;
  have: number;
  buy: number;
  price: PriceState;
  vol: number | null;
  typeId: number | null;
}

export interface ShoppingResult {
  fits: FitSummary[];
  rows: ShoppingRow[];
  buyRows: ShoppingRow[];
  buyCost: number;
  buyKnown: boolean;
  buyVol: number;
  volKnown: boolean;
  fitValueTotal: number;
  fitValueKnown: boolean;
  multibuy: string;
  notFound: string[];
  skipped: string[];
  /** Every item name that needs an id, price or volume. */
  names: string[];
}

export function computeShopping(fits: Fit[], inv: string, withHull: boolean, cache: PriceCache): ShoppingResult {
  const need = newCountMap();
  const skipped: string[] = [];
  let fitValueTotal = 0;
  let fitValueKnown = true;
  const summaries: FitSummary[] = [];

  fits.forEach((fit, idx) => {
    const p = parseFit(fit.text, withHull);
    const q = Math.max(0, Math.trunc(Number(fit.qty)) || 0);
    let one = 0;
    let known = true;
    let empty = true;
    Object.keys(p.map).forEach((k) => {
      empty = false;
      addCount(need, p.map[k].name, p.map[k].qty * q);
      const pr = priceOf(cache, p.map[k].name);
      if (typeof pr === "number") one += pr * p.map[k].qty;
      else known = false;
    });
    if (q === 0) Object.keys(p.map).forEach((k) => {
      if (!need[k]) need[k] = { name: p.map[k].name, qty: 0 };
    });
    p.skipped.forEach((s) => skipped.push(s));

    let costText = "";
    if (!empty) {
      const approx = known ? "" : "≈";
      costText = "1척 " + approx + isk(one);
      if (q !== 1) costText += " · 합계 " + approx + isk(one * q);
    }
    summaries.push({ id: fit.id, title: p.hull || "피팅 " + (idx + 1), subtitle: p.name, empty, qty: q, costText });
    fitValueTotal += one * q;
    if (!known && !empty) fitValueKnown = false;
  });

  const have = parseInv(inv);
  const rows: ShoppingRow[] = Object.keys(need).map((k) => {
    const nq = need[k].qty;
    const h = have[k] ? have[k].qty : 0;
    return {
      name: need[k].name,
      need: nq,
      have: h,
      buy: Math.max(0, nq - h),
      price: priceOf(cache, need[k].name),
      vol: volOf(cache, need[k].name),
      typeId: typeIdOf(cache, need[k].name),
    };
  });
  rows.sort((a, b) =>
    (Number(b.buy > 0) - Number(a.buy > 0)) ||
    ((typeof b.price === "number" ? b.price * b.buy : 0) - (typeof a.price === "number" ? a.price * a.buy : 0)) ||
    a.name.localeCompare(b.name),
  );

  const buyRows = rows.filter((r) => r.buy > 0);
  let buyCost = 0;
  let buyKnown = true;
  buyRows.forEach((r) => {
    if (typeof r.price === "number") buyCost += r.price * r.buy;
    else buyKnown = false;
  });
  let buyVol = 0;
  let volKnown = true;
  buyRows.forEach((r) => {
    if (r.vol != null) buyVol += r.vol * r.buy;
    else volKnown = false;
  });

  const notFound: string[] = [];
  rows.forEach((r) => {
    if (r.price === false && notFound.indexOf(r.name) < 0) notFound.push(r.name);
  });

  return {
    fits: summaries,
    rows,
    buyRows,
    buyCost,
    buyKnown,
    buyVol,
    volKnown,
    fitValueTotal,
    fitValueKnown,
    multibuy: buyRows.map((r) => r.name + "\t" + r.buy).join("\n"),
    notFound,
    skipped,
    names: rows.map((r) => r.name),
  };
}

/** The seven table cells exactly as the original page printed them. */
export function rowCells(r: ShoppingRow): [string, string, string, string, string, string, string] {
  let unit: string;
  let total: string;
  if (r.price === false) {
    unit = "이름 확인";
    total = "–";
  } else if (r.price === null) {
    unit = "…";
    total = "–";
  } else if (r.price === 0) {
    unit = "매물 없음";
    total = "–";
  } else {
    unit = isk(r.price);
    total = r.buy ? isk(r.price * r.buy) : "–";
  }
  return [
    r.name,
    fmtCount(r.need),
    fmtCount(r.have),
    r.buy ? fmtCount(r.buy) : "충분",
    unit,
    total,
    r.buy && r.vol != null ? m3(r.vol * r.buy) : "–",
  ];
}

export interface SummaryText {
  need: string;
  buy: string;
  cost: string;
  total: string;
  vol: string;
}

export function summaryText(s: ShoppingResult): SummaryText {
  const n = s.buyRows.length;
  return {
    need: String(s.rows.length),
    buy: String(n),
    cost: n ? (s.buyKnown ? "" : "≈") + isk(s.buyCost) : "0",
    total: s.rows.length ? (s.fitValueKnown ? "" : "≈") + isk(s.fitValueTotal) : "–",
    vol: n ? (s.volKnown ? "" : "≈") + m3(s.buyVol) : "0 m³",
  };
}

/** True when any listed name still needs an id, a fresh price or a volume. */
export function needsFetch(cache: PriceCache, names: string[], now: number, ttl: number): boolean {
  return names.some((nm) => {
    const k = nm.toLowerCase();
    if (!Object.hasOwn(cache.ids, k)) return true;
    const id = idOf(cache, nm);
    return !!id && (!cache.prices[id] || now - cache.prices[id].t > ttl || typeof cache.vol[id] !== "number");
  });
}

export const EXAMPLE_FITS: ReadonlyArray<{ qty: number; text: string }> = [
  {
    qty: 2,
    text: [
      "[Ferox, Fleet Ferox]",
      "Damage Control II",
      "Magnetic Field Stabilizer II",
      "Magnetic Field Stabilizer II",
      "Power Diagnostic System II",
      "",
      "50MN Microwarpdrive II",
      "Large Shield Extender II",
      "Large Shield Extender II",
      "Multispectrum Shield Hardener II",
      "",
      "250mm Railgun II, Caldari Navy Antimatter Charge M",
      "250mm Railgun II, Caldari Navy Antimatter Charge M",
      "250mm Railgun II, Caldari Navy Antimatter Charge M",
      "250mm Railgun II, Caldari Navy Antimatter Charge M",
      "250mm Railgun II, Caldari Navy Antimatter Charge M",
      "",
      "Medium Core Defense Field Extender I",
      "Medium Core Defense Field Extender I",
      "Medium Core Defense Field Extender I",
      "",
      "",
      "Caldari Navy Antimatter Charge M x2000",
      "Spike M x1000",
      "Nanite Repair Paste x50",
    ].join("\n"),
  },
  {
    qty: 10,
    text: [
      "[Slasher, Fleet Tackle]",
      "Nanofiber Internal Structure II",
      "Overdrive Injector System II",
      "",
      "5MN Microwarpdrive II",
      "Warp Scrambler II",
      "Stasis Webifier II",
      "",
      "125mm Gatling AutoCannon II, Republic Fleet EMP S",
      "125mm Gatling AutoCannon II, Republic Fleet EMP S",
      "",
      "Small Polycarbon Engine Housing I",
      "Small Polycarbon Engine Housing I",
      "",
      "",
      "Republic Fleet EMP S x500",
    ].join("\n"),
  },
];

export const EXAMPLE_INV = [
  "250mm Railgun II\t4\tHybrid Weapon\t\t\t20 m3",
  "Damage Control II\t3\tDamage Control\t\t\t15 m3",
  "Large Shield Extender II\t2\tShield Extender\t\t\t20 m3",
  "Magnetic Field Stabilizer II\t1\tMagnetic Field Stabilizer\t\t\t5 m3",
  "Caldari Navy Antimatter Charge M\t1,200\tHybrid Charge\t\t\t12 m3",
  "Nanite Repair Paste\t80\tNanite Repair Paste\t\t\t0.8 m3",
  "Warp Scrambler II\t6\tWarp Scrambler\t\t\t30 m3",
  "Stasis Webifier II\t10\tStasis Web\t\t\t50 m3",
  "Ferox\t\tCombat Battlecruiser\t\t\t15,000 m3",
  "Slasher\t4\tFrigate\t\t\t10,000 m3",
].join("\n");
