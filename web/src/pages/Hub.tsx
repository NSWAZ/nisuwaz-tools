import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { GATES, PLANNED, TOOLS, TOOL_BY_ID, type ToolDef } from "../tools";
import { Icon } from "../components/Icon";
import { SiteFooter, Starfield, makeStars } from "../components/ToolFrame";
import { centerOf, linkProps, navigate, useDocumentTitle, useMediaQuery } from "../lib/router";

// Chart coordinates: a 16:9 sheet, 1600 × 900 units; tools sit at percentages of it.
const W = 1600;
const H = 900;
const COLS = 10;
const ROWS = 5;
const at = (p: { x: number; y: number }) => ({ x: (p.x / 100) * W, y: (p.y / 100) * H });
const point = (end: ToolDef["id"] | number) => at(typeof end === "number" ? PLANNED[end] : TOOL_BY_ID[end]);

// The region border: a loose dashed hull around the charted systems.
const REGION = "M200 790 L320 560 L520 380 L760 280 L1050 160 L1230 100 L1340 300 L1330 620 L1060 700 L760 790 L460 830 Z";

function ChartArt({ lit }: { lit: ToolDef["id"] | null }) {
  const stars = useMemo(() => makeStars(260, 42, W, H), []);
  return (
    <svg className="chart-art" viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <g className="graticule">
        {Array.from({ length: COLS - 1 }, (_, i) => (
          <line key={"v" + i} x1={(i + 1) * (W / COLS)} y1={0} x2={(i + 1) * (W / COLS)} y2={H} />
        ))}
        {Array.from({ length: ROWS - 1 }, (_, i) => (
          <line key={"h" + i} x1={0} y1={(i + 1) * (H / ROWS)} x2={W} y2={(i + 1) * (H / ROWS)} />
        ))}
      </g>
      <g className="ticks">
        {Array.from({ length: COLS * 4 + 1 }, (_, i) => {
          const x = i * (W / (COLS * 4));
          const len = i % 4 === 0 ? 14 : 6;
          return <path key={"t" + i} d={`M${x} 0v${len}M${x} ${H}v-${len}`} />;
        })}
        {Array.from({ length: ROWS * 4 + 1 }, (_, i) => {
          const y = i * (H / (ROWS * 4));
          const len = i % 4 === 0 ? 14 : 6;
          return <path key={"s" + i} d={`M0 ${y}h${len}M${W} ${y}h-${len}`} />;
        })}
      </g>
      <g className="grid-labels">
        {Array.from({ length: COLS }, (_, i) => (
          <text key={"c" + i} x={(i + 0.5) * (W / COLS)} y={H - 18} textAnchor="middle">
            {String.fromCharCode(65 + i)}
          </text>
        ))}
        {Array.from({ length: ROWS }, (_, i) => (
          <text key={"r" + i} x={W - 22} y={(i + 0.5) * (H / ROWS) + 5} textAnchor="end">
            {i + 1}
          </text>
        ))}
      </g>
      <g className="stars">
        {stars
          .filter((_, i) => i % 3 !== 0)
          .map((s, i) => (
            <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={s.r.toFixed(2)} opacity={s.o.toFixed(2)} />
          ))}
      </g>
      {/* Same twinkle beats as the page sky: every third star, drawn brighter, in five out-of-step groups. */}
      {Array.from({ length: 5 }, (_, g) => (
        <g key={"tw" + g} className={`stars twinkle tw-${g}`}>
          {stars
            .filter((_, i) => i % 3 === 0 && (i / 3) % 5 === g)
            .map((s, i) => (
              <circle key={i} cx={s.x.toFixed(1)} cy={s.y.toFixed(1)} r={(Math.max(s.r, 0.9) * 1.35).toFixed(2)} />
            ))}
        </g>
      ))}
      <defs>
        <linearGradient id="chart-meteor-tail" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="170" y2="0">
          <stop offset="0" stopColor="#dfe8ff" stopOpacity="0" />
          <stop offset="1" stopColor="#f4f8ff" stopOpacity="1" />
        </linearGradient>
      </defs>
      <g transform="translate(1450 60) rotate(160)">
        <line className="meteor meteor-c" x1="0" y1="0" x2="170" y2="0" stroke="url(#chart-meteor-tail)" strokeWidth="2.2" strokeLinecap="round" />
      </g>
      <path className="region" d={REGION} />
      <g className="gates">
        {GATES.map(([a, b], i) => {
          const p = point(a);
          const q = point(b);
          const planned = typeof a === "number" || typeof b === "number";
          const on = lit !== null && (a === lit || b === lit);
          return (
            <line
              key={i}
              className={"gate" + (planned ? " planned" : "") + (on ? " lit" : "")}
              x1={p.x}
              y1={p.y}
              x2={q.x}
              y2={q.y}
              pathLength={1}
              style={{ "--i": i } as CSSProperties}
            />
          );
        })}
      </g>
      <g className="planned-slots">
        {PLANNED.map((p, i) => {
          const c = at(p);
          return <circle key={i} cx={c.x} cy={c.y} r={11} />;
        })}
      </g>
    </svg>
  );
}

