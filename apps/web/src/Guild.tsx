import { useContext, useEffect, useState } from "react";
import { Link, NavLink, Navigate, useLocation, useParams } from "react-router-dom";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
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
import { GUILD_PAGES, LEGACY_SECTION_PAGE, guildPath } from "./nav";
import { Row, RowMark, SaveMarksContext, useReportSave, useRowTarget } from "./save";
import { ContextSection, useOptimisticPatch, type PatchFn } from "./settings";
import { ReloadGuildsContext } from "./Shell";
import { SkillManager } from "./Skills";
import { FALLBACK_TRIGGERS, TriggerEditor } from "./Triggers";
import {
  Alert,
  Avatar,
  BoolSeg,
  Effective,
  Empty,
  Icon,
  Modal,
  Notice,
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
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    setErr(null);
    setSettings(null);
    setDraft(null);
    apiCached<Catalog>("/api/catalog")
      .then((c) => { if (active) setCat(c); })
      .catch((e) => { if (active) setErr(String(e.message ?? e)); });
    apiCached<Me>("/api/me")
      .then((m) => { if (active) setMe(m); })
      .catch(() => { if (active) setMe(null); });
    api<{ settings: GuildSettings }>(`/api/guilds/${id}/settings`)
      .then((r) => { if (active) setSettings(r.settings); })
      .catch((e) => { if (active) setErr(String(e.message ?? e)); });
    // サーバーを切り替えた直後に、前のサーバーの応答が遅れて届いても表示しない。
    return () => { active = false; };
  }, [id]);

  const ready = !!cat && !!settings;
  useHashScroll(ready && !!page);
  useRowTarget(ready && !!page);

  // サーバー単位の停止（#64）。状態は誰にでも見せ、操作は Administrator / Moderator にだけ出す
  // （API も、それ以外の人の変更を断る）。設定を読むまでは、一覧が返した値で出しておく。
  const stopped = settings?.bot_disabled ?? guild?.bot_disabled;
  const canStop = me?.can_moderate === true && !!settings;
  // 確認のダイアログは、開いた時点の向き（止める / 再開する）を持つ。開いている間に状態が変わっても、書いてある操作だけを送る。
  const [asking, setAsking] = useState<"stop" | "resume" | null>(null);
  const reloadGuilds = useContext(ReloadGuildsContext);
  const botMark = marks.marks["g-bot"];
  useEffect(() => {
    // 保存できたら、サイドバーの切替とサーバー一覧の「停止中」を追いつかせる。
    if (botMark === "saved") reloadGuilds();
  }, [botMark, reloadGuilds]);

  if (!id) return <Navigate to="/" replace />;
  // 1 ページだった頃の節へのリンクは、分かれた先のページへ送る。
  const legacy = path === "" ? LEGACY_SECTION_PAGE[location.hash.slice(1)] : undefined;
  if (legacy) return <Navigate to={`${guildPath(id, legacy)}${location.hash}`} replace />;

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
            {stopped !== undefined && (
              <div className="guild-status">
                <RowMark k="g-bot" />
                {/* 「有効」は設定の状態。bot のプロセスが動いているかどうかは、ここからは分からない。 */}
                <span className={`status-pill${stopped ? " is-off" : ""}`}>
                  {stopped ? "停止中" : "有効"}
                </span>
                {canStop && (
                  // modal にしない: メニューから確認のダイアログを開くとき、閉じる側と開く側でフォーカスの取り合いにならないようにする。
                  <Dropdown.Root modal={false}>
                    <Dropdown.Trigger className="icon-btn bordered" aria-label="サーバーの操作">
                      <Icon.more size={18} />
                    </Dropdown.Trigger>
                    <Dropdown.Portal>
                      <Dropdown.Content className="pop" align="end" sideOffset={6} collisionPadding={8}>
                        <Dropdown.Label className="pop-label">
                          <strong>{stopped ? "bot を止めています" : "bot は有効です"}</strong>
                        </Dropdown.Label>
                        <Dropdown.Item
                          className={`pop-item${stopped ? "" : " is-danger"}`}
                          onSelect={() => setAsking(stopped ? "resume" : "stop")}
                        >
                          <Icon.power />
                          <span className="grow">
                            {stopped ? "再開する" : "このサーバーで bot を止める"}
                          </span>
                        </Dropdown.Item>
                      </Dropdown.Content>
                    </Dropdown.Portal>
                  </Dropdown.Root>
                )}
              </div>
            )}
          </div>
          {/* 狭い幅ではサイドバーが引き出しになるので、5 ページをタブ帯でも出す。 */}
          <nav className="guild-tabs" aria-label="サーバーのページ">
            {GUILD_PAGES.map((p) => (
              <NavLink key={p.path} to={guildPath(id, p.path)} end>
                {p.label}
              </NavLink>
            ))}
          </nav>
          {stopped && (
            <Notice
              action={
                canStop && (
                  <button type="button" className="btn btn-sm" onClick={() => setAsking("resume")}>
                    再開する
                  </button>
                )
              }
            >
              このサーバーでは bot を止めています。設定は変えられますが、bot はメッセージにも通話にも応答しません。
            </Notice>
          )}
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
          <>
            <Effective
              title="実際の動作"
              caption="保存した設定の組み合わせから決まる値です。bot の環境変数や接続の状態は反映していません。"
              items={guildEffective(settings)}
            />
            <AgentSections
              scope="guild"
              catalog={cat}
              settings={settings}
              role={me?.role}
              patch={patch}
            />
          </>
        )}
        {ready && page.path === "tools" && (
          <ToolsSections catalog={cat} settings={settings} patch={patch} />
        )}
        {ready && page.path === "context" && (
          <ContextSection
            scope="guild"
            value={settings.context?.text ?? ""}
            personaOverride={settings.context?.persona_override ?? false}
            draft={draft}
            onDraft={setDraft}
            patch={patch}
          />
        )}
        {page.path === "skills" && (
          <Section
            title="スキル"
            desc="このサーバーで bot が使えるスキルです。作成・削除・有効の切り替えは、bot が次に同期したときに反映されます。"
          >
            <SkillManager key={id} guildId={id} guilds={guilds} />
          </Section>
        )}
        {page.path === "artifacts" && <GuildArtifacts guildId={id} push={push} />}

        <Modal
          open={asking !== null}
          onClose={() => setAsking(null)}
          title={asking === "resume" ? "bot を再開する" : "このサーバーで bot を止める"}
          size="narrow"
        >
          <p>
            <strong>{guild?.name ?? id}</strong> の bot を
            {asking === "resume" ? "再開します。" : "止めます。"}
          </p>
          <p className="muted">
            {asking === "resume"
              ? "再開すると、このサーバーでまた応答するようになります。"
              : "止めると、このサーバーでは bot がメッセージや通話に応答しなくなります。設定は消えません。"}
          </p>
          <p className="note">bot への反映は最大 30 秒です。</p>
          <div className="modal-foot">
            <button type="button" className="btn" onClick={() => setAsking(null)}>
              キャンセル
            </button>
            <button
              type="button"
              className={asking === "resume" ? "btn btn-primary" : "btn btn-danger"}
              onClick={() => {
                setAsking(null);
                patch({ bot_disabled: asking === "stop" }, "g-bot");
              }}
            >
              {asking === "resume" ? "再開する" : "止める"}
            </button>
          </div>
        </Modal>

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

