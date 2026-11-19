import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ToolFrame } from "../components/ToolFrame";
import { Icon } from "../components/Icon";
import { TOOL_BY_ID } from "../tools";
import { readJSON, writeJSON } from "../lib/storage";
import { PRICE_TTL, itemIconUrl, loadItemPrices, oldestPriceTime } from "../lib/market";
import { stamp } from "../lib/format";
import {
  EXAMPLE_FITS,
  EXAMPLE_INV,
  computeShopping,
  emptyCache,
  needsFetch,
  rowCells,
  summaryText,
  type Fit,
  type FitSummary,
  type PriceCache,
} from "../lib/fridge";

const KEY = "eve-jita-shopping-v2";
const OLD_KEY = "eve-jita-shopping-v1";
const CACHE_KEY = "eve-jita-cache-v2";

interface FridgeState {
  fits: Fit[];
  inv: string;
  hull: boolean;
  showAll: boolean;
  example: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 9);

function exampleState(): FridgeState {
  return { fits: EXAMPLE_FITS.map((f) => ({ id: uid(), qty: f.qty, text: f.text })), inv: EXAMPLE_INV, hull: true, showAll: false, example: true };
}

function loadState(): FridgeState {
  const s = readJSON<Partial<FridgeState>>(KEY);
  if (s && Array.isArray(s.fits)) {
    const fits = s.fits
      .filter((f): f is Fit => !!f && typeof f === "object")
      .map((f) => ({
        id: typeof f.id === "string" && f.id ? f.id : uid(),
        qty: Math.max(0, Math.trunc(Number(f.qty)) || 0),
        text: typeof f.text === "string" ? f.text : "",
        collapsed: !!f.collapsed,
      }));
    return {
      fits: fits.length ? fits : [{ id: uid(), qty: 1, text: "" }],
      inv: typeof s.inv === "string" ? s.inv : "",
      hull: s.hull !== false,
      showAll: !!s.showAll,
      example: !!s.example,
    };
  }
  const old = readJSON<{ fit?: unknown; sets?: unknown; inv?: unknown; hull?: unknown; showAll?: unknown; example?: unknown }>(OLD_KEY);
  if (old && typeof old.fit === "string" && !old.example) {
    return {
      fits: [{ id: uid(), qty: Math.max(1, parseInt(String(old.sets), 10) || 1), text: old.fit }],
      inv: typeof old.inv === "string" ? old.inv : "",
      hull: old.hull !== false,
      showAll: !!old.showAll,
      example: false,
    };
  }
  return exampleState();
}

function loadCache(): PriceCache {
  const c = readJSON<Partial<PriceCache>>(CACHE_KEY);
  if (c && c.ids && c.prices) return { ids: c.ids, prices: c.prices, vol: c.vol ?? {} };
  return emptyCache();
}

type LoadState = "idle" | "loading" | "error";

