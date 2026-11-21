import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ToolFrame } from "../components/ToolFrame";
import { Icon } from "../components/Icon";
import { TOOL_BY_ID } from "../tools";
import { readJSON, writeJSON } from "../lib/storage";
import { fetchAggregates, fetchEveStore, fetchSteamOmega, type Snapshot } from "../lib/market";
import { ago, comma, fmtKRW, isStale, shortIsk, stamp } from "../lib/format";
import {
  DEFAULT_DIRECTION,
  DEFAULT_FARM,
  DEFAULT_PRICES,
  INJECTOR_TIERS,
  PRICE_KEYS,
  TYPES,
  buildRankings,
  computeFarm,
  pickQuote,
  type FarmInputs,
  type Prices,
  type Quote,
  type QuoteType,
  type EveStore,
  type RankRow,
  type SteamLive,
} from "../lib/plex";

const STORE_KEY = "nisuwaz-plex-v2";
const TOP = 5;

const QTYPES: QuoteType[] = ["PLEX", "LSI", "EXT"];
const PRICE_FIELD: Record<QuoteType, keyof Prices> = { PLEX: "plex", LSI: "lsi", EXT: "ext" };
const QINFO: Record<QuoteType, { name: string; short: string; role: string }> = {
  PLEX: { name: "PLEX", short: "PLEX", role: "적용 판매가" },
  LSI: { name: "Large Skill Injector", short: "LSI", role: "적용 판매가" },
  EXT: { name: "Skill Extractor", short: "익스트랙터", role: "적용 구매가" },
};

type Quotes = Record<QuoteType, Quote | null>;
interface Saved {
  quotes?: Partial<Quotes>;
  fetchedAt?: string | null;
  px?: Partial<Record<QuoteType, string | number>>;
  dir?: Partial<Record<QuoteType, string>>;
  usdKrw?: number;
  injectorSp?: number;
  farm?: Partial<FarmInputs>;
}

const VALID_DIR = new Set(PRICE_KEYS.map(([k]) => k));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function loadSaved() {
  const s = readJSON<Saved>(STORE_KEY) ?? {};
  const quotes: Quotes = { PLEX: s.quotes?.PLEX ?? null, LSI: s.quotes?.LSI ?? null, EXT: s.quotes?.EXT ?? null };
  const dir = { ...DEFAULT_DIRECTION };
  const prices = { ...DEFAULT_PRICES };
  for (const t of QTYPES) {
    const d = s.dir?.[t];
    if (d && VALID_DIR.has(d)) dir[t] = d;
    const p = parseFloat(String(s.px?.[t] ?? ""));
    if (p > 0) prices[PRICE_FIELD[t]] = p;
  }
  const farm = { ...DEFAULT_FARM };
  for (const [k, v] of Object.entries(s.farm ?? {})) {
    const key = k as keyof FarmInputs;
    if (key === "boosterOn") farm.boosterOn = v === true;
    else if (Object.hasOwn(DEFAULT_FARM, key) && finite(v)) (farm[key] as number) = v;
  }
  const at = s.fetchedAt ? new Date(s.fetchedAt) : null;
  return {
    quotes,
    dir,
    prices,
    farm,
    usdKrw: finite(s.usdKrw) && s.usdKrw > 0 ? s.usdKrw : 1545,
    injectorSp: INJECTOR_TIERS.some((t) => t.value === s.injectorSp) ? (s.injectorSp as number) : 400000,
    fetchedAt: at && !Number.isNaN(at.getTime()) ? at : null,
  };
}

type Status = "idle" | "loading" | "ok" | "error";

/** Number input that keeps what the user typed (e.g. "1.") while reporting a number. */
function NumberField(props: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  disabled?: boolean;
  suffix?: string;
}) {
  const { id, label, value, onChange, step, min, disabled, suffix } = props;
  const [text, setText] = useState(String(value));
  useEffect(() => {
    const parsed = parseFloat(text);
    if ((Number.isFinite(parsed) ? parsed : 0) !== value) setText(String(value));
  }, [value]); // only an outside change of `value` should overwrite what is typed
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="input-unit">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={text}
          step={step}
          min={min}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            onChange(Number.isFinite(v) ? v : 0);
          }}
        />
        {suffix && <span className="unit">{suffix}</span>}
      </div>
    </div>
  );
}

