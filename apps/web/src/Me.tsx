import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AgentSections } from "./Agent";
import {
  api,
  apiCached,
  type Catalog,
  type Me,
  type UserSettings,
} from "./api";
import { SaveMarksContext, useReportSave } from "./save";
import {
  ContextSection,
  personalContextLabel,
  useOptimisticPatch,
} from "./settings";
import {
  Alert,
  Badge,
  Effective,
  Skeleton,
  SubjectContext,
  ToastArea,
  useDocumentTitle,
  useHashScroll,
  useToasts,
} from "./ui";

/* ============================================================
   個人設定（ギルド上書き）
   本人のマイ設定（/me）と、Administrator・Moderator が開く
   ほかのユーザーの個人設定（/users/:id、#175）が、同じ部品を使う。
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
    s.context && (s.context.text.trim() || s.context.persona_override)
      ? s.context
      : null,
  ].filter((v) => v != null).length;
}

/** `GET /api/users/:id/settings` が返す、設定の持ち主。 */
type Owner = { discord_id: string; username: string; role: string };

/**
 * 個人設定 1 件の読み書き。`endpoint` が GET と PATCH の両方の宛先で、
 * 本人のものでもほかのユーザーのものでも、PATCH の形は同じ。
 * `.page` の子として並ぶので、包む要素は持たない。持ち主を替えるときは `key` で作り直す。
 */
function PersonalSettings({
  endpoint,
  role,
  subject,
  onOwner,
}: {
  endpoint: string;
  /** 設定の持ち主のロール。選べないプリセットに鍵を掛けるのに使う。 */
  role?: string;
  /** 文の中で設定の持ち主を指す語（「あなた」「このユーザー」）。 */
  subject: string;
  onOwner?: (owner: Owner) => void;
}) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  const { patch, save, marks } = useOptimisticPatch<UserSettings>({
    settings,
    setSettings,
    presets: cat?.presets ?? [],
    send: (body) =>
      api<{ settings: UserSettings }>(endpoint, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onError: (message) => push("error", message),
    blankReset: true,
  });
  useReportSave(save);

  useEffect(() => {
    setErr(null);
    apiCached<Catalog>("/api/catalog")
      .then(setCat)
      .catch((e) => setErr(String(e.message ?? e)));
    api<{ settings: UserSettings; user?: Owner }>(endpoint)
      .then((r) => {
        setSettings(r.settings);
        if (r.user) onOwner?.(r.user);
      })
      .catch((e) => setErr(String(e.message ?? e)));
    // 呼び出し側が `key` で持ち主ごとに作り直すので、endpoint は変わらない。
  }, []);

  const ready = !!cat && !!settings;
  useHashScroll(ready);
  const overrides = settings ? overrideCount(settings) : 0;

  return (
    <SaveMarksContext.Provider value={marks}>
      <SubjectContext.Provider value={subject}>
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
              title={`${subject}の上書き`}
              caption={
                overrides > 0
                  ? `${overrides} 項目を上書き中。そのほかは、話しかけたサーバーの設定に従います。`
                  : "上書きはありません。すべて、話しかけたサーバーの設定に従います。"
              }
              items={[
                {
                  label: "モデル",
                  value: settings.selection?.model ?? "デフォルト",
                },
                { label: "effort", value: settings.effort ?? "デフォルト" },
                {
                  label: "コンテキスト",
                  value: personalContextLabel(settings.context),
                },
              ]}
            />
            <AgentSections
              scope="me"
              catalog={cat}
              settings={settings}
              role={role}
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
      </SubjectContext.Provider>
    </SaveMarksContext.Provider>
  );
}

export function MePage() {
  const [me, setMe] = useState<Me | null>(null);
  useDocumentTitle("マイ設定");
  useEffect(() => {
    apiCached<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  return (
    <div className="page">
      <header className="page-head">
        <h1>マイ設定</h1>
        <p className="lead">
          あなたがボットに話しかけるときだけ効きます。デフォルトの項目はサーバー設定に従い、変えた項目だけ上書きします。
        </p>
      </header>
      <PersonalSettings
        endpoint="/api/me/settings"
        role={me?.role}
        subject="あなた"
      />
    </div>
  );
}

/**
 * ほかのユーザーの個人設定（#175）。Administrator・Moderator が、自分より下のロールの
 * ユーザーのものだけ開ける。開けるかどうかは API が決め、開けないときは API の答えをそのまま出す。
 */
export function UserSettingsPage() {
  const { id = "" } = useParams();
  const [owner, setOwner] = useState<Owner | null>(null);
  useDocumentTitle(
    owner ? `${owner.username} の個人設定` : "ユーザーの個人設定",
  );
  // 別のユーザーへ移ったら、前のユーザーの名前を見出しに残さない。
  useEffect(() => setOwner(null), [id]);

  return (
    <div className="page">
      <header className="page-head">
        <div className="page-head-row">
          <h1>{owner ? owner.username : "ユーザー"} の個人設定</h1>
          {owner && (
            <div className="counts">
              <Badge>{owner.role}</Badge>
            </div>
          )}
        </div>
        <p className="lead">
          このユーザーがボットに話しかけるときだけ効きます。本人のマイ設定と同じもので、ここでの変更は本人のマイ設定にそのまま出ます。選べるモデルは、このユーザーのロールで決まります。{" "}
          <Link className="link" to="/users">
            ユーザーの一覧へ戻る
          </Link>
        </p>
      </header>
      <PersonalSettings
        key={id}
        endpoint={`/api/users/${encodeURIComponent(id)}/settings`}
        subject="このユーザー"
        role={owner?.role}
        onOwner={setOwner}
      />
    </div>
  );
}