function FitCard({
  fit,
  summary,
  index,
  onChange,
  onDelete,
}: {
  fit: Fit;
  summary: FitSummary | undefined;
  index: number;
  onChange: (patch: Partial<Fit>) => void;
  onDelete: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);
  const title = summary?.title ?? `피팅 ${index + 1}`;
  const taId = `fit-${fit.id}`;
  return (
    <div className={"fit" + (fit.collapsed ? " collapsed" : "")}>
      <div className="fit-head">
        <button
          type="button"
          className="icon-btn fold"
          aria-expanded={!fit.collapsed}
          aria-controls={taId}
          aria-label={`${title} 피팅 ${fit.collapsed ? "펼치기" : "접기"}`}
          onClick={() => onChange({ collapsed: !fit.collapsed })}
        >
          <Icon name="chevron-down" size={18} />
        </button>
        <span className="fit-name">
          {title}
          {summary?.subtitle && <small>{summary.subtitle}</small>}
        </span>
        <span className="qty">
          <span className="stepper" role="group" aria-label={`${title} 척수`}>
            <button type="button" aria-label="한 척 빼기" onClick={() => onChange({ qty: Math.max(0, fit.qty - 1) })}>
              <Icon name="minus" size={16} />
            </button>
            <input
              type="number"
              min={0}
              max={9999}
              value={fit.qty}
              aria-label={`${title} 척수`}
              onChange={(e) => onChange({ qty: Math.max(0, parseInt(e.target.value, 10) || 0) })}
            />
            <button type="button" aria-label="한 척 더하기" onClick={() => onChange({ qty: fit.qty + 1 })}>
              <Icon name="plus" size={16} />
            </button>
          </span>
          <span className="unit-x" aria-hidden="true">척</span>
        </span>
        {summary && !summary.empty && <span className="fit-cost num">{summary.costText}</span>}
        <button
          type="button"
          className={"icon-btn del" + (armed ? " armed" : "")}
          aria-label={armed ? `${title} 피팅 삭제 확인` : `${title} 피팅 삭제`}
          onClick={() => (armed ? onDelete() : setArmed(true))}
        >
          {armed ? "삭제할까요?" : <Icon name="close" size={18} />}
        </button>
      </div>
      <label className="visually-hidden" htmlFor={taId}>
        {title} 피팅 붙여넣기
      </label>
      <textarea
        id={taId}
        spellCheck={false}
        hidden={fit.collapsed}
        value={fit.text}
        placeholder={"[Ferox, Fleet Ferox]\nDamage Control II\n..."}
        onChange={(e) => onChange({ text: e.target.value })}
      />
    </div>
  );
}

