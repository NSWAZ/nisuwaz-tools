/* One stroke family (1.75 at 20px) for every UI glyph; no Unicode stand-ins. */
const PATHS = {
  "arrow-left": "M12.5 4.5 7 10l5.5 5.5M7.5 10H17",
  "chevron-down": "m5 7.5 5 5 5-5",
  "chevron-right": "m7.5 5 5 5-5 5",
  refresh: "M16 10a6 6 0 1 1-1.76-4.24M16 3.5V7h-3.5",
  copy: "M7.5 7.5V4.75c0-.69.56-1.25 1.25-1.25h6.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H12.5M3.5 8.75c0-.69.56-1.25 1.25-1.25h6.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25z",
  check: "m4.5 10.5 3.5 3.5 7.5-8",
  plus: "M10 4.5v11M4.5 10h11",
  minus: "M4.5 10h11",
  close: "m5.5 5.5 9 9m0-9-9 9",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
