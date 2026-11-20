import { describe, expect, it } from "vitest";
import { loadLegacy } from "./legacy";
import {
  EXAMPLE_FITS,
  EXAMPLE_INV,
  computeShopping,
  emptyCache,
  needsFetch,
  parseFit,
  parseInv,
  rowCells,
  summaryText,
  type Fit,
  type PriceCache,
} from "../src/lib/fridge";

// Synthetic ids, prices (ISK) and volumes (m³) for the example items.
// "Spike M" is left unknown (still loading), "Overdrive Injector System II" was not found
// by ESI (id 0), and "Small Polycarbon Engine Housing I" has no sell orders (price 0).
function exampleCache(now: number): PriceCache {
  const items: Array<[string, number, number, number]> = [
    ["Ferox", 101, 62_500_000, 15000],
    ["Damage Control II", 102, 412_000, 5],
    ["Magnetic Field Stabilizer II", 103, 1_230_000, 5],
    ["Power Diagnostic System II", 104, 980_000, 5],
    ["50MN Microwarpdrive II", 105, 3_400_000, 10],
    ["Large Shield Extender II", 106, 2_150_000, 10],
    ["Multispectrum Shield Hardener II", 107, 1_790_000, 5],
    ["250mm Railgun II", 108, 1_650_000, 10],
    ["Medium Core Defense Field Extender I", 109, 610_000, 10],
    ["Caldari Navy Antimatter Charge M", 110, 112.5, 0.0125],
    ["Nanite Repair Paste", 111, 24_300, 0.01],
    ["Slasher", 112, 410_000, 2500],
    ["Nanofiber Internal Structure II", 113, 640_000, 5],
    ["5MN Microwarpdrive II", 115, 1_120_000, 5],
    ["Warp Scrambler II", 116, 2_870_000, 5],
    ["Stasis Webifier II", 117, 1_340_000, 5],
    ["125mm Gatling AutoCannon II", 118, 560_000, 5],
    ["Small Polycarbon Engine Housing I", 119, 0, 5],
    ["Republic Fleet EMP S", 120, 42.75, 0.0025],
  ];
  const c = emptyCache();
  for (const [name, id, price, vol] of items) {
    c.ids[name.toLowerCase()] = id;
    c.prices[id] = { p: price, t: now };
    c.vol[id] = vol;
  }
  c.ids["overdrive injector system ii"] = 0;
  return c;
}

interface LegacyView {
  cells: string[][];
  stats: Record<string, string>;
  multibuy: string;
  fitNames: string[];
  fitCosts: string[];
  warnings: string;
}

function legacyView(state: object, cache: PriceCache): LegacyView {
  const dom = loadLegacy("fridge.html", {
    "eve-jita-shopping-v2": JSON.stringify(state),
    "eve-jita-cache-v2": JSON.stringify(cache),
  });
  const d = dom.window.document;
  const text = (id: string) => d.getElementById(id)!.textContent ?? "";
  const view: LegacyView = {
    cells: [...d.querySelectorAll("#rows tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent ?? "")),
    stats: { need: text("stNeed"), buy: text("stBuy"), cost: text("stCost"), total: text("stTotal"), vol: text("stVol") },
    multibuy: text("multibuy"),
    fitNames: [...d.querySelectorAll(".fit-name")].map((e) => e.textContent ?? ""),
    fitCosts: [...d.querySelectorAll(".fit-cost")].map((e) => e.textContent ?? ""),
    warnings: d.getElementById("warnings")!.hidden ? "" : text("warnings"),
  };
  dom.window.close();
  // Guard against both sides being empty: every scenario has several item rows.
  expect(view.cells.length).toBeGreaterThanOrEqual(5);
  expect(view.cells[0].length).toBe(7);
  return view;
}

function portedView(fits: Fit[], inv: string, hull: boolean, cache: PriceCache): LegacyView {
  const s = computeShopping(fits, inv, hull, cache);
  const w: string[] = [];
  if (s.notFound.length) w.push("아이템 이름을 못 찾음 (오타 확인): " + s.notFound.join(", "));
  if (s.skipped.length) w.push("읽지 못한 줄: " + s.skipped.join(", "));
  return {
    cells: s.rows.map((r) => [...rowCells(r)]),
    stats: { ...summaryText(s) },
    multibuy: s.multibuy || "(살 것 없음)",
    fitNames: s.fits.map((f) => f.title + f.subtitle),
    fitCosts: s.fits.map((f) => f.costText),
    warnings: w.join(" · "),
  };
}

const exampleFits = (): Fit[] => EXAMPLE_FITS.map((f, i) => ({ id: "f" + i, qty: f.qty, text: f.text }));

describe("냉장고 계산기 matches the original page", () => {
  const now = Date.now();

  it("for the example fits with partly known prices", () => {
    const fits = exampleFits();
    const cache = exampleCache(now);
    const state = { fits, inv: EXAMPLE_INV, hull: true, showAll: true, example: false };
    expect(portedView(fits, EXAMPLE_INV, true, cache)).toEqual(legacyView(state, cache));
  });

  it("without hulls, with an empty card, a zero-quantity card and an odd bracket line", () => {
    const fits: Fit[] = [
      { id: "a", qty: 0, text: EXAMPLE_FITS[1].text },
      { id: "b", qty: 3, text: "[Ferox, Brick]\n[Empty High slot]\n[Some Unknown Block]\nDamage Control II /offline\nNanite Repair Paste x1,000" },
      { id: "c", qty: 1, text: "" },
    ];
    const inv = "Damage Control II x2\n500 Nanite Repair Paste\nFerox";
    const cache = exampleCache(now);
    const state = { fits, inv, hull: false, showAll: true, example: false };
    expect(portedView(fits, inv, false, cache)).toEqual(legacyView(state, cache));
  });

  it("before any price is loaded", () => {
    const fits = exampleFits();
    const state = { fits, inv: "", hull: true, showAll: true, example: false };
    expect(portedView(fits, "", true, emptyCache())).toEqual(legacyView(state, emptyCache()));
  });
});

describe("parsing", () => {
  it("reads EFT fits, cargo counts and offline modules", () => {
    const p = parseFit("[Ferox, Fleet]\nDamage Control II /offline\n250mm Railgun II, Spike M\nSpike M x1,000", true);
    expect(p.hull).toBe("Ferox");
    expect(p.name).toBe("Fleet");
    expect(p.map["ferox"].qty).toBe(1);
    expect(p.map["damage control ii"].qty).toBe(1);
    expect(p.map["250mm railgun ii"].qty).toBe(1);
    expect(p.map["spike m"].qty).toBe(1000);
  });

  it("sums hangar rows across pasted hangars", () => {
    const inv = parseInv("Spike M\t1,200\tHybrid Charge\nSpike M\t300\tHybrid Charge\nWarp Scrambler II x2\n3 Slasher");
    expect(inv["spike m"].qty).toBe(1500);
    expect(inv["warp scrambler ii"].qty).toBe(2);
    expect(inv["slasher"].qty).toBe(3);
  });

  it("asks for prices only when something is missing or stale", () => {
    const c = exampleCache(1000);
    expect(needsFetch(c, ["Ferox"], 1000, 60_000)).toBe(false);
    expect(needsFetch(c, ["Ferox"], 1000 + 60_001, 60_000)).toBe(true);
    expect(needsFetch(c, ["Spike M"], 1000, 60_000)).toBe(true);
    expect(needsFetch(c, ["Overdrive Injector System II"], 1000, 60_000)).toBe(false);
  });
});