export default function Fridge() {
  const tool = TOOL_BY_ID.fridge;
  const [state, setState] = useState<FridgeState>(loadState);
  const [cache, setCache] = useState<PriceCache>(loadCache);
  const [load, setLoad] = useState<LoadState>("idle");
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => computeShopping(state.fits, state.inv, state.hull, cache), [state.fits, state.inv, state.hull, cache]);
  const sum = summaryText(result);

  useEffect(() => writeJSON(KEY, state), [state]);

  // ---- prices: debounce while typing, one request batch at a time ----
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const namesRef = useRef(result.names);
  namesRef.current = result.names;
  const busy = useRef(false);
  // A request that arrives mid-load runs once afterwards; a forced one stays forced.
  const again = useRef<"none" | "normal" | "force">("none");

  const loadPrices = useCallback(async (force: boolean) => {
    if (busy.current) {
      if (force || again.current === "none") again.current = force ? "force" : "normal";
      return;
    }
    const names = namesRef.current;
    if (!names.length) return;
    busy.current = true;
    setLoad("loading");
    const res = await loadItemPrices(names, cacheRef.current, force);
    setCache(res.cache);
    if (res.ok) writeJSON(CACHE_KEY, res.cache);
    setLoad(res.ok ? "idle" : "error");
    busy.current = false;
    const queued = again.current;
    again.current = "none";
    if (queued === "force") void loadPrices(true);
    else if (queued === "normal" && needsFetch(res.cache, namesRef.current, Date.now(), PRICE_TTL)) void loadPrices(false);
  }, []);

  const namesKey = result.names.join("\n");
  useEffect(() => {
    if (!namesRef.current.length || !needsFetch(cacheRef.current, namesRef.current, Date.now(), PRICE_TTL)) return;
    const t = setTimeout(() => void loadPrices(false), 700);
    return () => clearTimeout(t);
  }, [namesKey, loadPrices]);

  const edit = (fn: (s: FridgeState) => FridgeState) => setState((s) => ({ ...fn(s), example: false }));
  const patchFit = (id: string, patch: Partial<Fit>) => {
    const onlyFold = Object.keys(patch).length === 1 && "collapsed" in patch;
    const apply = (s: FridgeState) => ({ ...s, fits: s.fits.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
    if (onlyFold) setState(apply);
    else edit(apply);
  };
  const deleteFit = (id: string) =>
    edit((s) => {
      const fits = s.fits.filter((f) => f.id !== id);
      return { ...s, fits: fits.length ? fits : [{ id: uid(), qty: 1, text: "" }] };
    });
  const addFit = () => {
    const f: Fit = { id: uid(), qty: 1, text: "" };
    edit((s) => ({ ...s, fits: [...s.fits, f] }));
    requestAnimationFrame(() => document.getElementById(`fit-${f.id}`)?.focus());
  };

  const copy = async () => {
    if (!result.multibuy) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    };
    try {
      await navigator.clipboard.writeText(result.multibuy);
      done();
    } catch {
      const ta = document.createElement("textarea");
      ta.value = result.multibuy;
      document.body.appendChild(ta);
      ta.select();
      try {
        if (document.execCommand("copy")) done();
      } catch {
        /* selection stays visible for a manual copy */
      }
      document.body.removeChild(ta);
    }
  };

  const shown = state.showAll ? result.rows : result.buyRows;
  const priceTime = oldestPriceTime(cache, result.names);
  const statusText =
    load === "loading"
      ? "가격 불러오는 중…"
      : load === "error"
        ? "가격을 못 불러왔어요. 인터넷 연결을 확인하고 새로고침을 눌러 주세요."
        : priceTime
          ? `지타 4-4 최저 매도가 · ${stamp(new Date(priceTime))} 기준`
          : "가격 대기";
  const warnings: string[] = [];
  if (result.notFound.length) warnings.push("아이템 이름을 못 찾음 (오타 확인): " + result.notFound.join(", "));
  if (result.skipped.length) warnings.push("읽지 못한 줄: " + result.skipped.join(", "));

  return (
    <ToolFrame tool={tool}>
      <div className="fr-inputs">
        <section className="fr-col" aria-labelledby="fits-h">
          <div className="col-head">
            <h2 id="fits-h">피팅</h2>
            {state.example && <span className="ex-tag">예시 데이터</span>}
          </div>
          <p className="help">게임 피팅창 → Copy to clipboard, 또는 pyfa EFT 내보내기를 붙여넣으세요. 탄약·드론은 카고 줄에 "이름 x수량".</p>
          <div className="fits">
            {state.fits.map((f, i) => (
              <FitCard
                key={f.id}
                fit={f}
                index={i}
                summary={result.fits[i]}
                onChange={(p) => patchFit(f.id, p)}
                onDelete={() => deleteFit(f.id)}
              />
            ))}
          </div>
          <button type="button" className="btn add-fit" onClick={addFit}>
            <Icon name="plus" size={18} />
            피팅 추가
          </button>
        </section>
        <section className="fr-col" aria-labelledby="inv-h">
          <div className="col-head">
            <h2 id="inv-h">
              <label htmlFor="inv">보유 아이템</label>
            </h2>
            <button type="button" className="btn btn-quiet" onClick={() => edit((s) => ({ ...s, inv: "" }))}>
              비우기
            </button>
          </div>
          <p className="help" id="inv-help">
            행거를 리스트 보기로 → Ctrl+A → Ctrl+C → 붙여넣기. 여러 행거를 이어 붙여도 합산돼요.
          </p>
          <textarea
            id="inv"
            className="inv"
            spellCheck={false}
            aria-describedby="inv-help"
            value={state.inv}
            placeholder={"250mm Railgun II\t4\tHybrid Weapon\nDamage Control II x2"}
            onChange={(e) => edit((s) => ({ ...s, inv: e.target.value }))}
          />
        </section>
      </div>

      <div className="panel fr-controls">
        <label className="check">
          <input type="checkbox" checked={state.hull} onChange={(e) => setState((s) => ({ ...s, hull: e.target.checked }))} />
          선체(함선)도 포함
        </label>
        <label className="check">
          <input type="checkbox" checked={state.showAll} onChange={(e) => setState((s) => ({ ...s, showAll: e.target.checked }))} />
          이미 있는 것도 표에 보기
        </label>
        <span className="spacer" />
        <span className={"status " + (load === "error" ? "error" : load === "loading" ? "loading" : priceTime ? "ok" : "idle")} role="status" aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          {statusText}
        </span>
        <button type="button" className="btn" onClick={() => void loadPrices(true)} disabled={load === "loading" || !result.names.length}>
          <Icon name="refresh" size={18} />
          가격 새로고침
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setState(exampleState())}>
          예시 넣기
        </button>
      </div>

      <div className="fr-results">
        <section className="panel" aria-labelledby="cmp-h">
          <h2 id="cmp-h" className="panel-h">
            비교 결과
          </h2>
          <dl className="summary">
            <div>
              <dt>필요 품목</dt>
              <dd className="num">{sum.need}</dd>
            </div>
            <div className="s-buy">
              <dt>사야 할 품목</dt>
              <dd className="num">{sum.buy}</dd>
            </div>
            <div className="s-cost">
              <dt>구매 예상액</dt>
              <dd className="num">{sum.cost}</dd>
            </div>
            <div>
              <dt>전체 피팅 가치</dt>
              <dd className="num">{sum.total}</dd>
            </div>
            <div className="s-vol">
              <dt>운송 부피 (구매분)</dt>
              <dd className="num">{sum.vol}</dd>
            </div>
          </dl>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="비교 결과 표 (가로로 밀어 보기)">
            <table className="shop">
              <thead>
                <tr>
                  <th scope="col">아이템</th>
                  <th scope="col" className="n">필요</th>
                  <th scope="col" className="n">보유</th>
                  <th scope="col" className="n">구매</th>
                  <th scope="col" className="n">지타 단가</th>
                  <th scope="col" className="n">구매 금액</th>
                  <th scope="col" className="n">부피</th>
                </tr>
              </thead>
              <tbody>
                {!shown.length && (
                  <tr>
                    <td colSpan={7} className="empty">
                      {result.rows.length ? "다 있어요. 살 거 없음." : "피팅을 붙여넣으세요."}
                    </td>
                  </tr>
                )}
                {shown.map((r) => {
                  const c = rowCells(r);
                  const bad = r.price === false || r.price === 0;
                  return (
                    <tr key={r.name} className={r.buy ? "" : "covered"}>
                      <td className="item">
                        <span className="item-in">
                          {r.typeId ? <img src={itemIconUrl(r.typeId)} alt="" width={24} height={24} loading="lazy" /> : <span className="no-icon" />}
                          <span>{c[0]}</span>
                        </span>
                      </td>
                      <td className="n num">{c[1]}</td>
                      <td className="n num">{c[2]}</td>
                      <td className={"n num buy" + (r.buy ? "" : " enough")}>{c[3]}</td>
                      <td className={"n num" + (bad ? " nf" : "")}>{c[4]}</td>
                      <td className="n num">{c[5]}</td>
                      <td className="n num">{c[6]}</td>
                    </tr>
                  );
                })}
              </tbody>
              {result.buyRows.length > 0 && (
                <tfoot>
                  <tr>
                    <td>구매 합계</td>
                    <td />
                    <td />
                    <td />
                    <td />
                    <td className="n num">{sum.cost}</td>
                    <td className="n num">{sum.vol}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {warnings.length > 0 && <p className="warnings">{warnings.join(" · ")}</p>}
        </section>

        <section className="panel mb-panel" aria-labelledby="mb-h">
          <div className="mb-head">
            <h2 id="mb-h" className="panel-h">
              지타 멀티바이용
            </h2>
            <span className="toast" role="status" aria-live="polite">
              {copied ? "복사됨" : ""}
            </span>
            <button type="button" className="btn btn-primary" onClick={() => void copy()} disabled={!result.multibuy}>
              <Icon name={copied ? "check" : "copy"} size={18} />
              복사
            </button>
          </div>
          <pre className="multibuy num" tabIndex={0} aria-label="멀티바이 목록">
            {result.multibuy || "(살 것 없음)"}
          </pre>
          <p className="note">
            지타 마켓 → Multibuy 창에 붙여넣으면 한 번에 들어가요. 가격은 지타 4-4 최저 매도가(Fuzzwork, 약 30분 주기 갱신) 기준 추정치예요. 부피는 패키징 기준이라 함선은 조립 안 한 상태로 계산돼요.
          </p>
        </section>
      </div>
    </ToolFrame>
  );
}
