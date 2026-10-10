import { useEffect, useState } from "react";
import { AgentSections } from "./Agent";
import { api, apiCached, type Catalog, type Me, type UserSettings } from "./api";
import { SaveMarksContext, useReportSave } from "./save";
import {
  ContextSection,
  personalContextLabel,
  useOptimisticPatch,
} from "./settings";
import {
  Alert,
  Effective,
  Skeleton,
  ToastArea,
  useDocumentTitle,
  useHashScroll,
  useToasts,
} from "./ui";

/* ============================================================
   個人設定（ギルド上書き）
   ============================================================ */

/** 上書きしている項目の数。サブエージェントのモードは 3 つのスイッチで 1 項目。 */
function overrideCount(s: UserSettings): number {
  return [
    s.selection,
    s.effort,
    s.service_tier,
    s.subagent_enabled ?? s.ultra_mode ?? s.multi_agent,
    s.subagent_model,
    s.subagent_effort,
    s.multi_agent_roles,
    s.jev_enabled,
    s.jev_task_enabled,
    s.context && (s.context.text.trim() || s.context.persona_override) ? s.context : null,
  ].filter((v) => v != null).length;
}

export function MePage() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  const { patch, save, marks } = useOptimisticPatch<UserSettings>({
    settings,
    setSettings,
    presets: cat?.presets ?? [],
    send: (body) =>
      api<{ settings: UserSettings }>("/api/me/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onError: (message) => push("error", message),
    blankReset: true,
  });
  useDocumentTitle("マイ設定");
  useReportSave(save);

  useEffect(() => {
    setErr(null);
    apiCached<Catalog>("/api/catalog")
      .then(setCat)
      .catch((e) => setErr(String(e.message ?? e)));
    apiCached<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
    api<{ settings: UserSettings }>("/api/me/settings")
      .then((r) => setSettings(r.settings))
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);

  const ready = !!cat && !!settings;
  useHashScroll(ready);
  const overrides = settings ? overrideCount(settings) : 0;

  return (
    <SaveMarksContext.Provider value={marks}>
      <div className="page">
        <header className="page-head">
          <h1>マイ設定</h1>
          <p className="lead">
            あなたがボットに話しかけるときだけ効きます。デフォルトの項目はサーバー設定に従い、変えた項目だけ上書きします。
          </p>
        </header>

        {err && !ready && <Alert>{err}</Alert>}
        {!err && !ready && (
          <div className="skel-stack" aria-busy="true">
            <span className="sr">読み込み中…</span>
            <Skeleton height={92} />
            <Skeleton height={210} />
            <Skeleton height={210} />
          </div>
        )}

        {ready && (
          <>
            <Effective
              title="あなたの上書き"
              caption={
                overrides > 0
                  ? `${overrides} 項目を上書き中。そのほかは、話しかけたサーバーの設定に従います。`
                  : "上書きはありません。すべて、話しかけたサーバーの設定に従います。"
              }
              items={[
                { label: "モデル", value: settings.selection?.model ?? "デフォルト" },
                { label: "effort", value: settings.effort ?? "デフォルト" },
                { label: "コンテキスト", value: personalContextLabel(settings.context) },
              ]}
            />
            <AgentSections
              scope="me"
              catalog={cat}
              settings={settings}
              role={me?.role}
              patch={patch}
            />
            <ContextSection
              scope="me"
              value={settings.context?.text ?? ""}
              personaOverride={settings.context?.persona_override ?? false}
              draft={draft}
              onDraft={setDraft}
              patch={patch}
            />
          </>
        )}

        <ToastArea toasts={toasts} />
      </div>
    </SaveMarksContext.Provider>
  );
}
