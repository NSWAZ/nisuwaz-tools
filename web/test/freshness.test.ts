import { describe, expect, it, vi } from "vitest";
import { ago, isStale, stamp, STALE_MS } from "../src/lib/format";
import { isSteamLive, loadItemPrices } from "../src/lib/market";
import { idOf, needsFetch, priceOf, type PriceCache } from "../src/lib/fridge";

const at = (s: string) => new Date(s);

describe("stamp", () => {
  it("shows only the time on the same local day", () => {
    expect(stamp(at("2026-11-19T16:08:00"), at("2026-11-19T18:00:00"))).toBe("16:08");
  });
  it("adds the date when the day differs", () => {
    expect(stamp(at("2026-11-17T09:05:00"), at("2026-11-19T18:00:00"))).toBe("11/17 09:05");
  });
});

describe("ago / isStale", () => {
  const now = at("2026-11-19T18:00:00");
  it("is fresh within the stale window", () => {
    expect(isStale(new Date(now.getTime() - STALE_MS + 1000), now)).toBe(false);
  });
  it("is stale past the window", () => {
    expect(isStale(new Date(now.getTime() - STALE_MS - 1000), now)).toBe(true);
  });
  it("speaks in minutes, hours, then days", () => {
    expect(ago(at("2026-11-19T17:15:00"), now)).toBe("45분 전");
    expect(ago(at("2026-11-19T13:00:00"), now)).toBe("5시간 전");
    expect(ago(at("2026-11-16T18:00:00"), now)).toBe("3일 전");
  });
});

describe("isSteamLive", () => {
  it("accepts positive final prices", () => {
    expect(isSteamLive({ "1": { final: 26200, initial: 26200, disc: 0 } })).toBe(true);
  });
  it("rejects zero, negative or non-finite prices", () => {
    for (const final of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isSteamLive({ "1": { final, initial: 26200, disc: 0 } })).toBe(false);
    }
  });
});

describe("needsFetch with prototype-like names", () => {
  it("treats names such as 'constructor' as unknown, not cached", () => {
    const cache: PriceCache = { ids: {}, prices: {}, vol: {} };
    expect(needsFetch(cache, ["constructor"], 0, 1000)).toBe(true);
    expect(needsFetch(cache, ["toString"], 0, 1000)).toBe(true);
  });
  it("idOf never returns inherited values", () => {
    const cache: PriceCache = { ids: { ferox: 37460 }, prices: {}, vol: {} };
    expect(idOf(cache, "Ferox")).toBe(37460);
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(idOf(cache, name)).toBe(0);
    expect(priceOf(cache, "__proto__")).toBe(null);
  });
  it("a '__proto__' line resolves once instead of refetching forever", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    try {
      const res = await loadItemPrices(["__proto__", "constructor"], { ids: {}, prices: {}, vol: {} }, false, 0);
      expect(res.ok).toBe(true);
      expect(needsFetch(res.cache, ["__proto__", "constructor"], 0, 1000)).toBe(false);
      expect(priceOf(res.cache, "__proto__")).toBe(false);
      expect(calls.every((u) => u.startsWith("https://esi.evetech.net/"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
