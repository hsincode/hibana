import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { Icon } from "./ui";

/* ============================================================
   保存の見せ方
   成功はトーストにしない。変えた行の右端の印と、上部バーの保存状態で伝える。
   失敗だけは、理由を読めるようトーストも出す（呼び出し側）。
   ============================================================ */

export type SaveState = "idle" | "saving" | "saved" | "failed";
export type Mark = "saving" | "saved" | "failed";
/** n が変わるたびに、その行の部品の縁を光が 1 周する。failed は赤が逆に回る。 */
export type Pulse = { n: number; failed: boolean };

/* ---------- 上部バーの保存状態 ---------- */
/** null は「このページに自動保存は無い」。上部バーは何も出さない。 */
export const SaveStatusContext = createContext<(state: SaveState | null) => void>(
  () => {},
);

/** ページの保存状態を上部バーへ届ける。ページを離れたら表示を消す。 */
export function useReportSave(state: SaveState | null): void {
  const report = useContext(SaveStatusContext);
  useEffect(() => {
    report(state);
  }, [report, state]);
  useEffect(() => () => report(null), [report]);
}

const SAVE_TEXT: Record<SaveState, string> = {
  idle: "変更は自動保存されます",
  saving: "保存中…",
  saved: "保存済み",
  failed: "保存に失敗",
};

export function SaveStatus({ state }: { state: SaveState | null }) {
  if (!state) return null;
  return (
    <div
      className={`save-state${state === "idle" ? "" : ` is-${state}`}`}
      role="status"
    >
      <span className="save-glyph" aria-hidden="true" />
      <span className="save-text">{SAVE_TEXT[state]}</span>
      {/* 届いたかどうかを知る API は無いので、上限だけを案内する（docs/production.md）。 */}
      {state === "saved" && (
        <span className="save-sync">bot への反映は最大 30 秒</span>
      )}
    </div>
  );
}

/* ---------- 行ごとの印と、縁を回る光 ---------- */
export type SaveMarks = {
  marks: Record<string, Mark>;
  pulses: Record<string, Pulse>;
};
const NO_MARKS: SaveMarks = { marks: {}, pulses: {} };
export const SaveMarksContext = createContext<SaveMarks>(NO_MARKS);

const MARK_TEXT: Record<Mark, string> = {
  saving: "保存中…",
  saved: "保存済み",
  failed: "保存に失敗",
};

export function RowMark({ k }: { k: string }) {
  const mark = useContext(SaveMarksContext).marks[k];
  return (
    <div className="row-mark">
      {mark && (
        <>
          <span className={`m is-${mark}`} title={MARK_TEXT[mark]}>
            {mark === "saved" && <Icon.check size={14} />}
            {mark === "failed" && <Icon.close size={14} />}
          </span>
          {/* 読み上げは上部バーの保存状態（role="status"）が担う。ここは印の代わりの文字だけ。 */}
          <span className="sr">{MARK_TEXT[mark]}</span>
        </>
      )}
    </div>
  );
}

/**
 * 値を変えた部品を包む。保存を始めたときと失敗したときに、縁を光が 1 周する。
 * アニメーションをやり直すには class を付け直す必要があるので、ここだけ DOM を直接触る
 * （key で作り直すと、中の部品がフォーカスを失う）。
 */
export function Trace({
  k,
  inline,
  children,
}: {
  k: string;
  inline?: boolean;
  children: ReactNode;
}) {
  const pulse = useContext(SaveMarksContext).pulses[k];
  const ref = useRef<HTMLDivElement>(null);
  // ページを行き来して描き直されたときに、前の変更の光をもう一度流さない。
  const seen = useRef(pulse?.n);
  useEffect(() => {
    const el = ref.current;
    if (!el || !pulse || pulse.n === seen.current) return;
    seen.current = pulse.n;
    el.classList.remove("is-traced", "is-failed");
    void el.offsetWidth;
    el.classList.add("is-traced");
    if (pulse.failed) el.classList.add("is-failed");
  }, [pulse]);
  return (
    <div ref={ref} className={inline ? "trace is-inline" : "trace"}>
      {children}
    </div>
  );
}

/**
 * 設定行。左に名前と説明、右に部品、右端に保存の印。
 * `unused` は「保存値は残るが、いまは使われない」ときの理由。部品は操作できるままにする。
 */
export function Row({
  k,
  name,
  mono,
  htmlFor,
  hint,
  block,
  inline,
  unused,
  overridden,
  after,
  children,
}: {
  k: string;
  name: string;
  mono?: boolean;
  /** 部品が 1 つの入力なら、その id。名前が label になる。 */
  htmlFor?: string;
  hint?: ReactNode;
  /** 部品を名前の下に全幅で置く。 */
  block?: boolean;
  /** 部品が小さいとき、光の輪を部品の幅に合わせる。 */
  inline?: boolean;
  unused?: ReactNode;
  overridden?: boolean;
  after?: ReactNode;
  children: ReactNode | ((nameId: string) => ReactNode);
}) {
  const nameId = useId();
  const nameClass = mono ? "row-name mono" : "row-name";
  return (
    <div
      className={`row${block ? " is-block" : ""}${unused ? " is-unused" : ""}`}
      data-row={k}
    >
      <div className="row-label">
        <div className="row-name-line">
          {htmlFor ? (
            <label className={nameClass} htmlFor={htmlFor}>
              {name}
            </label>
          ) : (
            <span className={nameClass} id={nameId}>
              {name}
            </span>
          )}
          {overridden && <span className="tag-over">上書き中</span>}
        </div>
        {hint && <p className="row-hint">{hint}</p>}
      </div>
      <div className="row-control">
        <Trace k={k} inline={inline}>
          {typeof children === "function" ? children(nameId) : children}
        </Trace>
        {unused && (
          <p className="row-unused">
            <Icon.info size={13} />
            <span>
              <strong>いまは使われません。</strong>
              {unused}
            </span>
          </p>
        )}
        {after}
      </div>
      <RowMark k={k} />
    </div>
  );
}

/* ---------- コマンドパレットから設定項目へ ---------- */
/**
 * パレットで設定項目を選ぶと、`navigate(path, { state: { row } })` でそのページへ来る。
 * 行を見える位置へ出し、短く色づけして、最初の部品にフォーカスを移す。
 */
export function useRowTarget(ready: boolean): void {
  const location = useLocation();
  const row = (location.state as { row?: string } | null)?.row;
  useEffect(() => {
    if (!ready || !row) return;
    const el = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(row)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("is-target");
    el.querySelector<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
    )?.focus({ preventScroll: true });
    const timer = setTimeout(() => el.classList.remove("is-target"), 1800);
    return () => {
      clearTimeout(timer);
      el.classList.remove("is-target");
    };
  }, [ready, row, location.key]);
}
