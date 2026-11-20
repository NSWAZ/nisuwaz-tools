import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";
import { linkProps, useDocumentTitle } from "../lib/router";
import type { ToolDef } from "../tools";

/** Deterministic pseudo-random stars so every visit draws the same sky. */
export function makeStars(count: number, seed: number, w: number, h: number) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => {
    const big = rnd() > 0.93;
    return { x: rnd() * w, y: rnd() * h, r: big ? 1.4 + rnd() * 0.8 : 0.5 + rnd() * 0.7, o: big ? 0.75 : 0.18 + rnd() * 0.45 };
  });
}

/** Twinkle groups: each animates its own opacity on a different beat, so scattered stars shimmer out of step. */
const TWINKLE_GROUPS = 5;

/**
 * A faint fixed sky behind every page. Some stars twinkle and a meteor crosses
 * now and then; both are CSS animations on a few groups (not per star) and stop
 * entirely under reduced motion.
 */
export function Starfield() {
  const stars = useMemo(() => makeStars(150, 7, 1600, 1000), []);
  const still = stars.filter((_, i) => i % 3 !== 0);
  const twinkling = stars.filter((_, i) => i % 3 === 0);
  const dot = (st: (typeof stars)[number], i: number) => (
    <circle key={i} cx={st.x.toFixed(1)} cy={st.y.toFixed(1)} r={st.r.toFixed(2)} opacity={st.o.toFixed(2)} />
  );
  return (
    <svg className="starfield" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="meteor-tail" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="170" y2="0">
          <stop offset="0" stopColor="#dfe8ff" stopOpacity="0" />
          <stop offset="1" stopColor="#f4f8ff" stopOpacity="1" />
        </linearGradient>
      </defs>
      <g className="sky">{still.map(dot)}</g>
      {Array.from({ length: TWINKLE_GROUPS }, (_, g) => (
        <g key={g} className={`sky twinkle tw-${g}`}>
          {twinkling.filter((_, i) => i % TWINKLE_GROUPS === g).map(dot)}
        </g>
      ))}
      {/* The tail fades toward the origin; each line flies along its own +x once per cycle. */}
      <g transform="translate(1520 30) rotate(168)">
        <line className="meteor meteor-a" x1="0" y1="0" x2="170" y2="0" stroke="url(#meteor-tail)" strokeWidth="2.2" strokeLinecap="round" />
      </g>
      <g transform="translate(820 18) rotate(164) scale(0.7)">
        <line className="meteor meteor-b" x1="0" y1="0" x2="170" y2="0" stroke="url(#meteor-tail)" strokeWidth="2.2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-foot">
      <p>EVE Online 관련 자료와 이름은 CCP hf.의 저작물입니다.</p>
    </footer>
  );
}

export function ToolFrame({ tool, children }: { tool: ToolDef; children: ReactNode }) {
  useDocumentTitle(`${tool.name} · 니수와즈 도구 모음`);
  return (
    <div className="tool-page" style={{ "--sec": tool.sec } as CSSProperties}>
      <Starfield />
      <header className="tool-head">
        <a className="back" {...linkProps("/", { transition: "back" })}>
          <Icon name="arrow-left" size={18} />
          성도로
        </a>
        <div className="tool-title">
          <h1 id="page-title" tabIndex={-1}>
            <span className="title-dot" aria-hidden="true" />
            {tool.name}
          </h1>
          <p>{tool.desc}</p>
        </div>
      </header>
      <main className="tool-main">{children}</main>
      <SiteFooter />
    </div>
  );
}
