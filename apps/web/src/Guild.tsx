import { useEffect, useState } from "react";
import {
  Link,
  NavLink,
  Navigate,
  useLocation,
  useParams,
} from "react-router-dom";
import {
  api,
  apiCached,
  type Catalog,
  type GuildSettings,
  type GuildSummary,
  type Me,
} from "./api";
import { AgentSections, guildEffective } from "./Agent";
import { GuildArtifacts } from "./Artifacts";
import { Select } from "./controls";
import { roleAllows } from "./ModelPicker";
import {
  DEFAULT_TEXT_MODEL,
  TEXT_MODEL_EFFORTS,
  isTextModelPreset,
} from "@hibana/shared/settings";
import { GUILD_PAGES, LEGACY_SECTION_PAGE, guildPath } from "./nav";
import { Row, SaveMarksContext, useReportSave, useRowTarget } from "./save";
import { ContextSection, useOptimisticPatch, type PatchFn } from "./settings";
import { SkillManager } from "./Skills";
import { FALLBACK_TRIGGERS, TriggerEditor } from "./Triggers";
import {
  Alert,
  Avatar,
  BoolSeg,
  Effective,
  Empty,
  ManageNote,
  Section,
  Skeleton,
  ToastArea,
  cdnUrl,
  useDocumentTitle,
  useHashScroll,
  useToasts,
} from "./ui";

/* ============================================================
   サーバー設定
   1 つのサーバーを 5 ページに分けて見せる。設定の読み込みと保存のキューは
   ここで 1 度だけ持ち、ページを行き来しても保存中の変更や書きかけの文章が残るようにする。
   ============================================================ */
