import { describe, expect, it } from "vitest";
import { evalJSON, loadLegacy } from "./legacy";
import {
  DEFAULT_FARM,
  DEFAULT_PRICES,
  buildRankings,
  computeFarm,
  isUsableAggregates,
  pickQuote,
  type FarmInputs,
  type Prices,
  type RankRow,
  type SelfFundedRoutes,
  type SteamLive,
} from "../src/lib/plex";

interface LegacyRow {
  label: string;
  val: number;
  note: string;
  disp?: string | null;
}

/** What the original page computed for its three ranking tables. */
function legacyRanks(setup: string): { isk: LegacyRow[]; sp: LegacyRow[]; omega: LegacyRow[] } {
  const dom = loadLegacy("plex.html");
  if (setup) dom.window.eval(setup + "; recalc();");
  const r = evalJSON<Record<string, { rows: LegacyRow[] }>>(dom, "RANK");
  dom.window.close();
  // Guard against both sides being empty: the original always ranks every store.
  expect(r.rankISK.rows.length).toBeGreaterThanOrEqual(2);
  expect(r.rankSP.rows.length).toBe(11);
  expect(r.rankOmega.rows.length).toBeGreaterThanOrEqual(15);
  return { isk: r.rankISK.rows, sp: r.rankSP.rows, omega: r.rankOmega.rows };
}

const strip = (rows: RankRow[]) => rows.map(({ label, val, note, disp }) => ({ label, val, note, disp: disp ?? null }));
// The new page drops the original's "(라이브)" marker on live Steam prices (the band footnote says they are live).
const unlive = (note: string) => note.replace(/ ?\(라이브\)$/, "");
const strip2 = (rows: LegacyRow[]) => rows.map(({ label, val, note, disp }) => ({ label, val, note: unlive(note), disp: disp ?? null }));

function ported(
  prices: Prices,
  farm: FarmInputs,
  usdKrw: number,
  injectorSp: number,
  steamLive: SteamLive | null,
  selfFunded?: SelfFundedRoutes,
) {
  return buildRankings(computeFarm(prices, farm), farm, { usdKrw, injectorSp, steamLive, selfFunded });
}

describe("PLEX rankings match the original page", () => {
  it("with the built-in reference prices", () => {
    const legacy = legacyRanks("");
    const now = ported(DEFAULT_PRICES, DEFAULT_FARM, 1545, 400000, null);
    expect(strip(now.isk)).toEqual(strip2(legacy.isk));
    expect(strip(now.sp)).toEqual(strip2(legacy.sp));
    expect(strip(now.omega)).toEqual(strip2(legacy.omega));
  });

  it("with live quotes, Steam sale prices, another exchange rate and SP bracket", () => {
    const steam: SteamLive = {
      "1": { final: 26200, initial: 26200, disc: 0 },
      "6": { final: 77028, initial: 110040, disc: 30 },
      "24": { final: 259380, initial: 345840, disc: 25 },
    };
    const legacy = legacyRanks(
      `$("pxPLEX").value=4927000; $("pxLSI").value=680100000; $("pxEXT").value=477100000;` +
        `$("iUsdKrw").value="1388"; $("iOwnedSp").value="150000"; STEAM_LIVE=${JSON.stringify(steam)}`,
    );
    const now = ported({ plex: 4927000, lsi: 680100000, ext: 477100000 }, DEFAULT_FARM, 1388, 150000, steam);
    expect(strip(now.isk)).toEqual(strip2(legacy.isk));
    expect(strip(now.sp)).toEqual(strip2(legacy.sp));
    expect(strip(now.omega)).toEqual(strip2(legacy.omega));
  });

  it("with changed skill-farm assumptions and a booster", () => {
    const farm: FarmInputs = {
      ...DEFAULT_FARM,
      budget: 5000,
      mctCount: 0,
      farmMonths: 12,
      boosterOn: true,
      boosterMul: 1.15,
      floorSp: 2000000,
      spPerLsi: 450000,
      taxPercent: 4.5,
      nesQty: 25,
      nesPlex: 9000,
    };
    const legacy = legacyRanks(
      `$("iBudget").value=5000; $("iMct").value=0; $("iFarmM").value=12; $("iBooster").value="1";` +
        `$("iBoostMul").value=1.15; $("iFloor").value=2000000; $("iSpLsi").value=450000; $("iTax").value=4.5;` +
        `$("iNesQty").value=25; $("iNesPlex").value=9000`,
    );
    const now = ported(DEFAULT_PRICES, farm, 1545, 400000, null);
    expect(strip(now.isk)).toEqual(strip2(legacy.isk));
    expect(strip(now.sp)).toEqual(strip2(legacy.sp));
    expect(strip(now.omega)).toEqual(strip2(legacy.omega));
  });

  it("when skill farming pays for Omega by itself", () => {
    const legacy = legacyRanks(`$("pxLSI").value=1500000000`);
    const now = ported({ ...DEFAULT_PRICES, lsi: 1500000000 }, DEFAULT_FARM, 1545, 400000, null);
    expect(strip(now.omega)).toEqual(strip2(legacy.omega));
    expect(now.omega[0].disp).toMatch(/^이득 ₩/);
  });

  it.each([
    ["only the keep-training route", false, true],
    ["only the extract route", true, false],
    ["neither self-funded route", false, false],
  ])("with %s shown", (_name, extract, keepTraining) => {
    const legacy = legacyRanks(`$("showSfExtract").checked=${extract}; $("showSfKeepTraining").checked=${keepTraining}`);
    const now = ported(DEFAULT_PRICES, DEFAULT_FARM, 1545, 400000, null, { extract, keepTraining });
    expect(strip(now.omega)).toEqual(strip2(legacy.omega));
    expect(now.omega.some((r) => r.id === "self-funded-omega")).toBe(extract);
    expect(now.omega.some((r) => r.id === "self-funded-omega-keep")).toBe(keepTraining);
  });
});

describe("quote helpers", () => {
  const agg = { "44992": { buy: { max: "4713000.5", min: "1" }, sell: { min: "4800000" } } };

  it("reads side.field values", () => {
    expect(pickQuote(agg["44992"], "buy.max")).toBe(4713000.5);
    expect(pickQuote(agg["44992"], "sell.min")).toBe(4800000);
    expect(pickQuote(agg["44992"], "sell.median")).toBeNull();
    expect(pickQuote(null, "buy.max")).toBeNull();
  });

  it("rejects payloads without a positive PLEX bid", () => {
    expect(isUsableAggregates(agg)).toBe(true);
    expect(isUsableAggregates({})).toBe(false);
    expect(isUsableAggregates({ "44992": { buy: { max: "0" }, sell: {} } })).toBe(false);
    expect(isUsableAggregates("<html>")).toBe(false);
    expect(isUsableAggregates(null)).toBe(false);
  });
});
