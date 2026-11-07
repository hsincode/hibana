import { useEffect, useState } from "react";
import { EXA_MODES } from "@hibana/shared/catalog";
import {
  DEFAULT_THREAD_COMPACTION_TOKENS,
  THREAD_COMPACTION_MODES,
  type AppSettings,
  type ThreadCompactionMode,
} from "@hibana/shared/settings";
import { api, type AppSettingsResponse } from "./api";
import { BudgetFallbackPanel } from "./BudgetFallback";
import { Select } from "./controls";
import { Row, SaveMarksContext, useReportSave, useRowTarget } from "./save";
import {
  useOptimisticPatch,
  type OverlaySettings,
  type PatchFn,
} from "./settings";
import {
  Alert,
  BoolSeg,
  Section,
  Skeleton,
  ToastArea,
  useDocumentTitle,
  useHashScroll,
  useToasts,
} from "./ui";

/* ============================================================
   全体の設定（#161）
   すべてのサーバーと DM で 1 つの値。サーバーごとに分けていなかった設定を
   サーバーのページから移し、利用料のページにあった「予算が少ないときのモデル」も
   ここに集めた。ログインした人は誰でも見られ、変えられるのは Moderator と
   Administrator（API の can_edit）。変えられない人には部品を無効にして見せる。
   ============================================================ */

/** 画面の設定は API の値そのもの。保存の部品（useOptimisticPatch）の型に合わせる。 */
type Settings = AppSettings & OverlaySettings;