export function GuildPage() {
  const { id, "*": rest = "" } = useParams<{ id: string; "*": string }>();
  const location = useLocation();
  const [cat, setCat] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<GuildSettings | null>(null);
  // 設定を変えられるか（#166）。メンバーは開けて、見るだけ。旧 API は返さない。
  const [canEdit, setCanEdit] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [guild, setGuild] = useState<GuildSummary | null>(null);
  const [guilds, setGuilds] = useState<GuildSummary[]>([]);
  // コンテキストの書きかけ。他のページを見て戻っても残す。
  const [draft, setDraft] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  const { patch, save, marks } = useOptimisticPatch<GuildSettings>({
    settings,
    setSettings,
    presets: cat?.presets ?? [],
    send: (body) => {
      if (!id) return Promise.reject(new Error("missing guild id"));
      return api<{ settings: GuildSettings }>(`/api/guilds/${id}/settings`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    },
    onError: (message) => push("error", message),
    scope: id,
  });

  const path = rest.replace(/\/$/, "");
  const page = GUILD_PAGES.find((p) => p.path === path);
  useDocumentTitle(
    `${guild ? `${guild.name} · ` : ""}${page?.label ?? "サーバー設定"}`,
  );
  useReportSave(page?.autosave ? save : null);

  useEffect(() => {
    // Reuse the authorized list; cancellation prevents a previous route's
    // identity from appearing when navigating directly between guilds.
    let active = true;
    setGuild(null);
    apiCached<{ guilds: GuildSummary[] }>("/api/guilds")
      .then(({ guilds }) => {
        if (!active) return;
        setGuilds(guilds);
        setGuild(guilds.find((g) => g.id === id) ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setErr(null);
    setSettings(null);
    setCanEdit(false);
    setDraft(null);
    apiCached<Catalog>("/api/catalog")
      .then((c) => {
        if (active) setCat(c);
      })
      .catch((e) => {
        if (active) setErr(String(e.message ?? e));
      });
    apiCached<Me>("/api/me")
      .then((m) => {
        if (active) setMe(m);
      })
      .catch(() => {
        if (active) setMe(null);
      });
    api<{ settings: GuildSettings; can_edit?: boolean }>(
      `/api/guilds/${id}/settings`,
    )
      .then((r) => {
        if (!active) return;
        setSettings(r.settings);
        setCanEdit(r.can_edit !== false);
      })
      .catch((e) => {
        if (active) setErr(String(e.message ?? e));
      });
    // サーバーを切り替えた直後に、前のサーバーの応答が遅れて届いても表示しない。
    return () => {
      active = false;
    };
  }, [id]);

  const ready = !!cat && !!settings;
  useHashScroll(ready && !!page);
  useRowTarget(ready && !!page);

  if (!id) return <Navigate to="/" replace />;
  // 1 ページだった頃の節へのリンクは、分かれた先のページへ送る。
  const legacy =
    path === "" ? LEGACY_SECTION_PAGE[location.hash.slice(1)] : undefined;
  if (legacy)
    return <Navigate to={`${guildPath(id, legacy)}${location.hash}`} replace />;

  if (!page) {
    return (
      <div className="page">
        <Empty
          heading
          title="ページが見つからない"
          body="URL を確認してね。"
          action={
            <Link className="btn" to={guildPath(id)}>
              このサーバーの設定へ
            </Link>
          }
        />
      </div>
    );
  }

  const needsSettings = page.autosave;
  return (
    <SaveMarksContext.Provider value={marks}>
      <div className={`page${page.wide ? " is-wide" : ""}`}>
        <header className="page-head">
          <div className="guild-heading">
            <Avatar
              key={guild?.id ?? id}
              src={guild ? cdnUrl("icons", guild.id, guild.icon) : null}
              name={guild?.name ?? id}
            />
            <div className="titles">
              <h1>{guild?.name ?? "サーバー設定"}</h1>
              <p className="sub">
                サーバー設定 · <span className="mono">{id}</span>
              </p>
            </div>
          </div>
          {/* 狭い幅ではサイドバーが引き出しになるので、5 ページをタブ帯でも出す。 */}
          <nav className="guild-tabs" aria-label="サーバーのページ">
            {GUILD_PAGES.map((p) => (
              <NavLink key={p.path} to={guildPath(id, p.path)} end>
                {p.label}
              </NavLink>
            ))}
          </nav>
        </header>

        {needsSettings && err && !ready && <Alert>{err}</Alert>}
        {needsSettings && !err && !ready && (
          <div className="skel-stack" aria-busy="true">
            <span className="sr">読み込み中…</span>
            <Skeleton height={92} />
            <Skeleton height={210} />
            <Skeleton height={210} />
          </div>
        )}

        {ready && page.path === "" && (
          <Effective
            title="実際の動作"
            caption="保存した設定の組み合わせから決まる値です。bot の環境変数や接続の状態は反映していません。"
            items={guildEffective(settings)}
          />
        )}
        {ready && needsSettings && (
          // 見るだけの人には、同じ部品を無効にして見せる（fieldset の disabled、#166）。
          <fieldset className="app-fields" disabled={!canEdit}>
            {!canEdit && <ManageNote />}
            {page.path === "" && (
              <AgentSections
                scope="guild"
                catalog={cat}
                settings={settings}
                role={me?.role}
                patch={patch}
              />
            )}
            {page.path === "tools" && (
              <ToolsSections
                catalog={cat}
                settings={settings}
                role={me?.role}
                patch={patch}
              />
            )}
            {page.path === "context" && (
              <ContextSection
                scope="guild"
                value={settings.context?.text ?? ""}
                personaOverride={settings.context?.persona_override ?? false}
                draft={draft}
                onDraft={setDraft}
                patch={patch}
              />
            )}
          </fieldset>
        )}
        {page.path === "skills" && (
          <Section
            title="スキル"
            desc="このサーバーで bot が使えるスキルです。作成・削除・有効の切り替えは、bot が次に同期したときに反映されます。"
          >
            <SkillManager key={id} guildId={id} guilds={guilds} />
          </Section>
        )}
        {page.path === "artifacts" && (
          <GuildArtifacts guildId={id} push={push} />
        )}

        <ToastArea toasts={toasts} />
      </div>
    </SaveMarksContext.Provider>
  );
}

/** ツールと挙動: MCP・挙動・トリガー。temperature などは全体の設定（#161）。 */
function ToolsSections({
  catalog: c,
  settings: s,
  role,
  patch,
}: {
  catalog: Catalog;
  settings: GuildSettings;
  role: string | undefined;
  patch: PatchFn;
}) {
  // 録音の要約に使うモデル（#118）。Anthropic API のモデルだけ（Auto・Workspace を除く）。
  // 送るときはモデルと effort の組を丸ごと送る（片方だけの保存で、もう片方を失わない）。
  const textModel = s.text_model ?? DEFAULT_TEXT_MODEL;
  const textPresets = c.presets.filter(
    (p) =>
      isTextModelPreset(p.id) &&
      (p.published !== false || p.id === textModel.preset),
  );
  // 選んだ後に非公開になったモデルは、bot では既定で動き、もう選べない（保存も API に断られる）。
  // effort だけを変えるときは、既定のモデルと組にして保存する。カタログはスタッフにしか
  // 非公開のプリセットを返さないので、カタログに無いものも非公開として扱う。
  const keptPreset = c.presets.some(
    (p) => p.id === textModel.preset && p.published !== false,
  )
    ? textModel.preset
    : DEFAULT_TEXT_MODEL.preset;
  const bool = (
    row: string,
    name: string,
    value: boolean | null | undefined,
    onChange: (v: boolean) => void,
    // コマンド名と同じ綴りの項目は等幅で見せる。
    mono = true,
  ) => (
    <Row k={row} name={name} mono={mono} inline>
      {(nameId) => (
        <BoolSeg labelledBy={nameId} value={value} onChange={onChange} />
      )}
    </Row>
  );

  return (
    <>
      <p className="moved-note">
        temperature・exa・スレッド履歴と要約・MCP サーバー
        URL・通話の設定は、すべてのサーバーで共通の
        <Link to="/settings">全体の設定</Link>
        にあります。
      </p>

      <Section id="mcp" title="MCP">
        <div className="rows">
          {bool(
            "g-mcp-enabled",
            "外部 MCP",
            s.mcp_enabled,
            (v) => patch({ mcp_enabled: v }, "g-mcp-enabled"),
            false,
          )}
        </div>
      </Section>

      <Section id="behavior" title="サーバーツール / スレッド / 録音">
        <div className="rows">
          {bool("g-server-tools", "server-tools", s.server_tools ?? true, (v) =>
            patch({ server_tools: v }, "g-server-tools"),
          )}
          {bool("g-thread-only", "thread-only", s.thread_only ?? false, (v) =>
            patch({ thread_only: v }, "g-thread-only"),
          )}
          {bool(
            "g-url-previews",
            "URL previews",
            s.suppress_embeds == null ? null : !s.suppress_embeds,
            (v) => patch({ suppress_embeds: !v }, "g-url-previews"),
          )}
          <Row
            k="g-text-model"
            name="Text Generation Model"
            hint="録音（/recording）の要約を作るモデル。既定は Claude Haiku 5.5 / medium。"
          >
            <div className="row-pair">
              <Select
                aria-label="Text Generation Model"
                // 非公開でカタログに無いモデルは、bot と同じく既定を出す。
                value={
                  textPresets.some((p) => p.id === textModel.preset)
                    ? textModel.preset
                    : DEFAULT_TEXT_MODEL.preset
                }
                onValueChange={(preset) =>
                  patch(
                    { text_model: { ...textModel, preset } },
                    "g-text-model",
                  )
                }
              >
                {textPresets.map((p) => {
                  const hidden = p.published === false;
                  const locked = !roleAllows(role, p.min_role, c.roles);
                  return (
                    <option key={p.id} value={p.id} disabled={hidden || locked}>
                      {hidden
                        ? `${p.label}（非公開。既定で動きます）`
                        : locked
                          ? `${p.label}（${p.min_role} 以上）`
                          : p.label}
                    </option>
                  );
                })}
              </Select>
              <Select
                aria-label="Text Generation Model の effort"
                value={textModel.effort}
                onValueChange={(effort) =>
                  patch(
                    { text_model: { preset: keptPreset, effort } },
                    "g-text-model",
                  )
                }
              >
                {TEXT_MODEL_EFFORTS.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            </div>
          </Row>
        </div>
      </Section>

      <TriggerEditor
        builtins={c.triggers ?? FALLBACK_TRIGGERS}
        extra={s.extra_triggers ?? null}
        disabled={s.disabled_triggers ?? []}
        patch={patch}
      />
    </>
  );
}
