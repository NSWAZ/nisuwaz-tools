/** Thousands separators, rounded to an integer. Non-finite values render as "-". */
export function comma(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString("en-US");
}

/** Korean won with a "₩ " prefix. Zero, negative and non-finite values render as "-". */
export function fmtKRW(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "-";
  return "₩ " + Math.round(v).toLocaleString("ko-KR");
}

/** Short ISK for headline figures: 4,927,000 → "4.93M", 680,100,000 → "680.1M". */
export function shortIsk(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "-";
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e8 ? 1 : 2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(Math.round(v));
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "15:04" in the viewer's local time. */
export function clock(d: Date): string {
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** "15:04" today, "11/17 09:05" on any other local day. */
export function stamp(d: Date, now: Date = new Date()): string {
  return d.toDateString() === now.toDateString() ? clock(d) : `${d.getMonth() + 1}/${d.getDate()} ${clock(d)}`;
}

/** The server refreshes market data every 5 minutes; six missed rounds means it stopped. */
export const STALE_MS = 30 * 60 * 1000;

export function isStale(d: Date, now: Date = new Date(), maxAge = STALE_MS): boolean {
  return now.getTime() - d.getTime() > maxAge;
}

/** "45분 전", "5시간 전", "3일 전". */
export function ago(d: Date, now: Date = new Date()): string {
  const min = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 60000));
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}