export function GlobalSettingsPage() {
  const [data, setData] = useState<AppSettingsResponse | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  const { patch, save, marks } = useOptimisticPatch<Settings>({
    settings,
    setSettings,
    presets: [],
    send: (body) =>
      api<{ settings: Settings }>("/api/app-settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onError: (message) => push("error", message),
  });
  useDocumentTitle("全体の設定");
  useReportSave(data?.can_edit ? save : null);

  useEffect(() => {
    let active = true;
    api<AppSettingsResponse>("/api/app-settings")
      .then((r) => {
        if (!active) return;
        setData(r);
        setSettings(r.settings);
      })
      .catch((e) => {
        if (active) setErr(String(e.message ?? e));
      });
    return () => {
      active = false;
    };
  }, []);

  const ready = !!data && !!settings;
  useHashScroll(ready);
  useRowTarget(ready);

  return (
    <SaveMarksContext.Provider value={marks}>
      <div className="page">
        <header className="page-head">
          <h1>全体の設定</h1>
          <p className="lead">
            すべてのサーバーと DM
            に使われる設定です。サーバーごとには変えられません。
          </p>
        </header>

        {err && !ready && <Alert>{err}</Alert>}
        {!err && !ready && (
          <div className="skel-stack" aria-busy="true">
            <span className="sr">読み込み中…</span>
            <Skeleton height={210} />
            <Skeleton height={120} />
          </div>
        )}

        {ready && (
          // 変えられない人には、同じ部品を無効にして見せる（fieldset の disabled）。
          <fieldset className="app-fields" disabled={!data.can_edit}>
            {!data.can_edit && (
              <p className="app-fields-note">
                変更できるのは Moderator と Administrator です。
              </p>
            )}
            <AppSections
              settings={settings}
              defaults={data.defaults}
              patch={patch}
            />
          </fieldset>
        )}

        <BudgetFallbackPanel reloadKey="app-settings" />

        <ToastArea toasts={toasts} />
      </div>
    </SaveMarksContext.Provider>
  );
}

function secsHint(v: number | null | undefined): string {
  if (v == null) return "秒数を指定してください。";
  const h = Math.floor(v / 3600);
  const m = Math.round((v % 3600) / 60);
  return `= ${h > 0 ? `${h} 時間 ` : ""}${m} 分`;
}

const COMPACTION_LABELS: Record<ThreadCompactionMode, string> = {
  cache: "会話のキャッシュを使う（既定）",
  transcript: "古いターンを JSON で渡す（キャッシュなし）",
  off: "要約しない",
};

/** 全体の設定の行。行のキー（`a-…`）は nav.ts の APP_SETTINGS と合わせる。 */
function AppSections({
  settings: s,
  defaults,
  patch,
}: {
  settings: Settings;
  defaults: AppSettings;
  patch: PatchFn;
}) {
  /** 数値はフォーカスを外した時点で保存する。値が変わっていなければ何も送らない。 */
  const saveNumber = (
    input: HTMLInputElement,
    field:
      | "temperature"
      | "thread_history_max_age_secs"
      | "thread_compaction_tokens",
    row: string,
  ) => {
    // 空欄には保存する意味が無いので、表示中の値に戻す。
    if (!input.value) input.value = input.defaultValue;
    if (!input.checkValidity()) return;
    const next = Number(input.value);
    if (next !== s[field]) patch({ [field]: next }, row);
  };

  return (
    <>
      <Section
        id="tuning"
        title="Temperature / Exa / スレッド履歴"
        desc="数値は入力欄からフォーカスを外した時点で保存されます。"
      >
        <div className="rows">
          <Row
            k="a-temperature"
            name="temperature"
            mono
            htmlFor="a-temperature-in"
            hint={`0〜2。既定 ${defaults.temperature}。`}
          >
            <input
              className="input mono"
              id="a-temperature-in"
              type="number"
              inputMode="decimal"
              min={0}
              max={2}
              step={0.05}
              defaultValue={s.temperature}
              onBlur={(e) =>
                saveNumber(e.target, "temperature", "a-temperature")
              }
            />
          </Row>
          <Row
            k="a-exa"
            name="exa"
            mono
            htmlFor="a-exa-sel"
            hint="off にすると、Web 検索と取得のツールを使いません。"
          >
            <Select
              id="a-exa-sel"
              value={s.exa_mode}
              onValueChange={(e) => patch({ exa_mode: e }, "a-exa")}
            >
              {EXA_MODES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Row>
          <Row
            k="a-history"
            name="スレッド履歴の保持（秒）"
            htmlFor="a-history-in"
            hint={secsHint(s.thread_history_max_age_secs)}
          >
            <input
              className="input mono"
              id="a-history-in"
              type="number"
              inputMode="numeric"
              min={0}
              step={60}
              defaultValue={s.thread_history_max_age_secs}
              onBlur={(e) =>
                saveNumber(e.target, "thread_history_max_age_secs", "a-history")
              }
            />
          </Row>
          <Row
            k="a-compaction"
            name="スレッドの要約"
            htmlFor="a-compaction-sel"
            hint="長くなったスレッドの古いターンを要約に置き換える方式。「要約しない」では、モデルに長すぎると断られたときに古い半分を落とします。"
          >
            <Select
              id="a-compaction-sel"
              value={s.thread_compaction}
              onValueChange={(e) =>
                patch(
                  { thread_compaction: e as ThreadCompactionMode },
                  "a-compaction",
                )
              }
            >
              {THREAD_COMPACTION_MODES.map((x) => (
                <option key={x} value={x}>
                  {COMPACTION_LABELS[x]}
                </option>
              ))}
            </Select>
          </Row>
          <Row
            k="a-compaction-tokens"
            name="要約を始める大きさ（トークン）"
            htmlFor="a-compaction-tokens-in"
            hint={`1,000〜1,000,000。履歴（システムとツールの定義を除く）の推定がこれを超えたら要約し、新しい方の半分をそのまま残します。既定 ${DEFAULT_THREAD_COMPACTION_TOKENS.toLocaleString("ja-JP")}。`}
          >
            <input
              className="input mono"
              id="a-compaction-tokens-in"
              type="number"
              inputMode="numeric"
              min={1000}
              max={1_000_000}
              step={1000}
              disabled={s.thread_compaction === "off"}
              defaultValue={s.thread_compaction_tokens}
              onBlur={(e) =>
                saveNumber(
                  e.target,
                  "thread_compaction_tokens",
                  "a-compaction-tokens",
                )
              }
            />
          </Row>
        </div>
      </Section>

      <Section
        id="mcp"
        title="MCP"
        desc="外部 MCP を使うかどうかは、サーバーごとに「ツールと挙動」で切り替えます。"
      >
        <div className="rows">
          <Row
            k="a-mcp-url"
            name="MCP サーバー URL"
            htmlFor="a-mcp-url-in"
            hint="入力欄からフォーカスを外した時点で保存されます。空にすると既定に戻します。"
          >
            <input
              className="input mono"
              id="a-mcp-url-in"
              type="url"
              spellCheck={false}
              maxLength={2048}
              placeholder={defaults.mcp_url}
              defaultValue={s.mcp_url}
              onBlur={(e) => {
                if (!e.target.validity.valid) {
                  e.target.reportValidity();
                  return;
                }
                const next = e.target.value.trim();
                if (!next) {
                  // 既定に戻す。表示も既定の URL にそろえる。
                  e.target.value = defaults.mcp_url;
                  if (s.mcp_url !== defaults.mcp_url)
                    patch({ mcp_url: null }, "a-mcp-url");
                  return;
                }
                if (next !== s.mcp_url) patch({ mcp_url: next }, "a-mcp-url");
              }}
            />
          </Row>
        </div>
      </Section>

      <Section id="voice" title="通話・録音">
        <div className="rows">
          <Row
            k="a-voice"
            name="voice-mode"
            mono
            htmlFor="a-voice-sel"
            hint="stt は文字起こし、s2s は音声のまま応答。"
          >
            <Select
              id="a-voice-sel"
              value={s.voice_mode}
              onValueChange={(e) => patch({ voice_mode: e }, "a-voice")}
            >
              <option value="stt">stt</option>
              <option value="s2s">s2s</option>
            </Select>
          </Row>
          <Row
            k="a-filler"
            name="filler removal"
            mono
            inline
            hint="通話と録音の文字起こしで、「えー」「あの」などを除きます。"
          >
            {(nameId) => (
              <BoolSeg
                labelledBy={nameId}
                value={s.filler_removal}
                onChange={(v) => patch({ filler_removal: v }, "a-filler")}
              />
            )}
          </Row>
        </div>
      </Section>
    </>
  );
}
