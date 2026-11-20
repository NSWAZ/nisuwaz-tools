/*
 * Runs one of the original single-file pages (test/legacy/*.html) in an isolated
 * jsdom window so tests can compare the ported logic with what users saw before.
 * Network access is stubbed to fail, so pages fall back to their built-in data.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

// vitest runs from web/ (npm test); the jsdom environment rewrites import.meta.url.
const LEGACY_DIR = resolve(process.cwd(), "test/legacy");

export function loadLegacy(file: "plex.html" | "fridge.html", storage: Record<string, string> = {}): JSDOM {
  const html = readFileSync(resolve(LEGACY_DIR, file), "utf8");
  return new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: false,
    beforeParse(window) {
      for (const [k, v] of Object.entries(storage)) window.localStorage.setItem(k, v);
      Object.defineProperty(window, "fetch", {
        value: () => Promise.reject(new Error("network disabled in tests")),
      });
    },
  });
}

/** Evaluate an expression inside the legacy page's global scope and return it as JSON. */
export function evalJSON<T>(dom: JSDOM, expr: string): T {
  const text = dom.window.eval(`JSON.stringify(${expr})`) as string;
  return JSON.parse(text) as T;
}
