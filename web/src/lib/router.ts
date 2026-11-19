/*
 * A three-route History API router. Moving from the star map into a tool zooms
 * the old page out of the clicked system with the View Transitions API where the
 * browser supports it; otherwise (or with reduced motion) the page simply swaps.
 */
import { useEffect, useState, useSyncExternalStore, type MouseEvent } from "react";
import { flushSync } from "react-dom";

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  window.addEventListener("popstate", l);
  return () => {
    listeners.delete(l);
    window.removeEventListener("popstate", l);
  };
}

export function normalizePath(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => normalizePath(window.location.pathname), () => "/");
}

export type Transition = "into" | "back" | "none";
export interface NavOptions {
  transition?: Transition;
  /** Viewport point the zoom grows from (the clicked star system). */
  origin?: { x: number; y: number };
}

type VTDocument = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> };
};

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function navigate(to: string, opts: NavOptions = {}): void {
  if (normalizePath(to) === normalizePath(window.location.pathname)) return;
  const go = () => {
    window.history.pushState(null, "", to);
    emit();
    window.scrollTo(0, 0);
  };
  const doc = document as VTDocument;
  if (!doc.startViewTransition || prefersReducedMotion() || opts.transition === "none") {
    go();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = opts.transition ?? "into";
  root.style.setProperty("--vt-x", opts.origin ? `${opts.origin.x}px` : "50%");
  root.style.setProperty("--vt-y", opts.origin ? `${opts.origin.y}px` : "35%");
  const t = doc.startViewTransition(() => flushSync(go));
  // `finished` rejects when the transition is skipped; the page has swapped either way.
  t.finished
    .catch(() => {})
    .finally(() => {
      delete root.dataset.vt;
    });
}

/** Center of an element in viewport coordinates. */
export function centerOf(el: Element | null): { x: number; y: number } | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** href + onClick for an in-app link; modified clicks still open normally. */
export function linkProps(to: string, opts: NavOptions | ((e: MouseEvent<HTMLAnchorElement>) => NavOptions) = {}) {
  return {
    href: to,
    onClick(e: MouseEvent<HTMLAnchorElement>) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to, typeof opts === "function" ? opts(e) : opts);
    },
  };
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function useMediaQuery(query: string): boolean {
  const get = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