function Disclosure({ label, summary, children, defaultOpen = false }: { label: string; summary?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={"disclosure" + (open ? " open" : "")}>
      <button type="button" className="disclosure-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron-down" size={18} />
        <span className="d-label">{label}</span>
        {summary && <span className="d-summary">{summary}</span>}
      </button>
      <div id={id} className="disclosure-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}

function RankBand({
  id,
  title,
  sub,
  rows,
  footnote,
}: {
  id: string;
  title: string;
  sub: string;
  rows: RankRow[];
  /** One sentence, or several short notes shown as a list. */
  footnote?: string | string[];
}) {
  const [all, setAll] = useState(false);
  const listId = useId();
  const win = rows[0];
  const shown = all ? rows : rows.slice(0, TOP);
  const max = Math.max(...shown.map((r) => r.val), 1);
  const winGain = !!win?.disp;
  return (
    <section className="band" aria-labelledby={`${id}-h`}>
      <div className="band-q">
        <h2 id={`${id}-h`}>{title}</h2>
        <p className="band-sub">{sub}</p>
        {win ? (
          <div className="win">
            <p className="win-v num" key={win.disp ?? fmtKRW(win.val)}>
              {win.disp ?? fmtKRW(win.val)}
            </p>
            <p className="win-l">{win.label}</p>
            <p className="win-n">{win.note}</p>
          </div>
        ) : (
          <p className="win-empty">시세가 없어 계산할 수 없어요.</p>
        )}
      </div>
      <div className="band-routes">
        <ol className="routes" id={listId}>
          {shown.map((r, i) => {
            const w = r.disp ? 2 : Math.max(2, (r.val / max) * 100);
            const x = i === 0 ? "1위" : winGain ? "" : `×${(r.val / win.val).toFixed(2)}`;
            return (
              <li key={r.id} className={"route" + (i === 0 ? " is-win" : "")}>
                <span className="r-label">
                  <span className="rank num">{i + 1}</span>
                  <span className="r-name">{r.label}</span>
                </span>
                <span className="r-val num">{r.disp ?? fmtKRW(r.val)}</span>
                <span className="r-x num">{x}</span>
                <span className="track" aria-hidden="true">
                  <span style={{ "--w": `${w}%` } as CSSProperties} />
                </span>
                <span className="r-note">{r.note}</span>
              </li>
            );
          })}
        </ol>
        {rows.length > TOP && (
          <button type="button" className="btn btn-quiet more" aria-expanded={all} aria-controls={listId} onClick={() => setAll((a) => !a)}>
            <Icon name="chevron-down" size={18} />
            {all ? `상위 ${TOP}개만 보기` : `전체 ${rows.length}개 보기`}
          </button>
        )}
        {typeof footnote === "string" ? (
          <p className="hint">{footnote}</p>
        ) : (
          footnote &&
          footnote.length > 0 && (
            <ul className="hint hint-list">
              {footnote.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )
        )}
      </div>
    </section>
  );
}

export default function Plex() {
  const tool = TOOL_BY_ID.plex;
  const initial = useMemo(loadSaved, []);
  const [quotes, setQuotes] = useState<Quotes>(initial.quotes);
  const [dir, setDir] = useState(initial.dir);
  const [prices, setPrices] = useState<Prices>(initial.prices);
  const [farm, setFarm] = useState<FarmInputs>(initial.farm);
  const [usdKrw, setUsdKrw] = useState(initial.usdKrw);
  const [injectorSp, setInjectorSp] = useState(initial.injectorSp);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(initial.fetchedAt);
  const [steamLive, setSteamLive] = useState<SteamLive | null>(null);
  const [eveStore, setEveStore] = useState<Snapshot<EveStore> | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  // Re-render each minute so a page left open notices its quotes getting old.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const dirRef = useRef(dir);
  dirRef.current = dir;

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setStatus("loading");
    try {
      const snap = await fetchAggregates(signal);
      const q: Quotes = { PLEX: snap.data[TYPES.PLEX] ?? null, LSI: snap.data[TYPES.LSI] ?? null, EXT: snap.data[TYPES.EXT] ?? null };
      setQuotes(q);
      const d = dirRef.current;
      setPrices((prev) => {
        const next = { ...prev };
        for (const t of QTYPES) {
          const v = pickQuote(q[t], d[t]);
          if (v != null && v > 0) next[PRICE_FIELD[t]] = Math.round(v);
        }
        return next;
      });
      setFetchedAt(snap.fetchedAt ?? new Date());
      setStatus("ok");
    } catch (e) {
      if ((e as Error).name !== "AbortError") setStatus("error");
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void refresh(ac.signal);
    fetchSteamOmega(ac.signal).then((s) => setSteamLive(s.data), () => {
      /* Steam unavailable: list prices stay */
    });
    fetchEveStore(ac.signal).then(setEveStore, () => {
      /* store prices unavailable: the built-in 2026-06 prices stay */
    });
    return () => ac.abort();
  }, [refresh]);

  useEffect(() => {
    writeJSON(STORE_KEY, {
      quotes,
      fetchedAt: fetchedAt ? fetchedAt.toISOString() : null,
      px: { PLEX: prices.plex, LSI: prices.lsi, EXT: prices.ext },
      dir,
      usdKrw,
      injectorSp,
      farm,
    } satisfies Saved);
  }, [quotes, fetchedAt, prices, dir, usdKrw, injectorSp, farm]);

  const changeDir = (t: QuoteType, key: string) => {
    setDir((d) => ({ ...d, [t]: key }));
    const v = pickQuote(quotes[t], key);
    if (v != null && v > 0) setPrices((p) => ({ ...p, [PRICE_FIELD[t]]: Math.round(v) }));
  };
  const setF = <K extends keyof FarmInputs>(k: K, v: FarmInputs[K]) => setFarm((f) => ({ ...f, [k]: v }));

  const ranks = useMemo(
    () =>
      buildRankings(computeFarm(prices, farm), farm, { usdKrw, injectorSp, steamLive, store: eveStore?.data ?? null }),
    [prices, farm, usdKrw, injectorSp, steamLive, eveStore],
  );

  const stale = status !== "loading" && !!fetchedAt && isStale(fetchedAt, now);
  const statusText =
    status === "loading"
      ? "시세 받는 중…"
      : status === "error"
        ? fetchedAt
          ? `새 시세를 못 받았어요 · ${stamp(fetchedAt, now)} 값으로 계산 중`
          : "시세를 못 받았어요 · 2026-06 기준값으로 계산 중"
        : fetchedAt
          ? stale
            ? `${ago(fetchedAt, now)} 시세예요 · ${stamp(fetchedAt, now)} 기준`
            : `${stamp(fetchedAt, now)} 기준`
          : "2026-06 기준값";
  const nesUnit = farm.nesPlex / (farm.nesQty || 1);

  return (
    <ToolFrame tool={tool}>
      <section className="panel quote-strip" aria-labelledby="quotes-h">
        <h2 id="quotes-h" className="visually-hidden">
          적용 시세
        </h2>
        <div className="qs-row">
          <span className="qs-place">지타 4-4</span>
          {QTYPES.map((t) => (
            <span className="q" key={t}>
              <span className="q-k">{QINFO[t].short}</span>
              <span className="q-v num">{shortIsk(prices[PRICE_FIELD[t]])}</span>
            </span>
          ))}
          <span className={"status " + (stale && status !== "error" ? "stale" : status)} role="status" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            {statusText}
          </span>
          <button type="button" className="btn" onClick={() => void refresh()} disabled={status === "loading"}>
            <Icon name="refresh" size={18} />
            시세 새로고침
          </button>
        </div>
        <Disclosure label="호가·거래 방향 바꾸기" summary="PLEX·LSI는 즉시 매도가, 익스트랙터는 즉시 매수가가 기본">
          <div className="quote-detail">
            {QTYPES.map((t) => {
              const q = quotes[t];
              const raw: Array<[string, number | null]> = [
                ["매수 최고", pickQuote(q, "buy.max")],
                ["매수 최저", pickQuote(q, "buy.min")],
                ["매도 최저", pickQuote(q, "sell.min")],
                ["매도 최고", pickQuote(q, "sell.max")],
              ];
              return (
                <div className="qcol" key={t}>
                  <h3>
                    {QINFO[t].name} <span className="faint num">{TYPES[t]}</span>
                  </h3>
                  <table className="raw">
                    <tbody>
                      {raw.map(([k, v]) => (
                        <tr key={k}>
                          <th scope="row">{k}</th>
                          <td className="num">{v != null ? comma(v) : "-"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="field">
                    <label htmlFor={`dir-${t}`}>거래 방향 / 적용 호가</label>
                    <select id={`dir-${t}`} value={dir[t]} onChange={(e) => changeDir(t, e.target.value)}>
                      {PRICE_KEYS.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="applied">
                    {QINFO[t].role} <b className="num">{comma(prices[PRICE_FIELD[t]])}</b> ISK
                  </p>
                </div>
              );
            })}
          </div>
        </Disclosure>
      </section>

      <section className="panel conditions" aria-label="조건">
        <NumberField id="usd-krw" label="USD → 원 환율" value={usdKrw} onChange={setUsdKrw} step={1} min={0} suffix="원" />
        <div className="field">
          <label htmlFor="injector-sp">인젝터 체감 (보유 SP 구간)</label>
          <select id="injector-sp" value={injectorSp} onChange={(e) => setInjectorSp(Number(e.target.value))}>
            {INJECTOR_TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <p className="hint cond-hint">원 / 단위가 낮을수록 효율이 좋습니다. 1위는 가장 싸게 얻는 길입니다.</p>
      </section>

      <div className="panel bands">
        <RankBand id="isk" title="원 / 1B ISK" sub="ISK 싸게 벌기" rows={ranks.isk} />
        <RankBand id="sp" title="원 / 1M SP" sub="SP 싸게 얻기" rows={ranks.sp} footnote="훈련은 ③의 가장 싼 오메가 비용 기준, 인젝터는 PLEX를 팔아 ISK를 마련한다고 가정합니다." />
        <RankBand
          id="omega"
          title="원 / 오메가 1개월"
          sub="오메가 싸게"
          rows={ranks.omega}
          footnote={[
            `자가펀딩: 24개월 오메가로 내내 훈련(+5임플)하고, 쌓인 SP를 뽑아 판 돈을 뺀 월 비용. 번 ISK는 현질 최저가(${ranks.wonPerPlex.toFixed(1)}원/PLEX)로 원화 환산. MCT n개는 캐릭터를 더 돌린 경우(1~3캐릭 중 최저).`,
            "PLEX-오메가: 적힌 팩으로 PLEX를 사서 게임 안에서 오메가 구매. SP를 뽑지 않고 훈련만 할 때 비용도 이 값.",
            steamLive ? "Steam: 지금 스토어 가격(세일 포함)." : "Steam: 가격을 못 받아 2026-06 정가로 계산.",
          ]}
        />
      </div>

      <section className="panel farm" aria-label="스킬팜 조건">
        <Disclosure
          label="스킬팜 조건 바꾸기"
          summary={`예산 ${comma(farm.budget)} PLEX · MCT ${comma(farm.mctCount)}개 · ${comma(farm.farmMonths)}개월 · 판매세 ${farm.taxPercent}%`}
        >
          <div className="farm-grid">
            <NumberField id="f-budget" label="총 PLEX 예산" value={farm.budget} onChange={(v) => setF("budget", v)} suffix="PLEX" />
            <NumberField id="f-omega" label="오메가 비용" value={farm.omegaPlex} onChange={(v) => setF("omegaPlex", v)} suffix="PLEX" />
            <NumberField id="f-mctplex" label="MCT 1개 비용" value={farm.mctPlex} onChange={(v) => setF("mctPlex", v)} suffix="PLEX" />
            <NumberField id="f-mct" label="MCT 개수" value={farm.mctCount} onChange={(v) => setF("mctCount", v)} min={0} suffix="개" />
            <NumberField id="f-months" label="팜 기간" value={farm.farmMonths} onChange={(v) => setF("farmMonths", v)} min={0} suffix="개월" />
            <NumberField id="f-spday" label="캐릭당 SP/일" value={farm.spPerDay} onChange={(v) => setF("spPerDay", v)} suffix="SP" />
            <div className="field check-field">
              <label className="check">
                <input type="checkbox" checked={farm.boosterOn} onChange={(e) => setF("boosterOn", e.target.checked)} />
                가속기 사용
              </label>
            </div>
            <NumberField id="f-boost" label="가속기 곱셈계수" value={farm.boosterMul} onChange={(v) => setF("boosterMul", v)} step={0.05} disabled={!farm.boosterOn} suffix="×" />
            <NumberField id="f-floor" label="추출 불가 플로어 (1회 차감)" value={farm.floorSp} onChange={(v) => setF("floorSp", v)} suffix="SP" />
            <NumberField id="f-splsi" label="LSI당 SP" value={farm.spPerLsi} onChange={(v) => setF("spPerLsi", v)} suffix="SP" />
            <NumberField id="f-tax" label="판매세+중개수수료 (LSI 매도)" value={farm.taxPercent} onChange={(v) => setF("taxPercent", v)} step={0.1} suffix="%" />
            <NumberField id="f-nesqty" label="NES 익스트랙터 번들 개수" value={farm.nesQty} onChange={(v) => setF("nesQty", v)} suffix="개" />
            <NumberField id="f-nesplex" label="NES 번들 가격" value={farm.nesPlex} onChange={(v) => setF("nesPlex", v)} suffix="PLEX" />
            <div className="field">
              <span className="label">익스트랙터 1개당</span>
              <p className="readout num">{nesUnit.toFixed(2)} PLEX</p>
            </div>
          </div>
        </Disclosure>
      </section>

      <section className="sources" aria-label="출처와 가정">
        <p>
          시세: Fuzzwork Market · Jita 4-4 (station 60003760). 서버가 몇 분마다 받아 둔 값이며 위의 기준 시각이 받은 시각입니다.
        </p>
        <p>
          원/PLEX는 Steam 20k 번들과 EVE웹 PLEX팩 가운데 가장 싼 쪽(지금 {comma(Math.round(ranks.wonPerPlex))}원)으로 계산합니다.{" "}
          {eveStore
            ? `EVE웹 가격(오메가·PLEX·SP 번들)은 EVE 스토어에서 ${eveStore.fetchedAt ? stamp(eveStore.fetchedAt, now) + "에 " : ""}받은 값(세일 포함)입니다.`
            : "EVE웹 가격을 못 받아 2026-06 확인 가격으로 계산했습니다."}{" "}
          결제·투자 판단은 본인 책임입니다.
        </p>
      </section>
    </ToolFrame>
  );
}
