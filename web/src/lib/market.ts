/*
 * Network access. PLEX quotes and Steam Omega prices come from same-origin files
 * the server refreshes every few minutes (/aggregates, /steamomega); their age is
 * the file's Last-Modified time. The 냉장고 계산기 calls ESI and Fuzzwork directly,
 * as the original page did (both allow cross-origin requests).
 */
import { isUsableAggregates, type Aggregates, type SteamLive } from "./plex";
import { idOf, type PriceCache } from "./fridge";

export interface Snapshot<T> {
  data: T;
  /** When the server fetched it (Last-Modified), if known. */
  fetchedAt: Date | null;
}

async function getSnapshot<T>(url: string, ok: (d: unknown) => d is T, signal?: AbortSignal): Promise<Snapshot<T>> {
  const res = await fetch(url, { cache: "no-cache", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!ok(data)) throw new Error("unexpected payload");
  const lm = res.headers.get("Last-Modified");
  const at = lm ? new Date(lm) : null;
  return { data, fetchedAt: at && !Number.isNaN(at.getTime()) ? at : null };
}

export function fetchAggregates(signal?: AbortSignal): Promise<Snapshot<Aggregates>> {
  return getSnapshot("/aggregates", isUsableAggregates, signal);
}

export function isSteamLive(d: unknown): d is SteamLive {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const vals = Object.values(d as Record<string, unknown>);
  return (
    vals.length > 0 &&
    vals.every((v) => {
      const final = !!v && typeof v === "object" ? (v as { final?: unknown }).final : undefined;
      return typeof final === "number" && Number.isFinite(final) && final > 0;
    })
  );
}

export function fetchSteamOmega(signal?: AbortSignal): Promise<Snapshot<SteamLive>> {
  return getSnapshot("/steamomega", isSteamLive, signal);
}

// ---- 냉장고 계산기 ----
const ESI_IDS = "https://esi.evetech.net/latest/universe/ids/?datasource=tranquility&language=en";
const ESI_TYPE = "https://esi.evetech.net/latest/universe/types/";
const FUZZ = "https://market.fuzzwork.co.uk/aggregates/?station=60003760&types=";
export const PRICE_TTL = 30 * 60 * 1000;

export const itemIconUrl = (typeId: number) => `https://images.evetech.net/types/${typeId}/icon?size=32`;

async function postJSON(url: string, body: unknown): Promise<{ inventory_types?: Array<{ id: number; name: string }> }> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 404) return {};
  if (!r.ok) throw new Error("ESI " + r.status);
  return r.json();
}

async function loadVolumes(ids: number[], cache: PriceCache): Promise<void> {
  const todo = ids.filter((id) => typeof cache.vol[id] !== "number");
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const id = todo[i++];
      try {
        const r = await fetch(ESI_TYPE + id + "/?datasource=tranquility&language=en");
        if (!r.ok) continue;
        const d = (await r.json()) as { packaged_volume?: unknown; volume?: unknown };
        const v = typeof d.packaged_volume === "number" ? d.packaged_volume : d.volume;
        if (typeof v === "number") cache.vol[id] = v;
      } catch {
        /* volume stays unknown; the page shows ≈ */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, worker));
}

export interface PriceLoad {
  cache: PriceCache;
  ok: boolean;
}

/**
 * Resolve names to type ids, refresh stale Jita sell prices and fill packaged
 * volumes. Works on a copy; on failure the copy still carries what did load.
 */
export async function loadItemPrices(names: string[], base: PriceCache, force: boolean, now = Date.now()): Promise<PriceLoad> {
  const cache: PriceCache = { ids: { ...base.ids }, prices: { ...base.prices }, vol: { ...base.vol } };
  try {
    const unknown = names.filter((n) => {
      const k = n.toLowerCase();
      return !Object.hasOwn(cache.ids, k) || (force && !cache.ids[k]);
    });
    for (let i = 0; i < unknown.length; i += 250) {
      const chunk = unknown.slice(i, i + 250);
      const data = await postJSON(ESI_IDS, chunk);
      const found = new Map<string, number>();
      (data.inventory_types || []).forEach((t) => {
        if (typeof t.id === "number") found.set(t.name.toLowerCase(), t.id);
      });
      chunk.forEach((n) => {
        // defineProperty, not `=`: assigning "__proto__" would not create an own key.
        Object.defineProperty(cache.ids, n.toLowerCase(), {
          value: found.get(n.toLowerCase()) ?? 0,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      });
    }
    const seen = new Set<number>();
    const ids: number[] = [];
    names.forEach((n) => {
      const id = idOf(cache, n);
      if (id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    });
    const stale = ids.filter((id) => force || !cache.prices[id] || now - cache.prices[id].t > PRICE_TTL);
    for (let j = 0; j < stale.length; j += 100) {
      const part = stale.slice(j, j + 100);
      const r = await fetch(FUZZ + part.join(","));
      if (!r.ok) throw new Error("Fuzzwork " + r.status);
      const agg = (await r.json()) as Record<string, { sell?: { orderCount?: string; min?: string } } | undefined>;
      part.forEach((id) => {
        const d = agg[id];
        const p = d && d.sell && +(d.sell.orderCount ?? 0) > 0 ? +(d.sell.min ?? 0) : 0;
        cache.prices[id] = { p, t: now };
      });
    }
    await loadVolumes(ids, cache);
    return { cache, ok: true };
  } catch {
    return { cache, ok: false };
  }
}

/** Oldest fetch time among the given names' prices, or null when none are loaded. */
export function oldestPriceTime(cache: PriceCache, names: string[]): number | null {
  let oldest = Infinity;
  names.forEach((n) => {
    const id = idOf(cache, n);
    if (id && cache.prices[id]) oldest = Math.min(oldest, cache.prices[id].t);
  });
  return oldest === Infinity ? null : oldest;
}
