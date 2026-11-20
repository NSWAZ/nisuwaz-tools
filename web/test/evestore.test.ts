import { describe, expect, it } from "vitest";
import { isEveStore } from "../src/lib/market";
import { DEFAULT_FARM, DEFAULT_PRICES, buildRankings, computeFarm, type EveStore } from "../src/lib/plex";

const STORE: EveStore = {
  omega: [
    { months: 24, plex: 0, price: 198, base: 264 },
    { months: 24, plex: 1500, price: 264, base: 329 },
    { months: 1, plex: 0, price: 15, base: 20 },
  ],
  plex: [{ qty: 20000, price: 600, base: 650 }],
  boosts: [
    { key: "undock", price: 12.5, base: 16 },
    { key: "jump", price: 192, base: 192 },
  ],
};

const rank = (store: EveStore | null) =>
  buildRankings(computeFarm(DEFAULT_PRICES, DEFAULT_FARM), DEFAULT_FARM, { usdKrw: 1500, injectorSp: 400000, steamLive: null, store });

describe("rankings with EVE web store prices", () => {
  it("prices the web PLEX channel from the store's 20k pack", () => {
    const web = rank(STORE).isk.find((r) => r.id === "web-plex-sell");
    const fixed = rank(null).isk.find((r) => r.id === "web-plex-sell");
    expect(web?.note).toContain("45원/PLEX"); // 600 × 1500 / 20000
    expect(fixed?.note).toContain("49원/PLEX"); // 649.99 × 1500 / 20000
  });

  it("keeps the cheapest offer per Omega length and drops lengths the store does not sell", () => {
    const r = rank(STORE);
    const kpp = r.wonPerPlex;
    const omega = Object.fromEntries(r.omega.filter((x) => x.id.startsWith("web-omega-")).map((x) => [x.id, x]));
    expect(Object.keys(omega).sort()).toEqual(["web-omega-1", "web-omega-24"]);
    const plain = (198 * 1500) / 24;
    const bonus = (264 * 1500 - 1500 * kpp) / 24;
    expect(omega["web-omega-24"].val).toBeCloseTo(Math.min(plain, bonus));
    expect(omega["web-omega-1"].note).toBe("$15 · 25% 세일");
  });

  it("lists only boost bundles on sale, with cents kept", () => {
    const bundles = rank(STORE).sp.filter((x) => x.id.startsWith("sp-bundle-"));
    expect(bundles.map((b) => b.label).sort()).toEqual(["EVE웹 언독 부스트 번들", "EVE웹 점프 부스트 번들"]);
    expect(bundles.find((b) => b.label.includes("언독"))?.note).toMatch(/^\$12\.50 \/ 648,000 SP · 22% 세일/);
  });

  it("skips an offer whose bonus PLEX outweighs its price instead of dropping the whole length", () => {
    const odd: EveStore = { ...STORE, omega: [...STORE.omega, { months: 24, plex: 1_000_000, price: 1, base: 1 }] };
    const row = rank(odd).omega.find((x) => x.id === "web-omega-24");
    expect(row?.val).toBeGreaterThan(0);
    expect(row?.val).toBeCloseTo(rank(STORE).omega.find((x) => x.id === "web-omega-24")!.val);
  });

  it("falls back to all built-in rows without store prices", () => {
    const r = rank(null);
    expect(r.omega.filter((x) => x.id.startsWith("web-omega-")).length).toBe(5);
    expect(r.sp.filter((x) => x.id.startsWith("sp-bundle-")).length).toBe(8);
  });
});

describe("isEveStore", () => {
  it("accepts the refresher's shape", () => {
    expect(isEveStore(STORE)).toBe(true);
  });
  it("rejects missing lists, empty Omega and bad numbers", () => {
    for (const bad of [
      null,
      [],
      {},
      { ...STORE, omega: [] },
      { ...STORE, plex: "x" },
      { ...STORE, omega: [{ months: 1, plex: 0, price: Number.NaN, base: 20 }] },
      { ...STORE, omega: [{ months: 1, plex: -5, price: 15, base: 20 }] },
      { ...STORE, boosts: [{ key: 1, price: 5, base: 5 }] },
      { ...STORE, plex: [null] },
    ]) {
      expect(isEveStore(bad)).toBe(false);
    }
  });
});
