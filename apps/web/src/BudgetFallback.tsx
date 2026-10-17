import { useEffect, useId, useState } from "react";
import { api } from "./api";
import { Select } from "./controls";
import { Badge, Skeleton, ToastArea, useToasts } from "./ui";

/* ============================================================
   予算が少ないときのモデル（#89）
   「今月の残り」から「今日の推計」を引いた額が閾値（$10）を切ると、bot は
   Anthropic API のターンをここで選んだモデルに切り替える。判定は API
   （apps/api/src/analytics.ts の budget()）がする。bot は 2 分ごとに同じ判定を
   読むので、ここに出る状態と bot の切り替えは最大 2 分ずれる。
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
  presets: { id: string; label: string; published: boolean }[];
  efforts: string[];
  can_edit: boolean;
  status: Status;
};

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd = (n: number) => (n < 0 ? `−${usdFormat.format(-n)}` : usdFormat.format(n));
const EFFORT_LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" };

/** `reloadKey` が変わるたびに状態を読み直す（ページの「再読み込み」と、今日の推計の更新に合わせる）。 */
export function BudgetFallbackPanel({ reloadKey }: { reloadKey: string }) {
  const [data, setData] = useState<BudgetFallbackResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<Fallback | null>(null);
  const [saving, setSaving] = useState(false);
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
  }, [reloadKey]);

  const saved = data?.fallback ?? null;
  const shown = draft ?? saved;
  const dirty = Boolean(draft && saved && (draft.preset !== saved.preset || draft.effort !== saved.effort));
  const label = (preset: string) => data?.presets.find((p) => p.id === preset)?.label ?? preset;

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const r = await api<{ fallback: Fallback }>("/api/budget-fallback", {
        method: "PUT",
        body: JSON.stringify(draft),
      });
      setData((d) => (d ? { ...d, fallback: r.fallback } : d));
      setDraft(null);
      push("ok", "フォールバックモデルを保存しました。bot には 30 秒ほどで届きます");
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
        今日の推計を含めた今月の残りが {data ? usd(data.threshold_usd) : "$10.00"} を切ると、Anthropic API
        のターン（Auto を含む）をこのモデルに切り替えます。Anthropic Workspace と、ほかのプロバイダーは切り替えません。
      </p>

      {err && <p className="stat-note is-error">{err}</p>}
      {!data && !err && <Skeleton height={64} />}
      {data && shown && (
        <>
          <StatusNote status={data.status} />
          {data.can_edit ? (
            <div className="budget-form">
              <label className="budget-field">
                <span>モデル</span>
                <Select
                  aria-label="フォールバックモデル"
                  value={shown.preset}
                  onValueChange={(preset) => setDraft({ ...shown, preset })}
                  disabled={saving}
                >
                  {data.presets
                    .filter((p) => p.published || p.id === saved?.preset)
                    .map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.published}>
                        {p.published ? p.label : `${p.label}（非公開）`}
                      </option>
                    ))}
                </Select>
              </label>
              <label className="budget-field">
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
              <div className="budget-actions">
                <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
                  保存
                </button>
                {dirty && (
                  <button type="button" className="btn" disabled={saving} onClick={() => setDraft(null)}>
                    元に戻す
                  </button>
                )}
              </div>
            </div>
          ) : (
            <p className="budget-current">
              <span>フォールバックモデル</span>
              <strong>
                {label(shown.preset)} · {EFFORT_LABEL[shown.effort] ?? shown.effort}
              </strong>
            </p>
          )}
          {data.can_edit || <p className="stat-note">変更できるのは Administrator / Moderator です。</p>}
        </>
      )}
      <ToastArea toasts={toasts} />
    </section>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (!status.configured || "error" in status) return <Badge>判定できません</Badge>;
  return status.low ? <Badge tone="danger">切り替え中</Badge> : <Badge tone="ok">通常のモデル</Badge>;
}

function StatusNote({ status }: { status: Status }) {
  if (!status.configured)
    return (
      <p className="stat-note">
        API サーバーに ANTHROPIC_ADMIN_API_KEY が無いため、残りを判定できません。この間は切り替えません。
      </p>
    );
  if ("error" in status)
    return (
      <p className="stat-note is-error">
        いまの残りを読めませんでした（{status.error}）。bot は最後に読めた判定のまま動きます。
      </p>
    );
  return (
    <p className="stat-note">
      今日の推計を含めた残り <strong className="budget-amount">{usd(status.remaining_after_today_usd)}</strong>
      （今月の残り {usd(status.remaining_usd)} − 今日の推計 {usd(status.today_usd)}）。
      {status.low
        ? "Anthropic API のターンは、いまフォールバックモデルで動いています。"
        : `${usd(status.threshold_usd)} を切るまでは、選ばれたモデルのまま動きます。`}
      bot は 2 分ごとに確かめます。
    </p>
  );
}