export default function Hub() {
  useDocumentTitle("니수와즈 도구 모음");
  const narrow = useMediaQuery("(max-width: 760px)");
  const [lit, setLit] = useState<ToolDef["id"] | null>(null);
  const dots = useRef<Partial<Record<ToolDef["id"], HTMLSpanElement | null>>>({});

  // Number keys jump straight into a tool, zooming out of its system.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const tool = TOOLS.find((t) => t.key === e.key);
      if (!tool) return;
      e.preventDefault();
      navigate(tool.path, { transition: "into", origin: centerOf(dots.current[tool.id] ?? null) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="hub">
      <Starfield />
      <main className="atlas">
        <div className="chart-wrap">
          <header className="atlas-head">
            <h1 id="page-title" tabIndex={-1}>
              니수와즈 도구 모음
            </h1>
            <p>
              EVE 하면서 자주 하는 계산, 한국어로 빠르게.{" "}
              <span className="kbd-hint">항성계를 누르거나 숫자 키로 바로 들어가세요.</span>
            </p>
          </header>
          <div className="chart">
            <ChartArt lit={lit} />
            <ul className="systems" aria-label={narrow ? undefined : "도구"} aria-hidden={narrow || undefined}>
              {TOOLS.map((t, i) => (
                <li
                  key={t.id}
                  className="system-item"
                  style={{ "--x": `${t.x}%`, "--y": `${t.y}%`, "--sec": t.sec, "--i": i } as CSSProperties}
                >
                  <a
                    className="system"
                    tabIndex={narrow ? -1 : undefined}
                    onMouseEnter={() => setLit(t.id)}
                    onMouseLeave={() => setLit(null)}
                    onFocus={() => setLit(t.id)}
                    onBlur={() => setLit(null)}
                    {...linkProps(t.path, () => ({ transition: "into", origin: centerOf(dots.current[t.id] ?? null) }))}
                  >
                    <span
                      className="sys-dot"
                      ref={(el) => {
                        dots.current[t.id] = el;
                      }}
                      aria-hidden="true"
                    />
                    <span className="sys-meta" aria-hidden="true">
                      <span>{t.secLabel}</span>
                      <kbd>{t.key}</kbd>
                    </span>
                    <span className="sys-name">{t.short}</span>
                    <span className="sys-desc">{t.desc}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {narrow && (
          <nav className="tool-list" aria-label="도구">
            <ul>
              {TOOLS.map((t) => (
                <li key={t.id} style={{ "--sec": t.sec } as CSSProperties}>
                  <a {...linkProps(t.path, { transition: "into" })}>
                    <img src={t.icon} alt="" width={48} height={48} />
                    <span className="tl-text">
                      <span className="tl-name">{t.name}</span>
                      <span className="tl-desc">{t.desc}</span>
                    </span>
                    <Icon name="chevron-right" />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