const DEFAULT_MCP_URL = "https://ww.hsincode.com/api/mcp";

/** ツールと挙動: チューニング・MCP・挙動・トリガー。 */
function ToolsSections({
  catalog: c,
  settings: s,
  patch,
}: {
  catalog: Catalog;
  settings: GuildSettings;
  patch: PatchFn;
}) {
  /** 数値はフォーカスを外した時点で保存する。値が変わっていなければ何も送らない。 */
  const saveNumber = (
    input: HTMLInputElement,
    field: "temperature" | "thread_history_max_age_secs",
    row: string,
  ) => {
    // Empty input has no saved meaning; restore the visible
    // value so the field always agrees with the active setting.
    if (!input.value) input.value = input.defaultValue;
    if (!input.checkValidity()) return;
    const next = Number(input.value);
    if (next !== s[field]) patch({ [field]: next }, row);
  };
  const bool = (
    row: string,
    name: string,
    value: boolean | null | undefined,
    onChange: (v: boolean) => void,
    // コマンド名と同じ綴りの項目は等幅で見せる。
    mono = true,
  ) => (
    <Row k={row} name={name} mono={mono} inline>
      {(nameId) => <BoolSeg labelledBy={nameId} value={value} onChange={onChange} />}
    </Row>
  );

  return (
    <>
      <Section
        id="tuning"
        title="Temperature / Exa / スレッド履歴"
        desc="数値は入力欄からフォーカスを外した時点で保存されます。"
      >
        <div className="rows">
          <Row k="g-temperature" name="temperature" mono htmlFor="g-temperature-in" hint="0〜2。">
            <input
              className="input mono"
              id="g-temperature-in"
              type="number"
              inputMode="decimal"
              min={0}
              max={2}
              step={0.05}
              defaultValue={s.temperature ?? ""}
              onBlur={(e) => saveNumber(e.target, "temperature", "g-temperature")}
            />
          </Row>
          <Row k="g-exa" name="exa" mono htmlFor="g-exa-sel">
            <Select
              id="g-exa-sel"
              value={s.exa_mode ?? "auto"}
              onValueChange={(e) => patch({ exa_mode: e }, "g-exa")}
            >
              {c.exa.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </Row>
          <Row
            k="g-history"
            name="スレッド履歴の保持（秒）"
            htmlFor="g-history-in"
            hint={secsHint(s.thread_history_max_age_secs)}
          >
            <input
              className="input mono"
              id="g-history-in"
              type="number"
              inputMode="numeric"
              min={0}
              step={60}
              defaultValue={s.thread_history_max_age_secs ?? ""}
              onBlur={(e) => saveNumber(e.target, "thread_history_max_age_secs", "g-history")}
            />
          </Row>
        </div>
      </Section>

      <Section id="mcp" title="MCP">
        <div className="rows">
          {bool(
            "g-mcp-enabled",
            "外部 MCP",
            s.mcp_enabled,
            (v) => patch({ mcp_enabled: v }, "g-mcp-enabled"),
            false,
          )}
          <Row
            k="g-mcp-url"
            name="MCP サーバー URL"
            htmlFor="g-mcp-url-in"
            hint="入力欄からフォーカスを外した時点で保存されます。"
          >
            <input
              className="input mono"
              id="g-mcp-url-in"
              type="url"
              spellCheck={false}
              maxLength={2048}
              placeholder={DEFAULT_MCP_URL}
              defaultValue={s.mcp_url ?? DEFAULT_MCP_URL}
              onBlur={(e) => {
                if (!e.target.validity.valid) {
                  e.target.reportValidity();
                  return;
                }
                const next = e.target.value.trim() || null;
                if (next !== (s.mcp_url ?? null)) patch({ mcp_url: next }, "g-mcp-url");
              }}
            />
          </Row>
        </div>
      </Section>

      <Section id="behavior" title="サーバーツール / スレッド / 通話">
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
            k="g-voice"
            name="voice-mode"
            mono
            htmlFor="g-voice-sel"
            hint="stt は文字起こし、s2s は音声のまま応答。"
          >
            <Select
              id="g-voice-sel"
              value={s.voice_mode ?? "stt"}
              onValueChange={(e) => patch({ voice_mode: e }, "g-voice")}
            >
              <option value="stt">stt</option>
              <option value="s2s">s2s</option>
            </Select>
          </Row>
          {bool("g-filler", "filler removal", s.filler_removal ?? true, (v) =>
            patch({ filler_removal: v }, "g-filler"),
          )}
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
