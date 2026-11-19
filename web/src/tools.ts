/*
 * The tool registry. Each tool is a star system on the hub's map: x/y are
 * percentages of the 16:9 chart, `sec` is its identity colour from the EVE
 * security-status scale, `key` is the number key that opens it.
 * Adding a tool: add an entry here, a page in src/pages, and a route in App.tsx.
 */
export interface ToolDef {
  id: "plex" | "fridge";
  path: string;
  key: string;
  name: string;
  short: string;
  desc: string;
  sec: string;
  secLabel: string;
  icon: string;
  x: number;
  y: number;
}

export const TOOLS: readonly ToolDef[] = [
  {
    id: "plex",
    path: "/plex",
    key: "1",
    name: "PLEX 현질 효율 계산기",
    short: "PLEX 현질 효율",
    desc: "원화로 ISK·SP·오메가를 가장 싸게 얻는 길",
    sec: "var(--sec-10)",
    secLabel: "1.0",
    icon: "/icons/plex.png",
    x: 29,
    y: 63,
  },
  {
    id: "fridge",
    path: "/fridge",
    key: "2",
    name: "냉장고 계산기",
    short: "냉장고 계산기",
    desc: "피팅 × 척수 − 보유 = 지타에서 살 것",
    sec: "var(--sec-08)",
    secLabel: "0.8",
    icon: "/icons/fridge.png",
    x: 57,
    y: 39,
  },
];

export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ToolDef["id"], ToolDef>;

/** Empty systems where future tools will go. */
export const PLANNED: ReadonlyArray<{ x: number; y: number }> = [
  { x: 79, y: 62 },
  { x: 72, y: 16 },
  { x: 17, y: 84 },
];

/**
 * Gate connections: [from, to], each a tool id or a planned index. Labels sit to
 * the right of each system, so gates leave a tool only upward, leftward or down-left.
 */
export const GATES: ReadonlyArray<[ToolDef["id"] | number, ToolDef["id"] | number]> = [
  ["plex", "fridge"],
  ["fridge", 1],
  [1, 0],
  ["plex", 2],
];
