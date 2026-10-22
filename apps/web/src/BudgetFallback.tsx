import { useEffect, useId, useState } from "react";
import { api } from "./api";
import { Select } from "./controls";
import { Badge, Skeleton, ToastArea, useToasts } from "./ui";

/* ============================================================
   予算が少ないときのモデル（#89、閾値は #95）
   「今月の残り」から「今日の推計」を引いた額が閾値を切ると、bot は
   Anthropic API のターンをここで選んだモデルに切り替える。判定は API
   （apps/api/src/analytics.ts の budget()）が、保存された閾値でする。bot は
   2 分ごとに同じ判定を読むので、ここに出る状態と bot の切り替えは最大 2 分ずれる。
   モデル・effort・閾値を変えられるのは Administrator だけ（#95）。
   ============================================================ */

type Fallback = { preset: string; effort: string };
type Status =
  | { configured: false }
  | { configured: true; error: string }
  | {
      configured: true;
      month: string;
      remaining_usd: number;
      today_usd: number;
      remaining_after_today_usd: number;
      threshold_usd: number;
      low: boolean;
      fetched_at: number;
    };
type BudgetFallbackResponse = {
  fallback: Fallback;
  threshold_usd: number;
  /** 保存できる閾値の範囲（#95）。古い API は返さない。 */
  threshold_range?: { min_usd: number; max_usd: number; default_usd: number };
  presets: { id: string; label: string; published: boolean }[];
  efforts: string[];
  can_edit: boolean;
  status: Status;
};
/** 閾値は入力中の文字列のまま持つ。空欄や途中の「1.」も打てるように。 */
type Draft = Fallback & { threshold: string };

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const usd = (n: number) =>
  n < 0 ? `−${usdFormat.format(-n)}` : usdFormat.format(n);
const EFFORT_LABEL: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** 入力された閾値。範囲外・1 セント未満の端数・数でないものは null。 */
function parseThreshold(
  raw: string,
  range: { min_usd: number; max_usd: number },
): number | null {
  const text = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n >= range.min_usd && n <= range.max_usd ? n : null;
}

/** `reloadKey` が変わるたびに状態を読み直す（ページの「再読み込み」と、今日の推計の更新に合わせる）。 */
export function BudgetFallbackPanel({ reloadKey }: { reloadKey: string }) {
  const [data, setData] = useState<BudgetFallbackResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // 保存した閾値で判定し直した状態を出すため、保存のあとにも読み直す。
  const [saves, setSaves] = useState(0);
  const { toasts, push } = useToasts();
  const id = useId();

  useEffect(() => {
    let cancelled = false;
    api<BudgetFallbackResponse>("/api/budget-fallback")
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setErr(null);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, saves]);

  const range = data?.threshold_range ?? {
    min_usd: 0,
    max_usd: Number.MAX_SAFE_INTEGER,
    default_usd: 10,
  };
  const saved: Draft | null = data
    ? { ...data.fallback, threshold: String(data.threshold_usd) }
    : null;
  const shown = draft ?? saved;
  const threshold = shown ? parseThreshold(shown.threshold, range) : null;
  const thresholdInvalid = Boolean(shown && threshold === null);
  const dirty = Boolean(
    draft &&
    data &&
    (draft.preset !== data.fallback.preset ||
      draft.effort !== data.fallback.effort ||
      threshold !== data.threshold_usd),
  );
  const label = (preset: string) =>
    data?.presets.find((p) => p.id === preset)?.label ?? preset;

  async function save() {
    if (!draft || threshold === null) return;
    setSaving(true);
    try {
      const r = await api<{ fallback: Fallback; threshold_usd: number }>(
        "/api/budget-fallback",
        {
          method: "PUT",
          body: JSON.stringify({
            preset: draft.preset,
            effort: draft.effort,
            threshold_usd: threshold,
          }),
        },
      );
      setData((d) =>
        d
          ? {
              ...d,
              fallback: r.fallback,
              threshold_usd: r.threshold_usd ?? threshold,
            }
          : d,
      );
      setDraft(null);
      setSaves((n) => n + 1);
      push("ok", "保存しました。bot には 2 分ほどで届きます");
    } catch (e) {
      push("error", String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="budget-panel frame" aria-labelledby={`${id}-h`}>
      <div className="budget-head">
        <h2 id={`${id}-h`}>予算が少ないときのモデル</h2>
        {data && <StatusBadge status={data.status} />}
      </div>
      <p className="budget-desc">
        今日の推計を含めた今月の残りが {data ? usd(data.threshold_usd) : "閾値"}{" "}
        を切ると、Anthropic API のターン（Auto
        を含む）をこのモデルに切り替えます。Anthropic Workspace
        と、ほかのプロバイダーは切り替えません。
      </p>

      {err && <p className="stat-note is-error">{err}</p>}
      {!data && !err && <Skeleton height={64} />}
      {data && shown && (
        <>
          <StatusNote status={data.status} />
          {data.can_edit ? (
            <div className="budget-form">
              <label className="budget-field budget-field-model">
                <span>モデル</span>
                <Select
                  aria-label="フォールバックモデル"
                  value={shown.preset}
                  onValueChange={(preset) => setDraft({ ...shown, preset })}
                  disabled={saving}
                >
                  {data.presets
                    .filter((p) => p.published || p.id === data.fallback.preset)
                    .map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.published}>
                        {p.published ? p.label : `${p.label}（非公開）`}
                      </option>
                    ))}
                </Select>
              </label>
              <label className="budget-field budget-field-effort">
                <span>effort</span>
                <Select
                  aria-label="フォールバックの effort"
                  value={shown.effort}
                  onValueChange={(effort) => setDraft({ ...shown, effort })}
                  disabled={saving}
                >
                  {data.efforts.map((e) => (
                    <option key={e} value={e}>
                      {EFFORT_LABEL[e] ?? e}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="budget-field budget-field-threshold">
                <span>閾値（USD）</span>
                <span className="budget-usd">
                  <span aria-hidden="true">$</span>
                  <input
                    className="input mono"
                    aria-label="切り替える閾値（USD）"
                    aria-invalid={thresholdInvalid}
                    aria-describedby={`${id}-th`}
                    type="number"
                    inputMode="decimal"
                    min={range.min_usd}
                    max={data.threshold_range?.max_usd}
                    step={0.01}
                    value={shown.threshold}
                    onChange={(e) =>
                      setDraft({ ...shown, threshold: e.target.value })
                    }
                    disabled={saving}
                  />
                </span>
              </label>
              <div className="budget-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!dirty || saving || thresholdInvalid}
                  onClick={save}
                >
                  保存
                </button>
                {(dirty || thresholdInvalid) && (
                  <button
                    type="button"
                    className="btn"
                    disabled={saving}
                    onClick={() => setDraft(null)}
                  >
                    元に戻す
                  </button>
                )}
              </div>
              <p
                id={`${id}-th`}
                className={
                  thresholdInvalid
                    ? "stat-note is-error budget-hint"
                    : "stat-note budget-hint"
                }
              >
                {data.threshold_range
                  ? `閾値は ${usd(data.threshold_range.min_usd)}〜${usd(data.threshold_range.max_usd)}（月の予算）、1 セント単位。既定は ${usd(data.threshold_range.default_usd)}。`
                  : "閾値は 1 セント単位で入力します。"}
                {thresholdInvalid && "この値では保存できません。"}
              </p>
            </div>
          ) : (
            <dl className="budget-current">
              <div>
                <dt>フォールバックモデル</dt>
                <dd>
                  {label(shown.preset)} ·{" "}
                  {EFFORT_LABEL[shown.effort] ?? shown.effort}
                </dd>
              </div>
              <div>
                <dt>閾値</dt>
                <dd>{usd(data.threshold_usd)}</dd>
              </div>
            </dl>
          )}
          {data.can_edit || (
            <p className="stat-note">変更できるのは Administrator です。</p>
          )}
        </>
      )}
      <ToastArea toasts={toasts} />
    </section>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (!status.configured || "error" in status)
    return <Badge>判定できません</Badge>;
  return status.low ? (
    <Badge tone="danger">切り替え中</Badge>
  ) : (
    <Badge tone="ok">通常のモデル</Badge>
  );
}

function StatusNote({ status }: { status: Status }) {
  if (!status.configured)
    return (
      <p className="stat-note">
        API サーバーに ANTHROPIC_ADMIN_API_KEY
        が無いため、残りを判定できません。この間は切り替えません。
      </p>
    );
  if ("error" in status)
    return (
      <p className="stat-note is-error">
        いまの残りを読めませんでした（{status.error}）。bot
        は最後に読めた判定のまま動きます。
      </p>
    );
  return (
    <p className="stat-note">
      今日の推計を含めた残り{" "}
      <strong className="budget-amount">
        {usd(status.remaining_after_today_usd)}
      </strong>
      （今月の残り {usd(status.remaining_usd)} − 今日の推計{" "}
      {usd(status.today_usd)}）。
      {status.low
        ? "Anthropic API のターンは、いまフォールバックモデルで動いています。"
        : `${usd(status.threshold_usd)} を切るまでは、選ばれたモデルのまま動きます。`}
      bot は 2 分ごとに確かめます。
    </p>
  );
}
