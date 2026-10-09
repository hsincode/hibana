import type { SubagentModel, SubagentEffort, ServiceTier } from "@hibana/shared/settings";
import {
  defaultMultiAgentRoles,
  modelEffort,
  MULTI_AGENT_ROLES,
  SERVICE_TIERS,
  subagentMode,
  subagentModePatch,
  type MultiAgentRole,
  type MultiAgentRoles,
  type RoleEffort,
  type RoleModel,
  type SubagentMode,
} from "@hibana/shared/settings";
import { REASONING_EFFORTS, isAutoRoute, subagentsUnsupported } from "@hibana/shared/catalog";
import { Select, ThemeMenu } from "./controls";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { SkillsPage } from "./Skills";
import { ChatgptAccounts } from "./ChatgptAccounts";
import { AnalyticsPage } from "./Analytics";
import { Pencil, ChevronDown, Menu, X } from "lucide-react";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  api,
  apiCached,
  apiUrl,
  clearApiCache,
  type Artifact,
  type Catalog,
  type GuildSettings,
  type GuildSummary,
  type Me,
  type Preset,
  type UserSettings,
} from "./api";
import {
  Alert,
  Avatar,
  Badge,
  Empty,
  Field,
  Icon,
  Loading,
  Modal,
  Panel,
  ProviderMark,
  Skeleton,
  ToastArea,
  useDocumentTitle,
  BooleanSetting,
  cdnUrl,
  providerMeta,
  useActiveSection,
  useToasts,
} from "./ui";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    apiCached<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  // セッション判定が終わるまでは Login にも一覧にも飛ばさない（ちらつき防止）
  if (me === undefined) {
    return (
      <div className="center-full">
        <Loading />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={me ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/*"
        element={
          me ? (
            <Shell me={me} onLogout={() => setMe(null)}>
              <Routes>
                <Route path="/" element={<GuildList />} />
                <Route path="/me" element={<MePage />} />
                <Route path="/artifacts" element={<ArtifactsPage />} />
                <Route path="/skills" element={<SkillsPage />} />
                <Route path="/g/:id" element={<GuildPage />} />
                <Route
                  path="/users"
                  element={
                    me.can_manage_users ? (
                      <UsersPage me={me} />
                    ) : (
                      <Navigate to="/" />
                    )
                  }
                />
                <Route
                  path="/models"
                  element={
                    me.can_manage_users ? <ModelsPage /> : <Navigate to="/" />
                  }
                />
                <Route
                  path="/analytics"
                  element={
                    me.can_view_analytics ? <AnalyticsPage /> : <Navigate to="/" />
                  }
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

function Login() {
  useDocumentTitle("ログイン");
  return (
    <div className="login">
      <div className="login-theme">
        <ThemeMenu />
      </div>
      <div className="login-card">
        <div className="brand-mark">
          <Icon.logo size={26} />
        </div>
        <h1>Hibana</h1>
        <p>Discord ワークスペース</p>
        <a
          className="btn btn-lg btn-block discord"
          href={apiUrl("/auth/discord")}
        >
          <Icon.discord />
          Discord でログイン
        </a>
        <p className="login-foot">Discord アカウントで安全にログイン</p>
      </div>
    </div>
  );
}

function Shell({
  me,
  onLogout,
  children,
}: {
  me: Me;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !navigation.current?.contains(target) &&
        !menuButton.current?.contains(target)
      )
        setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  async function logout() {
    setBusy(true);
    try {
      await api("/auth/logout", { method: "POST" });
    } finally {
      // 別アカウントで入り直したときに前のセッションの結果を出さない
      clearApiCache();
      setBusy(false);
      onLogout();
      nav("/login");
    }
  }

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">
        メインコンテンツへ
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <Icon.logo />
          </span>
          <span>Hibana</span>
        </Link>

        <button
          ref={menuButton}
          className="btn btn-ghost icon-button mobile-menu"
          aria-label={
            menuOpen ? "ナビゲーションを閉じる" : "ナビゲーションを開く"
          }
          aria-expanded={menuOpen}
          aria-controls="main-navigation"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {menuOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <nav
          ref={navigation}
          id="main-navigation"
          className={`topnav ${menuOpen ? "is-open" : ""}`}
          aria-label="メイン"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a")) setMenuOpen(false);
          }}
        >
          <NavLink
            to="/"
            end
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon.server />
            サーバー
          </NavLink>
          <NavLink
            to="/me"
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon.user />
            マイ設定
          </NavLink>
          <NavLink
            to="/artifacts"
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon.globe />
            成果物
          </NavLink>
          <NavLink
            to="/skills"
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            <Icon.logo />
            スキル
          </NavLink>
          {me.can_manage_users && (
            <>
              <NavLink
                to="/users"
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                <Icon.users />
                ユーザー
              </NavLink>
              <NavLink
                to="/models"
                className={({ isActive }) => (isActive ? "active" : "")}
              >
                <Icon.cpu />
                モデル
              </NavLink>
            </>
          )}
          {me.can_view_analytics && (
            <NavLink
              to="/analytics"
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <Icon.gauge />
              利用料
            </NavLink>
          )}
        </nav>

        <div className="topbar-spacer" />

        <ThemeMenu />
        <Dropdown.Root>
          <Dropdown.Trigger
            className="user-chip"
            aria-label="アカウントメニュー"
          >
            <Avatar
              src={cdnUrl("avatars", me.id, me.avatar)}
              name={me.username}
            />
            <span className="name">{me.username}</span>
            <ChevronDown size={14} />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              className="dropdown-menu account-menu"
              align="end"
              sideOffset={8}
              collisionPadding={12}
            >
              <Dropdown.Label className="account-label">
                <strong>{me.username}</strong>
                <Badge tone="muted">{me.role}</Badge>
              </Dropdown.Label>
              <Dropdown.Separator className="menu-separator" />
              <Dropdown.Item className="dropdown-item" asChild>
                <Link to="/me">
                  <Icon.user />
                  マイ設定
                </Link>
              </Dropdown.Item>
              <Dropdown.Item
                className="dropdown-item danger-item"
                disabled={busy}
                onSelect={() => void logout()}
              >
                <Icon.logout />
                ログアウト
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      </header>

      <main id="main-content" className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

function NotFound() {
  return (
    <div className="page">
      <Empty
        title="ページが見つからない"
        body="URL を確認してね。"
        action={
          <Link className="btn" to="/">
            サーバー一覧へ
          </Link>
        }
      />
    </div>
  );
}

/* ============================================================
   成果物（publish_site）
   ============================================================ */
function ArtifactsPage() {
  const [sites, setSites] = useState<Artifact[] | null>(null);
  const [guilds, setGuilds] = useState<GuildSummary[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  useDocumentTitle("成果物");

  const load = useCallback(() => {
    api<{ sites: Artifact[] }>("/api/artifacts")
      .then((r) => setSites(r.sites))
      .catch((e) => setErr(String((e as Error).message ?? e)));
  }, []);

  useEffect(() => {
    load();
    apiCached<{ guilds: GuildSummary[] }>("/api/guilds")
      .then((r) => setGuilds(r.guilds))
      .catch(() => undefined);
  }, [load]);

  const names = useMemo(
    () => Object.fromEntries(guilds.map((g) => [g.id, g.name])),
    [guilds],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>成果物</h1>
          <p className="lead">
            ボットが公開したサイト。既定は約 48 時間で消えます。1
            ヶ月延命か永久化できます。永久化の解除もここから。
          </p>
        </div>
      </div>
      {err && <Alert>{err}</Alert>}
      <ArtifactTable
        sites={sites}
        guildNames={names}
        showGuild
        onAct={async (site, action, ok) => {
          if (!site.guild_id)
            throw new Error("DM の成果物はダッシュボードから操作できません");
          await api(`/api/guilds/${site.guild_id}/artifacts/${site.token}`, {
            method: "PATCH",
            body: JSON.stringify({ action }),
          });
          push("ok", ok);
          load();
        }}
        onError={(msg) => push("error", msg)}
      />
      <ToastArea toasts={toasts} />
    </div>
  );
}

function GuildArtifactsPanel({ guildId }: { guildId: string }) {
  const [sites, setSites] = useState<Artifact[] | null>(null);
  const { toasts, push } = useToasts();

  const load = useCallback(() => {
    api<{ sites: Artifact[] }>(`/api/guilds/${guildId}/artifacts`)
      .then((r) => setSites(r.sites))
      .catch(() => setSites([]));
  }, [guildId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Panel
      id="artifacts"
      icon={<Icon.globe />}
      title="成果物"
      desc="このサーバーで公開中のサイト。1 ヶ月延命・永久化・永久化解除はボットが次に同期したときに反映されます。"
    >
      <ArtifactTable
        sites={sites}
        showGuild={false}
        onAct={async (site, action, ok) => {
          await api(`/api/guilds/${guildId}/artifacts/${site.token}`, {
            method: "PATCH",
            body: JSON.stringify({ action }),
          });
          push("ok", ok);
          load();
        }}
        onError={(msg) => push("error", msg)}
      />
      <ToastArea toasts={toasts} />
    </Panel>
  );
}

function ArtifactTable({
  sites,
  guildNames,
  showGuild,
  onAct,
  onError,
}: {
  sites: Artifact[] | null;
  guildNames?: Record<string, string>;
  showGuild: boolean;
  onAct: (
    site: Artifact,
    action: "month" | "permanent" | "unpermanent",
    ok: string,
  ) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "ttl" | "month" | "permanent">(
    "all",
  );
  const [busy, setBusy] = useState<string | null>(null);

  if (!sites) return <Skeleton height={160} />;
  const shown = sites.filter((s) =>
    filter === "all" ? true : s.retention === filter,
  );

  async function act(
    site: Artifact,
    action: "month" | "permanent" | "unpermanent",
    ok: string,
  ) {
    setBusy(`${site.token}:${action}`);
    try {
      await onAct(site, action, ok);
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <div className="chips" role="group" aria-label="成果物の絞り込み">
        {(
          [
            ["all", "すべて"],
            ["ttl", "既定"],
            ["month", "1ヶ月"],
            ["permanent", "永久"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`chip ${filter === key ? "active" : ""}`}
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
          >
            {label}
            <span className="n">
              {key === "all"
                ? sites.length
                : sites.filter((s) => s.retention === key).length}
            </span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Empty
          title="公開中のサイトはない"
          body="ボットが publish_site するとここに出ます。"
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {showGuild && <th>サーバー</th>}
                <th>パス</th>
                <th>URL</th>
                <th>期限</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.token}>
                  {showGuild && (
                    <td>
                      {(s.guild_id && guildNames?.[s.guild_id]) ||
                        s.guild_id ||
                        "DM"}
                    </td>
                  )}
                  <td className="mono">{s.source_path || "—"}</td>
                  <td>
                    <a
                      className="artifact-url"
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.url}
                    </a>
                  </td>
                  <td>
                    <RetentionBadge site={s} />
                    {s.pending && (
                      <Badge tone="accent">
                        {s.pending === "permanent"
                          ? "永久化待ち"
                          : s.pending === "unpermanent"
                            ? "解除待ち"
                            : "延命待ち"}
                      </Badge>
                    )}
                  </td>
                  <td>
                    <div className="inline-actions artifact-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={!!busy || s.retention === "permanent"}
                        onClick={() =>
                          void act(s, "month", "1ヶ月延命を依頼した")
                        }
                      >
                        1ヶ月
                      </button>
                      {s.retention === "permanent" ? (
                        <button
                          type="button"
                          className="btn"
                          disabled={!!busy}
                          onClick={() =>
                            void act(s, "unpermanent", "永久化の解除を依頼した")
                          }
                        >
                          永久化解除
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={!!busy}
                          onClick={() =>
                            void act(s, "permanent", "永久化を依頼した")
                          }
                        >
                          永久化
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RetentionBadge({ site }: { site: Artifact }) {
  if (site.retention === "permanent") return <Badge tone="ok">永久</Badge>;
  const exp =
    site.expires_at_unix > 0 ? new Date(site.expires_at_unix * 1000) : null;
  const label = exp
    ? exp.toLocaleString("ja-JP", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  return (
    <Badge tone={site.retention === "month" ? "accent" : "muted"}>
      {site.retention === "month" ? `1ヶ月 · ${label}` : label}
    </Badge>
  );
}

/* ============================================================
   サーバー一覧
   ============================================================ */
function GuildList() {
  const [guilds, setGuilds] = useState<GuildSummary[] | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  useDocumentTitle("サーバー一覧");

  useEffect(() => {
    apiCached<{ guilds: GuildSummary[] }>("/api/guilds")
      .then((r) => setGuilds(r.guilds))
      .catch((e) => setErr(String(e.message ?? e)));
    // カタログはプロバイダマークの解決にだけ使うので、失敗しても一覧は出す
    apiCached<Catalog>("/api/catalog")
      .then((c) => setPresets(c.presets))
      .catch(() => undefined);
  }, []);

  /** model 文字列 -> provider。同名 model が複数プロバイダにある場合は特定しない。 */
  const providerOf = (model: string): string | undefined => {
    const hits = presets.filter(
      (p) => (p.model ?? p.label.split("/").pop()?.trim()) === model,
    );
    const uniq = new Set(hits.map((h) => h.provider));
    return uniq.size === 1 ? hits[0]?.provider : undefined;
  };

  const shown = useMemo(() => {
    if (!guilds) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return guilds;
    // ID でも探せるようにする（同名サーバーの区別に要る）
    return guilds.filter(
      (g) => g.name.toLowerCase().includes(needle) || g.id.includes(needle),
    );
  }, [guilds, q]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>サーバー</h1>
          <p className="lead">
            {guilds
              ? `${guilds.length} 件のサーバーを管理できます。`
              : "ボットが入っているサーバーを読み込み中…"}
          </p>
        </div>
        {guilds && guilds.length > 0 && (
          <div className="spacer">
            <div className="search">
              <Icon.search />
              <input
                type="search"
                value={q}
                placeholder="名前 / ID で絞り込み"
                aria-label="サーバーを絞り込み"
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
        )}
      </div>

      {err && <Alert>{err}</Alert>}

      {!guilds && !err && (
        <div className="card-grid">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={78} />
          ))}
        </div>
      )}

      {shown && shown.length === 0 && (
        <Empty
          title={q ? "一致するサーバーがない" : "まだサーバーがない"}
          body={
            q
              ? "検索語を変えてみて。"
              : "ボットをサーバーに招待すると、ここに出てきます。"
          }
        />
      )}

      {shown && shown.length > 0 && (
        <div className="card-grid">
          {shown.map((g) => (
            <Link key={g.id} to={`/g/${g.id}`} className="guild-card">
              <Avatar
                square
                src={cdnUrl("icons", g.id, g.icon)}
                name={g.name}
              />
              <div className="body">
                <div className="title">{g.name}</div>
                <div className="meta">
                  {g.preset ? (
                    <Badge tone="accent">
                      <span
                        className="prov-dot"
                        style={{
                          color: providerMeta(providerOf(g.preset)).color,
                        }}
                      >
                        <ProviderMark
                          provider={providerOf(g.preset)}
                          size={13}
                        />
                      </span>
                      {g.preset}
                    </Badge>
                  ) : (
                    <Badge tone="muted">
                      <Icon.layers size={12} />
                      env 既定
                    </Badge>
                  )}
                </div>
              </div>
              <Icon.chevronRight className="chev" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   個人設定（ギルド上書き）
   ============================================================ */
const ME_SECTIONS = [
  { id: "model", label: "モデル", icon: <Icon.layers /> },
  { id: "agents", label: "サブエージェント", icon: <Icon.cpu /> },
  { id: "jev", label: "Jev", icon: <Icon.flask /> },
  { id: "context", label: "コンテキスト", icon: <Icon.doc /> },
];

type OverlaySettings = {
  selection?: {
    provider?: string;
    model?: string;
    effort?: string | null;
  } | null;
  effort?: string | null;
  service_tier?: ServiceTier | null;
  subagent_enabled?: boolean | null;
  ultra_mode?: boolean | null;
  multi_agent?: boolean | null;
  multi_agent_roles?: MultiAgentRoles | null;
  subagent_model?: SubagentModel | null;
  subagent_effort?: SubagentEffort | null;
  jev_enabled?: boolean | null;
  jev_task_enabled?: boolean | null;
  context?: { text: string; persona_override: boolean } | null;
};

type SaveState = "idle" | "saving" | "saved" | "failed";

/** PATCH body → 画面用 settings。サーバーの applyPatch と同じ形にして、往復前にタイルが光るようにする。 */
function applyLocalPatch<T extends OverlaySettings>(
  current: T,
  body: Record<string, unknown>,
  presets: Preset[],
  blankReset = false,
): T {
  const next: Record<string, unknown> = { ...current };

  if (body.preset === "reset") {
    // マイ設定のデフォルトは「未設定」なので、押した瞬間に選択を外す。
    // サーバー設定のリセットは環境の具体値で、応答が来るまで今の表示を残す。
    if (blankReset) {
      next.selection = null;
      next.effort = null;
    }
  } else if (typeof body.preset === "string") {
    const p = presets.find((x) => x.id === body.preset);
    if (p) {
      next.selection = {
        provider: p.provider,
        model: p.model ?? p.label.split("/").pop()?.trim(),
        effort:
          body.effort !== undefined
            ? (body.effort as string | null)
            : modelEffort(p.model ?? p.label),
      };
      next.effort = (next.selection as { effort: string }).effort;
    }
  } else if (body.effort !== undefined && current.selection) {
    next.selection = {
      ...current.selection,
      effort: body.effort as string | null,
    };
  }

  if (body.effort !== undefined) next.effort = body.effort;

  if (body.context_clear) {
    next.context = { text: "", persona_override: false };
  } else if (
    body.context_text !== undefined ||
    body.persona_override !== undefined
  ) {
    const prev = current.context ?? { text: "", persona_override: false };
    next.context = {
      text:
        body.context_text === undefined
          ? prev.text
          : ((body.context_text as string | null) ?? ""),
      persona_override:
        body.persona_override === undefined
          ? prev.persona_override
          : Boolean(body.persona_override),
    };
  }

  // selection/context の組み立てと effort の同期は上で処理済み。
  const mapped = new Set([
    "preset",
    "effort",
    "context_text",
    "persona_override",
    "context_clear",
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (!mapped.has(k)) next[k] = v;
  }
  return next as T;
}

/**
 * PATCH の往復を待たずに画面を更新する。
 * モデルカードは「押した時点で切り替わる」と書いてあるのに、保存完了まで
 * 選択が動かないと体感が遅れる。失敗時は最後にサーバーが受け付けた値へ戻し、
 * 完了・失敗はトーストで知らせる。
 *
 * 連打はキューに積んで in-flight 中の分をまとめる。guild PATCH は行全体の
 * 読み書きなので、同時に 2 本飛ばすと先に返った古い選択で上書きされる。
 */
function useOptimisticPatch<T extends OverlaySettings>(opts: {
  settings: T | null;
  setSettings: (next: T) => void;
  presets: Preset[];
  send: (body: Record<string, unknown>) => Promise<{ settings: T }>;
  push: (kind: "ok" | "error", text: string) => void;
  scope?: string;
  /** マイ設定の「デフォルト」は null。サーバー設定のリセットとは表示を分ける。 */
  blankReset?: boolean;
}): {
  patch: (body: Record<string, unknown>, ok?: string) => void;
  save: SaveState;
} {
  const [save, setSave] = useState<SaveState>("idle");
  const settingsRef = useRef(opts.settings);
  settingsRef.current = opts.settings;
  const confirmedRef = useRef<T | null>(null);
  const pendingRef = useRef<{ body: Record<string, unknown>; ok: string }[]>(
    [],
  );
  const sendingRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const lastScope = useRef(opts.scope);
  const scopeChanged = lastScope.current !== opts.scope;
  if (scopeChanged) {
    lastScope.current = opts.scope;
    confirmedRef.current = null;
    pendingRef.current = [];
    sendingRef.current = false;
  }
  // サーバー切替の同じ描画では前ギルドの settings が残っているので、種まきしない。
  if (!scopeChanged && confirmedRef.current == null && opts.settings) {
    confirmedRef.current = opts.settings;
  }

  useEffect(() => {
    setSave("idle");
  }, [opts.scope]);

  const flush = useCallback(() => {
    if (sendingRef.current) return;
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];
    sendingRef.current = true;
    const merged = Object.assign({}, ...batch.map((x) => x.body)) as Record<
      string,
      unknown
    >;
    const ok = batch[batch.length - 1]!.ok;
    setSave("saving");

    void (async () => {
      const { send, setSettings, push, presets, blankReset } = optsRef.current;
      try {
        const r = await send(merged);
        confirmedRef.current = r.settings;
        if (pendingRef.current.length === 0) {
          setSettings(r.settings);
          settingsRef.current = r.settings;
          setSave("saved");
        } else {
          // 後続クリックを消さない: サーバー行の上にまだ送っていない PATCH を載せる。
          let next = r.settings;
          for (const p of pendingRef.current)
            next = applyLocalPatch(next, p.body, presets, blankReset);
          setSettings(next);
          settingsRef.current = next;
        }
        push("ok", ok);
      } catch (e) {
        if (pendingRef.current.length === 0) {
          const rollback = confirmedRef.current;
          if (rollback) {
            setSettings(rollback);
            settingsRef.current = rollback;
          }
          setSave("failed");
        }
        push("error", String((e as Error).message ?? e));
      } finally {
        sendingRef.current = false;
        flush();
      }
    })();
  }, []);

  const patch = useCallback(
    (body: Record<string, unknown>, ok = "保存した") => {
      const current = settingsRef.current;
      if (!current) return;
      const next = applyLocalPatch(current, body, optsRef.current.presets, optsRef.current.blankReset);
      optsRef.current.setSettings(next);
      settingsRef.current = next;
      pendingRef.current.push({ body, ok });
      setSave("saving");
      flush();
    },
    [flush],
  );

  return { patch, save };
}

function MePage() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  const { patch, save } = useOptimisticPatch<UserSettings>({
    settings,
    setSettings,
    presets: cat?.presets ?? [],
    send: (body) =>
      api<{ settings: UserSettings }>("/api/me/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    push,
    blankReset: true,
  });
  useDocumentTitle("マイ設定");

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
  const active = useActiveSection(
    ME_SECTIONS.map((s) => s.id),
    ready,
  );

  if (err && !ready) {
    return (
      <div className="page">
        <Alert>{err}</Alert>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="page">
        <div className="stack">
          <Skeleton height={92} />
          <Skeleton height={210} />
          <Skeleton height={210} />
        </div>
      </div>
    );
  }

  const s = settings!;
  const c = cat!;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>マイ設定</h1>
          <p className="lead">
            あなたがボットに話しかけるときだけ効きます。デフォルトの項目はサーバー設定に従い、変えた項目だけ上書きします。
          </p>
        </div>
        <div className="spacer">
          <SaveIndicator state={save} />
        </div>
      </div>

      <div className="guild-layout">
        <nav className="section-rail" aria-label="設定セクション">
          {ME_SECTIONS.map((sec) => (
            <a
              key={sec.id}
              href={`#${sec.id}`}
              className={active === sec.id ? "active" : ""}
            >
              {sec.icon}
              {sec.label}
            </a>
          ))}
        </nav>

        <div className="stack">
          <section className="panel">
            <div className="summary">
              <div className="item">
                <span className="k">
                  <Icon.layers size={13} />
                  model
                </span>
                <span className="v">
                  {s.selection?.model ? (
                    <>
                      <span
                        className="prov-dot"
                        style={{
                          color: providerMeta(s.selection.provider).color,
                        }}
                        title={providerMeta(s.selection.provider).label}
                      >
                        <ProviderMark
                          provider={s.selection.provider}
                          size={15}
                        />
                      </span>
                      {s.selection.model}
                    </>
                  ) : (
                    "デフォルト"
                  )}
                </span>
              </div>
              <div className="item">
                <span className="k">
                  <Icon.gauge size={13} />
                  effort
                </span>
                <span className="v">{s.effort ?? "デフォルト"}</span>
              </div>
              <div className="item">
                <span className="k">
                  <Icon.doc size={13} />
                  context
                </span>
                <span className="v">{personalContextLabel(s.context)}</span>
              </div>
            </div>
          </section>

          <OverlayPanels
            catalog={c}
            settings={s}
            role={me?.role}
            resetLabel="デフォルトに戻す"
            inherit
            onPatch={patch}
          />

          <ContextPanel
            title="ユーザーコンテキスト"
            desc="空のままならサーバーのコンテキストに従います。文章を保存したときだけ、あなたへの応答に追加します。"
            placeholder="例: タメ口で話して。敬語は禁止。"
            value={s.context?.text ?? ""}
            personaOverride={s.context?.persona_override ?? false}
            onSaveText={(text) =>
              patch({ context_text: text || null }, "コンテキストを保存した")
            }
            onPersona={(v) => patch({ persona_override: v })}
            onClear={() =>
              patch({ context_clear: true }, "コンテキストを消した")
            }
          />
        </div>
      </div>

      <ToastArea toasts={toasts} />
    </div>
  );
}

function OverlayPanels({
  catalog: c,
  settings: s,
  role,
  resetLabel,
  inherit = false,
  onPatch,
}: {
  catalog: Catalog;
  settings: OverlaySettings;
  role?: string;
  resetLabel: string;
  /** マイ設定だけ。null はサーバー設定に従うデフォルト。 */
  inherit?: boolean;
  onPatch: (body: Record<string, unknown>, ok?: string) => void;
}) {
  // Admin catalog includes unpublished SKUs for /models. Guild / マイ設定
  // pickers must not list them — leftover guilds already on one still show
  // as selected via provider+model, they just cannot newly pick it.
  const pickable = c.presets.filter((p) => p.published !== false);
  // Ultra runs turns at xhigh without overwriting the stored effort, so the
  // picker keeps the value that applies again after leaving Ultra.
  const ultracode = !(inherit && s.subagent_enabled == null && s.ultra_mode == null && s.multi_agent == null) &&
    subagentMode(s) === "ultra";
  return (
    <>
      <Panel
        id="model"
        icon={<Icon.layers />}
        title="/switch モデル"
        desc="親エージェントのモデルです。サブエージェントが multi のときは統括役が使います。"
      >
        <ModelPicker
          presets={pickable}
          available={c.available_presets}
          selection={s.selection ?? null}
          role={role}
          roles={c.roles}
          specials={inherit ? [{
            key: "inherit",
            label: "デフォルト",
            icon: <Icon.layers size={15} />,
            active: !s.selection,
            onSelect: () => onPatch({ preset: "reset" }, "デフォルトに戻した"),
          }] : undefined}
          onPick={(id) => onPatch({ preset: id }, "モデルを切り替えた")}
        />
        <div className="fields fields-fill" style={{ marginTop: "1.15rem" }}>
          <Field
            label="effort"
            icon={<Icon.gauge />}
            hint={`${inherit
              ? "デフォルトはサーバーの effort です。モデルを変えるとそのモデルの推奨値になります。"
              : "推論の深さ。モデルを変えるとそのモデルの推奨値になります。"}${ultracode
              ? " サブエージェントが ultra（Ultracode）の間は xhigh で動き、この値は ultra を外すと使われます。"
              : ""}${s.selection?.provider && s.selection.model && isAutoRoute({ provider: s.selection.provider, model: s.selection.model })
              ? " Anthropic / Auto では Jev の判定でモデルと effort（max は使いません）が決まり、この値は使われません。"
              : ""}`}
          >
            {(fid) => (
              <Select
                id={fid}
                value={inherit ? (s.effort ?? "") : (s.effort ?? s.selection?.effort ?? "max")}
                onValueChange={(e) => onPatch({ effort: e || null })}
              >
                {inherit && <option value="">デフォルト（サーバー設定）</option>}
                {c.efforts.filter(e => e !== "ultra").map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Service Tier" icon={<Icon.gauge />}
            hint="OpenAI / Codex / ChatGPT に適用し、サブエージェントにも引き継ぎます。利用可否・料金・速度は接続先によります。">
            {(id) => <Select id={id} aria-label="Service Tier"
              value={inherit ? (s.service_tier ?? "") : (s.service_tier ?? "auto")}
              onValueChange={(tier) => onPatch({ service_tier: tier || null })}>
              {inherit && <option value="">デフォルト（サーバー設定）</option>}
              {SERVICE_TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
            </Select>}
          </Field>
        </div>
        <div
          className="panel-foot"
          style={{ margin: "1.15rem -1.15rem -1.15rem" }}
        >
          <span className="field-hint">
            現在: {s.selection?.model ?? resetLabel}
          </span>
          <button
            type="button"
            className="btn btn-danger"
            style={{ marginLeft: "auto" }}
            onClick={() =>
              onPatch({ preset: "reset" }, "デフォルトを設定した")
            }
          >
            <Icon.reset />
            {resetLabel}
          </button>
        </div>
      </Panel>
      <SubagentPanel catalog={c} settings={s} role={role} pickable={pickable} inherit={inherit} onPatch={onPatch} />
      <JevPanel settings={s} inherit={inherit} onPatch={onPatch} />
    </>
  );
}

const SUBAGENT_MODES: { mode: SubagentMode; body: string }[] = [
  { mode: "off", body: "サブエージェントを使わず、親だけで処理します。" },
  { mode: "on", body: "ユーザーや指示で求められたときだけ委譲します。「ultracode」と書いた依頼はその回だけワークフローで実行します。" },
  { mode: "ultra", body: "Claude Code の Ultracode です。推論を xhigh にし、実質的な依頼ごとにワークフロー（複数エージェントを編成するスクリプト）を実行します。" },
  { mode: "multi", body: "統括役が調査・作成・検証に分担し、納品前に検証します。" },
];

const ROLE_META: Record<MultiAgentRole, { label: string; body: string }> = {
  explorer: { label: "調査", body: "検索・Web・ファイルを読むだけで根拠を集めます。" },
  worker: { label: "作成", body: "ファイル・コードなどの成果物を作ります。送信や公開はしません。" },
  reviewer: { label: "検証", body: "回答案や成果物を独立に確認します。納品前のレビューも担当します。" },
};

type FixedEffort = Extract<RoleEffort, { mode: "fixed" }>["effort"];

/** Mirrors the bot's explorer cap (roleEffort) for the effective-value hint. */
function capEffort(effort: string, cap: string): string {
  const order: readonly string[] = REASONING_EFFORTS;
  if (!order.includes(effort)) return effort;
  return order[Math.min(order.indexOf(effort), order.indexOf(cap))]!;
}

function SubagentPanel({
  catalog: c,
  settings: s,
  role,
  pickable,
  inherit = false,
  onPatch,
}: {
  catalog: Catalog;
  settings: OverlaySettings;
  role?: string;
  pickable: Preset[];
  inherit?: boolean;
  onPatch: (body: Record<string, unknown>, ok?: string) => void;
}) {
  // All three switches null is デフォルト. subagentMode() would otherwise
  // read that as "on", because a missing Ultra flag is not Ultra.
  const mode: SubagentMode | "default" = inherit &&
    s.subagent_enabled == null && s.ultra_mode == null && s.multi_agent == null
    ? "default"
    : subagentMode(s);
  const modeChoices: { mode: SubagentMode | "default"; body: string }[] = inherit
    ? [{ mode: "default", body: "サーバー設定に従います。ここを変えると、このモードだけ上書きします。" }, ...SUBAGENT_MODES]
    : SUBAGENT_MODES;
  const efforts = c.efforts.filter((e) => e !== "ultra");
  const firstPreset = () =>
    pickable.find((p) => roleAllows(role, p.min_role, c.roles) &&
      (!c.available_presets || c.available_presets.includes(p.id)))?.id;
  const roles = s.multi_agent_roles ?? defaultMultiAgentRoles();
  // Send the whole role map so the optimistic overlay never shows a partial one.
  const patchRole = (r: MultiAgentRole, change: Partial<MultiAgentRoles[MultiAgentRole]>) =>
    onPatch({ multi_agent_roles: { ...roles, [r]: { ...roles[r], ...change } } });
  const presetName = (id: string) => {
    const p = c.presets.find((x) => x.id === id);
    return p?.model ?? p?.label ?? id;
  };
  const parentModel = s.selection?.model ?? (inherit ? "サーバー設定" : "既定のモデル");
  const parentEffort = s.effort ?? s.selection?.effort ?? (inherit ? "サーバー設定" : "既定");
  const common = {
    model: s.subagent_model ?? (inherit ? null : { mode: "auto" as const }),
    effort: s.subagent_effort ?? (inherit ? null : { mode: "auto" as const }),
  };
  // What the bot will actually use, so "only the reviewer on Sol" is visible
  // without mentally combining the common policy and the role override.
  const effectiveModel = (p: RoleModel) => {
    const policy = p.mode === "default" ? common.model : p;
    if (!policy || !("mode" in policy)) return "サーバー設定";
    if (policy.mode === "fixed") return presetName(policy.preset);
    if (policy.mode === "same") return parentModel;
    return `${parentModel}（任意）`;
  };
  const effectiveEffort = (r: MultiAgentRole, p: RoleEffort) => {
    const policy = p.mode === "default" ? common.effort : p;
    if (!policy || !("mode" in policy)) return "サーバー設定";
    if (policy.mode === "fixed") return policy.effort;
    if (policy.mode === "same") return parentEffort;
    return `${r === "explorer" ? capEffort(String(parentEffort), "medium") : parentEffort}（任意）`;
  };
  return (
    <Panel
      id="agents"
      icon={<Icon.cpu />}
      title="サブエージェント"
      desc={`変更は次のメッセージから反映され、処理中の応答には適用されません。${subagentsUnsupported(s.selection?.provider)
        ? " Anthropic のモデル（Auto を含む）ではサブエージェントは常に off で動き、この設定は他のモデルに切り替えると使われます。"
        : ""}`}
    >
      <div className={`mode-grid${inherit ? " has-inherit" : ""}`} role="radiogroup" aria-label="サブエージェント">
        {modeChoices.map((o) => (
          <button
            key={o.mode}
            type="button"
            role="radio"
            aria-checked={mode === o.mode}
            className={`mode-card${mode === o.mode ? " is-selected" : ""}`}
            onClick={() => {
              if (mode === o.mode) return;
              onPatch(o.mode === "default"
                ? { subagent_enabled: null, ultra_mode: null, multi_agent: null }
                : subagentModePatch(o.mode));
            }}
          >
            <span className="mode-title">
              {o.mode === "default" ? "デフォルト" : o.mode}
              {mode === o.mode && <Icon.check size={15} />}
            </span>
            <span className="mode-body">{o.body}</span>
          </button>
        ))}
      </div>

      {mode !== "off" && (
        <>
          <h3 className="subhead">
            共通のモデルと effort
            <span>{mode === "multi" ? "役割ごとの設定が「共通設定に従う」のときに使います。" : "すべてのサブエージェントに適用します。"}</span>
          </h3>
          <div className="fields">
            <Field label="モデル" icon={<Icon.cpu />}>
              {(id) => <Select id={id}
                aria-label="サブエージェントのモデル選択方式"
                value={common.model?.mode ?? ""}
                onValueChange={(next) => {
                  if (!next) {
                    onPatch({ subagent_model: null });
                    return;
                  }
                  const preset = firstPreset();
                  if (next === "fixed" && !preset) return;
                  onPatch({ subagent_model: next === "fixed"
                    ? { mode: next, preset: s.subagent_model?.mode === "fixed" ? s.subagent_model.preset : preset }
                    : { mode: next } });
                }}
              >
                {inherit && <option value="">デフォルト（サーバー設定）</option>}
                <option value="auto">任意（エージェントが選択）</option>
                <option value="same">同一（親エージェントと同じ）</option>
                <option value="fixed">固定（指定したモデル）</option>
              </Select>}
            </Field>
            {s.subagent_model?.mode === "fixed" && (
              <PresetField
                label="固定モデル" icon={<Icon.cpu />} title="サブエージェントの固定モデル"
                presets={pickable} available={c.available_presets}
                value={s.subagent_model.preset} specials={[]} role={role} roles={c.roles}
                onChange={(preset) => { if (preset) onPatch({ subagent_model: { mode: "fixed", preset } }); }}
              />
            )}
            <Field label="effort" icon={<Icon.gauge />}>
              {(id) => <Select id={id}
                aria-label="サブエージェントの effort 選択方式"
                value={common.effort?.mode ?? ""}
                onValueChange={(next) => {
                  if (!next) {
                    onPatch({ subagent_effort: null });
                    return;
                  }
                  onPatch({ subagent_effort: next === "fixed"
                    ? { mode: next, effort: s.subagent_effort?.mode === "fixed" ? s.subagent_effort.effort : "max" }
                    : { mode: next } });
                }}
              >
                {inherit && <option value="">デフォルト（サーバー設定）</option>}
                <option value="auto">任意（エージェントが選択）</option>
                <option value="same">同一（親エージェントと同じ）</option>
                <option value="fixed">固定（指定した effort）</option>
              </Select>}
            </Field>
            {s.subagent_effort?.mode === "fixed" && (
              <Field label="固定 effort" icon={<Icon.gauge />}>
                {(id) => <Select id={id} aria-label="サブエージェントの固定 effort" value={s.subagent_effort?.mode === "fixed" ? s.subagent_effort.effort : "max"}
                  onValueChange={(effort) => onPatch({ subagent_effort: { mode: "fixed", effort } })}>
                  {efforts.map(e => <option key={e} value={e}>{e}</option>)}
                </Select>}
              </Field>
            )}
          </div>
          <p className="field-hint" style={{ marginTop: 12 }}>
            任意ではエージェントがモデルや effort を指定でき、省略すると親を引き継ぎます。別モデルに変えた場合の effort はそのモデルの推奨値です。役割ごとの表示の「（任意）」は、エージェントが変更できる値です。
          </p>
        </>
      )}

      {mode === "multi" && inherit && !s.multi_agent_roles && (
        <div className="panel-foot" style={{ marginTop: "1.15rem" }}>
          <span className="field-hint">役割ごとの設定はサーバーに従っています。</span>
          <button type="button" className="btn" style={{ marginLeft: "auto" }}
            onClick={() => onPatch({ multi_agent_roles: defaultMultiAgentRoles() }, "役割の上書きを始めた")}>
            役割を個別に設定
          </button>
        </div>
      )}
      {mode === "multi" && (!inherit || s.multi_agent_roles) && (
        <>
          <h3 className="subhead">
            役割ごとの設定
            <span>{inherit ? "変えた役割だけを保存します。デフォルトに戻すとサーバーの役割設定に従います。" : "役割ごとにモデルと effort を上書きできます。"}</span>
          </h3>
          {inherit && (
            <div className="inline-actions" style={{ marginBottom: 8 }}>
              <button type="button" className="btn" onClick={() => onPatch({ multi_agent_roles: null }, "役割をデフォルトに戻した")}>
                <Icon.reset />
                デフォルトに戻す
              </button>
            </div>
          )}
          <div className="role-table">
            <div className="role-row is-parent">
              <div className="role-name"><strong>統括役</strong><span>root</span></div>
              <p className="role-desc">分担・統合・納品を担当します。モデルと effort は「/switch モデル」で変更します。</p>
              <div className="role-effective" aria-label="統括役の実際の設定">
                <span>{parentModel}</span><span>{parentEffort}</span>
              </div>
            </div>
            {MULTI_AGENT_ROLES.map((r) => {
              const meta = ROLE_META[r];
              const policy = roles[r];
              return (
                <div className="role-row" key={r}>
                  <div className="role-name"><strong>{meta.label}</strong><span>{r}</span></div>
                  <div className="role-main">
                    <p className="role-desc">{meta.body}</p>
                    <div className="role-controls">
                      <Field label="モデル">
                        {(id) => <Select id={id} aria-label={`${meta.label}のモデル`}
                          value={policy.model.mode}
                          onValueChange={(next) => {
                            if (next === "fixed") {
                              const preset = policy.model.mode === "fixed" ? policy.model.preset : firstPreset();
                              if (preset) patchRole(r, { model: { mode: "fixed", preset } });
                            } else patchRole(r, { model: { mode: next as "default" | "same" } });
                          }}>
                          <option value="default">共通設定に従う</option>
                          <option value="same">親と同じ</option>
                          <option value="fixed">固定</option>
                        </Select>}
                      </Field>
                      <Field label="effort">
                        {(id) => <Select id={id} aria-label={`${meta.label}の effort`}
                          value={policy.effort.mode}
                          onValueChange={(next) => patchRole(r, { effort: next === "fixed"
                            ? { mode: "fixed", effort: policy.effort.mode === "fixed" ? policy.effort.effort : "high" }
                            : { mode: next as "default" | "same" } })}>
                          <option value="default">共通設定に従う</option>
                          <option value="same">親と同じ</option>
                          <option value="fixed">固定</option>
                        </Select>}
                      </Field>
                      {policy.model.mode === "fixed" && (
                        <PresetField
                          label={`${meta.label}の固定モデル`} icon={<Icon.cpu />} title={`${meta.label}の固定モデル`}
                          presets={pickable} available={c.available_presets}
                          value={policy.model.preset} specials={[]} role={role} roles={c.roles}
                          onChange={(preset) => { if (preset) patchRole(r, { model: { mode: "fixed", preset } }); }}
                        />
                      )}
                      {policy.effort.mode === "fixed" && (
                        <Field label={`${meta.label}の固定 effort`}>
                          {(id) => <Select id={id} aria-label={`${meta.label}の固定 effort`}
                            value={policy.effort.mode === "fixed" ? policy.effort.effort : "high"}
                            onValueChange={(effort) => patchRole(r, { effort: { mode: "fixed", effort: effort as FixedEffort } })}>
                            {efforts.map(e => <option key={e} value={e}>{e}</option>)}
                          </Select>}
                        </Field>
                      )}
                    </div>
                  </div>
                  <div className="role-effective" aria-label={`${meta.label}の実際の設定`}>
                    <span>{effectiveModel(policy.model)}</span>
                    <span>{effectiveEffort(r, policy.effort)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Panel>
  );
}

function JevPanel({
  settings: s,
  inherit = false,
  onPatch,
}: {
  settings: OverlaySettings;
  inherit?: boolean;
  onPatch: (body: Record<string, unknown>, ok?: string) => void;
}) {
  const multi = s.multi_agent === true || (!inherit && subagentMode(s) === "multi");
  return (
    <Panel
      id="jev"
      icon={<Icon.flask />}
      title="Jev"
      desc="分類専用の評価モデルです。回答の生成や親のモデルは変えません。"
    >
      <div className="fields">
        <BooleanSetting
          label="Jev 判定"
          icon={<Icon.cpu />}
          value={s.jev_enabled}
          onChange={(v) => onPatch({ jev_enabled: v })}
          onDefault={inherit ? () => onPatch({ jev_enabled: null }) : undefined}
          hint={`根拠の照合・分類と、回答前の完了チェックに使います。本文や成果物が不足していれば作業を続けます。${multi ? "multi では依頼の開始時に分担も判定し、調査が必要なら調査役を先に起動します。" : ""}${inherit ? " デフォルトはサーバー設定です。" : ""}`}
        />
        <BooleanSetting
          label="Jev 行動選択モード"
          icon={<Icon.cpu />}
          value={s.jev_task_enabled}
          onChange={(v) => onPatch({ jev_task_enabled: v })}
          onDefault={inherit ? () => onPatch({ jev_task_enabled: null }) : undefined}
          hint={`親が操作候補を用意し、Jev が各操作を選んで実行します。Jev 判定とは独立しています。${multi ? "サブエージェントが multi のときは並列の分担を優先するため使用しません。" : "既定は OFF です。"}${inherit ? " デフォルトはサーバー設定です。" : ""}`}
        />
      </div>
    </Panel>
  );
}

/* ============================================================
   サーバー設定
   ============================================================ */
const SECTIONS = [
  { id: "model", label: "モデル", icon: <Icon.layers /> },
  { id: "agents", label: "サブエージェント", icon: <Icon.cpu /> },
  { id: "jev", label: "Jev", icon: <Icon.flask /> },
  { id: "tuning", label: "チューニング", icon: <Icon.sliders /> },
  { id: "mcp", label: "MCP", icon: <Icon.globe /> },
  { id: "behavior", label: "挙動", icon: <Icon.tools /> },
  { id: "triggers", label: "トリガー", icon: <Icon.search /> },
  { id: "artifacts", label: "成果物", icon: <Icon.globe /> },
  { id: "context", label: "コンテキスト", icon: <Icon.doc /> },
];

/** Old catalog without `triggers`. Same spellings as bot `BUILTIN_TRIGGERS`. */
const FALLBACK_TRIGGERS = [
  "hibana",
  "ひばな",
  "ヒバナ",
  "火花",
  "deepseek",
  "ds",
  "ディープシーク",
  "くじら",
  "クジラ",
  "鯨",
];
const TRIGGER_WORD_MAX = 32;
const TRIGGER_EXTRA_MAX = 32;

function triggerNamesEqual(a: string, b: string): boolean {
  const ascii = (s: string) => [...s].every((ch) => ch.charCodeAt(0) < 128);
  return ascii(a) && ascii(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalBuiltin(
  word: string,
  builtins: string[],
): string | undefined {
  return builtins.find((b) => triggerNamesEqual(b, word));
}

function GuildPage() {
  const { id } = useParams<{ id: string }>();
  const [cat, setCat] = useState<Catalog | null>(null);
  const [settings, setSettings] = useState<GuildSettings | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  const { patch, save } = useOptimisticPatch<GuildSettings>({
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
    push,
    scope: id,
  });
  const [guild, setGuild] = useState<GuildSummary | null>(null);
  useDocumentTitle(guild ? `${guild.name} — サーバー設定` : "サーバー設定");

  useEffect(() => {
    // Reuse the authorized list; cancellation prevents a previous route's
    // identity from appearing when navigating directly between guilds.
    let active = true;
    setGuild(null);
    apiCached<{ guilds: GuildSummary[] }>("/api/guilds")
      .then(({ guilds }) => { if (active) setGuild(guilds.find(g => g.id === id) ?? null); })
      .catch(() => {});
    return () => { active = false; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    setErr(null);
    setSettings(null);
    apiCached<Catalog>("/api/catalog")
      .then(setCat)
      .catch((e) => setErr(String(e.message ?? e)));
    apiCached<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
    api<{ settings: GuildSettings }>(`/api/guilds/${id}/settings`)
      .then((r) => setSettings(r.settings))
      .catch((e) => setErr(String(e.message ?? e)));
  }, [id]);

  const ready = !!cat && !!settings;
  const active = useActiveSection(
    SECTIONS.map((s) => s.id),
    ready,
  );

  if (err && !ready) {
    return (
      <div className="page">
        <BackLink />
        <Alert>{err}</Alert>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="page">
        <BackLink />
        <div className="stack">
          <Skeleton height={92} />
          <Skeleton height={210} />
          <Skeleton height={210} />
        </div>
      </div>
    );
  }

  const s = settings!;
  const c = cat!;

  return (
    <div className="page">
      <BackLink />
      <div className="page-head">
        <div>
          <div className="guild-heading">
            <Avatar key={guild?.id ?? id} square src={guild ? cdnUrl("icons", guild.id, guild.icon) : null} name={guild?.name ?? id ?? ""} />
            <div>
              <h1>{guild?.name ?? "サーバー設定"}</h1>
              <p className="lead">サーバー設定 · <span className="mono">{id}</span></p>
            </div>
          </div>
        </div>
        <div className="spacer">
          <SaveIndicator state={save} />
        </div>
      </div>

      <div className="guild-layout">
        <nav className="section-rail" aria-label="設定セクション">
          {SECTIONS.map((sec) => (
            <a
              key={sec.id}
              href={`#${sec.id}`}
              className={active === sec.id ? "active" : ""}
            >
              {sec.icon}
              {sec.label}
            </a>
          ))}
        </nav>

        <div className="stack">
          <section className="panel">
            <div className="summary">
              <div className="item">
                <span className="k">
                  <Icon.layers size={13} />
                  model
                </span>
                <span className="v">
                  {s.selection?.model ? (
                    <>
                      <span
                        className="prov-dot"
                        style={{
                          color: providerMeta(s.selection.provider).color,
                        }}
                        title={providerMeta(s.selection.provider).label}
                      >
                        <ProviderMark
                          provider={s.selection.provider}
                          size={15}
                        />
                      </span>
                      {s.selection.model}
                    </>
                  ) : (
                    "env 既定"
                  )}
                </span>
              </div>
              <div className="item">
                <span className="k">
                  <Icon.gauge size={13} />
                  effort
                </span>
                <span className="v">{s.selection?.effort ?? "推奨値"}</span>
              </div>
              <div className="item">
                <span className="k">
                  <Icon.search size={13} />
                  triggers
                </span>
                <span className="v">
                  {(c.triggers ?? FALLBACK_TRIGGERS)
                    .filter(
                      (w) =>
                        !(s.disabled_triggers ?? []).some((d) =>
                          triggerNamesEqual(d, w),
                        ),
                    )
                    .concat(s.extra_triggers ?? [])
                    .join(", ") || "（なし）"}
                </span>
              </div>
            </div>
          </section>

          <OverlayPanels
            catalog={c}
            settings={s}
            role={me?.role}
            resetLabel="デフォルトに戻す"
            onPatch={patch}
          />

          <Panel
            id="tuning"
            icon={<Icon.sliders />}
            title="Temperature / Exa / スレッド履歴"
            desc="数値は入力欄からフォーカスを外した時点で保存されます。"
          >
            <div className="fields">
              <Field
                label="temperature"
                icon={<Icon.thermometer />}
                hint="0〜2。"
              >
                {(fid) => (
                  <input
                    id={fid}
                    type="number"
                    min={0}
                    max={2}
                    step={0.05}
                    defaultValue={s.temperature ?? ""}
                    onBlur={(e) => {
                      // Empty input has no saved meaning; restore the visible
                      // value so the field always agrees with the active setting.
                      if (!e.target.value) e.target.value = e.target.defaultValue;
                      if (e.target.checkValidity()) patch({ temperature: Number(e.target.value) });
                    }}
                  />
                )}
              </Field>
              <Field label="exa" icon={<Icon.globe />}>
                {(fid) => (
                  <Select
                    id={fid}
                    value={s.exa_mode ?? "auto"}
                    onValueChange={(e) => patch({ exa_mode: e })}
                  >
                    {c.exa.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label="スレッド履歴の保持（秒）"
                icon={<Icon.clock />}
                hint={secsHint(s.thread_history_max_age_secs)}
              >
                {(fid) => (
                  <input
                    id={fid}
                    type="number"
                    min={0}
                    step={60}
                    defaultValue={s.thread_history_max_age_secs ?? ""}
                    onBlur={(e) => {
                      if (!e.target.value) e.target.value = e.target.defaultValue;
                      if (e.target.checkValidity()) patch({ thread_history_max_age_secs: Number(e.target.value) });
                    }}
                  />
                )}
              </Field>
            </div>
          </Panel>

          <Panel id="mcp" icon={<Icon.globe />} title="MCP">
            <div className="fields">
              <BooleanSetting
                label="外部 MCP"
                icon={<Icon.globe />}
                value={s.mcp_enabled}
                onChange={(v) => patch({ mcp_enabled: v })}
              />
              <Field label="MCP サーバー URL" icon={<Icon.globe />}>
                {(fid) => (
                  <input
                    id={fid}
                    type="url"
                    maxLength={2048}
                    placeholder="https://ww.hsincode.com/api/mcp"
                    defaultValue={
                      s.mcp_url ?? "https://ww.hsincode.com/api/mcp"
                    }
                    onBlur={(e) => {
                      if (e.target.validity.valid)
                        patch({ mcp_url: e.target.value.trim() || null });
                      else e.target.reportValidity();
                    }}
                  />
                )}
              </Field>
            </div>
          </Panel>

          <Panel
            id="behavior"
            icon={<Icon.tools />}
            title="サーバーツール / スレッド / 通話"
          >
            <div className="fields">
              <BooleanSetting
                label="server-tools"
                icon={<Icon.tools />}
                value={s.server_tools ?? true}
                onChange={(v) => patch({ server_tools: v })}
              />
              <BooleanSetting
                label="thread-only"
                icon={<Icon.thread />}
                value={s.thread_only ?? false}
                onChange={(v) => patch({ thread_only: v })}
              />
              <BooleanSetting
                label="URL previews"
                icon={<Icon.globe />}
                value={s.suppress_embeds == null ? null : !s.suppress_embeds}
                onChange={(v) =>
                  patch({ suppress_embeds: v === null ? null : !v })
                }
              />
              <Field
                label="voice-mode"
                icon={<Icon.mic />}
                hint="stt は文字起こし、s2s は音声のまま応答。"
              >
                {(fid) => (
                  <Select
                    id={fid}
                    value={s.voice_mode ?? "stt"}
                    onValueChange={(e) => patch({ voice_mode: e })}
                  >
                    <option value="stt">stt</option>
                    <option value="s2s">s2s</option>
                  </Select>
                )}
              </Field>
              <BooleanSetting
                label="filler removal"
                icon={<Icon.mic />}
                value={s.filler_removal ?? true}
                onChange={(v) => patch({ filler_removal: v })}
              />
            </div>
          </Panel>

          <TriggerEditor
            builtins={c.triggers ?? FALLBACK_TRIGGERS}
            extra={s.extra_triggers ?? null}
            disabled={s.disabled_triggers ?? []}
            onPatch={patch}
          />

          <GuildArtifactsPanel guildId={id!} />

          <ContextPanel
            value={s.context?.text ?? ""}
            personaOverride={s.context?.persona_override ?? false}
            onSaveText={(text) =>
              patch({ context_text: text || null }, "コンテキストを保存した")
            }
            onPersona={(v) => patch({ persona_override: v })}
            onClear={() =>
              patch({ context_clear: true }, "コンテキストを消した")
            }
          />
        </div>
      </div>

      <ToastArea toasts={toasts} />
    </div>
  );
}

/**
 * Keyword wake words for this guild.
 *
 * Builtins stay visible even when turned off so they can be restored; extras
 * are guild-owned. Renaming a builtin disables the old spelling and stores
 * the new one as extra — that is how a default word is edited and persisted
 * without rewriting the bot binary.
 */
function TriggerEditor({
  builtins,
  extra,
  disabled,
  onPatch,
}: {
  builtins: string[];
  extra: string[] | null;
  disabled: string[];
  onPatch: (body: Record<string, unknown>, ok?: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const extraOwned = extra !== null;
  const extras = extra ?? [];
  const err = validateTriggerDraft(draft, builtins, extras, disabled);

  function isDisabled(word: string): boolean {
    return disabled.some((d) => triggerNamesEqual(d, word));
  }

  function commitDisabled(next: string[], ok: string) {
    onPatch({ disabled_triggers: next }, ok);
  }

  function commitExtra(next: string[], ok: string) {
    onPatch({ extra_triggers: next }, ok);
  }

  function toggleBuiltin(word: string) {
    const canon = canonicalBuiltin(word, builtins) ?? word;
    if (isDisabled(canon)) {
      commitDisabled(
        disabled.filter((d) => !triggerNamesEqual(d, canon)),
        `「${canon}」を有効にした`,
      );
    } else {
      commitDisabled([...disabled, canon], `「${canon}」を無効にした`);
    }
  }

  function removeExtra(word: string) {
    commitExtra(
      extras.filter((e) => !triggerNamesEqual(e, word)),
      `「${word}」を外した`,
    );
  }

  function addWord() {
    const t = draft.trim();
    if (!t || err) return;
    const builtin = canonicalBuiltin(t, builtins);
    if (builtin) {
      commitDisabled(
        disabled.filter((d) => !triggerNamesEqual(d, builtin)),
        `「${builtin}」を有効にした`,
      );
    } else {
      commitExtra([...extras, t], `「${t}」を追加した`);
    }
    setDraft("");
  }

  function applyRename(from: string) {
    const t = editValue.trim();
    if (triggerNamesEqual(from, t)) {
      setEditing(null);
      return;
    }
    if (
      validateTriggerDraft(
        t,
        builtins,
        extras.filter((e) => !triggerNamesEqual(e, from)),
        disabled,
      )
    )
      return;
    setEditing(null);
    const fromBuiltin = canonicalBuiltin(from, builtins);
    const toBuiltin = canonicalBuiltin(t, builtins);
    let nextDisabled = [...disabled];
    let nextExtra = [...extras];
    let extraTouched = extraOwned;

    if (fromBuiltin) {
      if (!nextDisabled.some((d) => triggerNamesEqual(d, fromBuiltin)))
        nextDisabled.push(fromBuiltin);
    } else {
      nextExtra = nextExtra.filter((e) => !triggerNamesEqual(e, from));
      extraTouched = true;
    }

    if (toBuiltin) {
      nextDisabled = nextDisabled.filter(
        (d) => !triggerNamesEqual(d, toBuiltin),
      );
    } else if (!nextExtra.some((e) => triggerNamesEqual(e, t))) {
      if (nextExtra.length >= TRIGGER_EXTRA_MAX) return;
      nextExtra.push(t);
      extraTouched = true;
    }

    const body: Record<string, unknown> = { disabled_triggers: nextDisabled };
    if (extraTouched) body.extra_triggers = nextExtra;
    onPatch(body, `「${from}」を「${t}」に変えた`);
  }

  const dirty = extraOwned || disabled.length > 0;

  return (
    <Panel id="triggers" icon={<Icon.search />} title="トリガーワード">
      <div className="trig-block">
        <p className="trig-label">既定</p>
        <div className="trig-list" role="list">
          {builtins.map((word) => {
            const off = isDisabled(word);
            const isEdit = editing === word;
            return (
              <div
                key={word}
                className={`trig-chip ${off ? "off" : ""}`}
                role="listitem"
              >
                {isEdit ? (
                  <input
                    className="trig-edit"
                    value={editValue}
                    autoFocus
                    maxLength={TRIGGER_WORD_MAX}
                    aria-label={`${word} を編集`}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => applyRename(word)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span className="trig-word">{word}</span>
                )}
                <span className="kind">既定</span>
                <button
                  type="button"
                  className="trig-x"
                  aria-label={`${word} を改名`}
                  title="改名"
                  onClick={() => {
                    setEditing(word);
                    setEditValue(word);
                  }}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="trig-x"
                  aria-label={off ? `${word} を有効` : `${word} を無効`}
                  role="switch"
                  aria-checked={!off}
                  title={off ? "有効にする" : "無効にする"}
                  onClick={() => toggleBuiltin(word)}
                >
                  {off ? <Icon.check size={12} /> : <Icon.close size={12} />}
                </button>
              </div>
            );
          })}
        </div>

        <p className="trig-label">追加</p>
        <div className="trig-list" role="list">
          {extras.length === 0 && (
            <p className="trig-empty">
              {extraOwned
                ? "追加キーワードはありません。"
                : "サーバー固有の追加はありません。"}
            </p>
          )}
          {extras.map((word) => {
            const isEdit = editing === `extra:${word}`;
            return (
              <div key={word} className="trig-chip extra" role="listitem">
                {isEdit ? (
                  <input
                    className="trig-edit"
                    value={editValue}
                    autoFocus
                    maxLength={TRIGGER_WORD_MAX}
                    aria-label={`${word} を編集`}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={() => applyRename(word)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span className="trig-word">{word}</span>
                )}
                <span className="kind">追加</span>
                <button
                  type="button"
                  className="trig-x"
                  aria-label={`${word} を改名`}
                  title="改名"
                  onClick={() => {
                    setEditing(`extra:${word}`);
                    setEditValue(word);
                  }}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="trig-x"
                  aria-label={`${word} を外す`}
                  onClick={() => removeExtra(word)}
                >
                  <Icon.close size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <form
          className="trig-add"
          onSubmit={(e) => {
            e.preventDefault();
            addWord();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={TRIGGER_WORD_MAX}
            placeholder="キーワードを追加"
            aria-label="トリガーワードを追加"
          />
          <button
            type="submit"
            className="btn"
            disabled={!!err || !draft.trim()}
          >
            追加
          </button>
          {dirty && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() =>
                onPatch(
                  { extra_triggers: null, disabled_triggers: [] },
                  "トリガーを既定に戻した",
                )
              }
            >
              既定に戻す
            </button>
          )}
        </form>
        {draft.trim() && err && <p className="field-hint">{err}</p>}
        {editing !== null && (
          <p className="field-hint" role="status">
            {validateTriggerDraft(
              editValue,
              builtins,
              extras.filter((e) => `extra:${e}` !== editing),
              disabled,
            )}
          </p>
        )}
      </div>
    </Panel>
  );
}

function validateTriggerDraft(
  raw: string,
  builtins: string[],
  extras: string[],
  disabled: string[],
): string | null {
  const t = raw.trim();
  if (!t) return "空です";
  if ([...t].length > TRIGGER_WORD_MAX) return `${TRIGGER_WORD_MAX} 文字以内`;
  if (t.includes(",") || t.includes("\0") || t.includes("<@"))
    return "カンマ・制御文字・メンションは使えません";
  const builtin = canonicalBuiltin(t, builtins);
  if (builtin) {
    return disabled.some((d) => triggerNamesEqual(d, builtin))
      ? null
      : "既に既定の語として有効";
  }
  if (extras.some((e) => triggerNamesEqual(e, t))) return "すでに追加済み";
  if (extras.length >= TRIGGER_EXTRA_MAX)
    return `追加は ${TRIGGER_EXTRA_MAX} 個まで`;
  return null;
}

/**
 * プロバイダ別モデルピッカー。
 * preset は十数件あり provider がバラバラなので、select 1 個だと
 * 「今どのプロバイダを使っているか」が読み取れない。チップで絞り、
 * カードにプロバイダマークを出して視覚で選べるようにしている。
 */
/** catalog.roles は強い順。未指定 minRole = 誰でも。未知の role は free 扱い。 */
function roleAllows(
  userRole: string | undefined,
  minRole: string | undefined,
  roles: string[] | undefined,
): boolean {
  if (!minRole) return true;
  const order =
    roles && roles.length > 0
      ? roles
      : ["administrator", "moderator", "premium", "standard", "free"];
  const u = order.indexOf((userRole ?? "free").toLowerCase());
  const m = order.indexOf(minRole.toLowerCase());
  if (m < 0) return true;
  if (u < 0) return false;
  return u <= m;
}

function ModelPicker({
  presets,
  available,
  selection,
  selectedId,
  specials,
  role,
  roles,
  onPick,
}: {
  presets: Preset[];
  available?: string[];
  /** /switch 用: 保存値が provider + model なので、それで選択中を判定する。 */
  selection?: { provider?: string; model?: string } | null;
  selectedId?: string | null;
  /** モデル以外の選択肢。 */
  specials?: {
    key: string;
    label: string;
    icon: React.ReactNode;
    active: boolean;
    onSelect: () => void;
  }[];
  role?: string;
  roles?: string[];
  onPick: (presetId: string) => void;
}) {
  const [filter, setFilter] = useState<string>("all");

  // 出現順を保ったままプロバイダを集計する（カタログの並び = 推奨順）
  const providers = useMemo(() => {
    const acc: { key: string; count: number; label: string; color: string }[] =
      [];
    for (const p of presets) {
      const key = p.provider ?? providerMeta(undefined, p.label).label;
      const hit = acc.find((x) => x.key === key);
      if (hit) hit.count += 1;
      else {
        const meta = providerMeta(p.provider, p.label);
        acc.push({ key, count: 1, label: meta.label, color: meta.color });
      }
    }
    return acc;
  }, [presets]);

  const shown = useMemo(
    () =>
      filter === "all"
        ? presets
        : presets.filter(
            (p) =>
              (p.provider ?? providerMeta(undefined, p.label).label) === filter,
          ),
    [presets, filter],
  );

  const isSelected = (p: Preset) =>
    selectedId !== undefined
      ? p.id === selectedId
      : !!selection?.model &&
        selection.model === (p.model ?? p.label.split("/").pop()?.trim()) &&
        (!selection.provider ||
          !p.provider ||
          selection.provider === p.provider);

  return (
    <div className="picker">
      {specials && specials.length > 0 && (
        <div
          className="option-row"
          role="group"
          aria-label="モデル以外の選択肢"
        >
          {specials.map((o) => (
            <button
              key={o.key}
              type="button"
              className={`option ${o.active ? "active" : ""}`}
              aria-pressed={o.active}
              onClick={o.onSelect}
            >
              {o.icon}
              {o.label}
              {o.active && <Icon.check size={14} className="tick" />}
            </button>
          ))}
        </div>
      )}

      <div className="chips" role="group" aria-label="プロバイダで絞り込み">
        <button
          type="button"
          className={`chip ${filter === "all" ? "active" : ""}`}
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          <Icon.layers size={14} />
          すべて
          <span className="n">{presets.length}</span>
        </button>
        {providers.map((pv) => (
          <button
            key={pv.key}
            type="button"
            className={`chip ${filter === pv.key ? "active" : ""}`}
            aria-pressed={filter === pv.key}
            style={{ ["--p" as string]: pv.color }}
            onClick={() => setFilter(pv.key)}
          >
            <span className="pmark">
              <ProviderMark provider={pv.key} size={14} />
            </span>
            {pv.label}
            <span className="n">{pv.count}</span>
          </button>
        ))}
      </div>

      <div className="model-grid">
        {shown.map((p) => {
          const meta = providerMeta(p.provider, p.label);
          const sel = isSelected(p);
          const offline = Array.isArray(available) && !available.includes(p.id);
          const locked = !roleAllows(role, p.min_role, roles);
          const name =
            p.model ?? p.label.split("/").slice(1).join("/").trim() ?? p.id;
          const title = locked
            ? `${p.label}（${p.min_role} 以上）`
            : offline
              ? `${p.label}（ボット側で未接続と報告されています）`
              : p.label;
          return (
            <button
              key={p.id}
              type="button"
              className={`model-tile ${sel ? "is-selected" : ""} ${offline ? "is-offline" : ""} ${locked ? "is-locked" : ""}`}
              style={{ ["--p" as string]: meta.color }}
              aria-pressed={sel}
              disabled={locked}
              onClick={() => {
                if (!locked) onPick(p.id);
              }}
              title={title}
            >
              <span className="pmark">
                <ProviderMark provider={p.provider} label={p.label} size={19} />
              </span>
              <span className="body">
                <span className="name">{name}</span>
                <span className="prov">
                  {meta.label}
                  <span className="mono"> · {p.id}</span>
                </span>
              </span>
              {locked && <span className="tag">Premium</span>}
              {!locked && offline && <span className="tag">未接続</span>}
              {sel && <Icon.checkCircle size={17} className="tick" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * インラインでカードを出すと 1 画面に 3 つも並んで縦に伸びるので、
 * 現在値だけボタンで見せてダイアログの中で /switch と同じピッカーを使う。
 */
function PresetField({
  label,
  icon,
  hint,
  title,
  presets,
  available,
  value,
  specials,
  role,
  roles,
  onChange,
}: {
  label: string;
  icon: React.ReactNode;
  hint?: string;
  title: string;
  presets: Preset[];
  available?: string[];
  /** preset id または特殊値（"off" など）。 */
  value: string | null;
  specials: { key: string; label: string; icon: React.ReactNode }[];
  role?: string;
  roles?: string[];
  onChange: (next: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = presets.find((p) => p.id === value) ?? null;
  const special = specials.find((x) => x.key === value);
  const meta = current ? providerMeta(current.provider, current.label) : null;

  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div className="field">
      <div className="field-label">
        {icon}
        {label}
      </div>
      <button
        type="button"
        className="picker-button"
        aria-label={`${label}: ${current?.model ?? current?.id ?? special?.label ?? value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        style={meta ? { ["--p" as string]: meta.color } : undefined}
      >
        <span className="pmark">
          {current ? (
            <ProviderMark
              provider={current.provider}
              label={current.label}
              size={17}
            />
          ) : (
            special?.icon
          )}
        </span>
        <span className="body">
          <span className="name">
            {current
              ? (current.model ?? current.id)
              : (special?.label ?? String(value))}
          </span>
          <span className="prov">
            {current ? `${meta?.label} · ${current.id}` : "モデル未指定"}
          </span>
        </span>
        <Icon.chevronRight className="act" />
      </button>
      {hint && <p className="field-hint">{hint}</p>}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        icon={icon}
      >
        <ModelPicker
          presets={presets}
          available={available}
          selectedId={value}
          role={role}
          roles={roles}
          specials={specials.map((sp) => ({
            key: sp.key,
            label: sp.label,
            icon: sp.icon,
            active: value === sp.key,
            onSelect: () => pick(sp.key),
          }))}
          onPick={(id) => pick(id)}
        />
      </Modal>
    </div>
  );
}

function personalContextLabel(
  ctx: { text: string; persona_override: boolean } | null | undefined,
): string {
  if (!ctx || (!ctx.text.trim() && !ctx.persona_override)) return "デフォルト";
  if (!ctx.text.trim()) return "人格上書きのみ";
  return `${ctx.text.length.toLocaleString()} 文字`;
}

/** context はうっかり消えると痛いので、明示的な保存ボタンにする（他は即時保存）。 */
function ContextPanel({
  value,
  personaOverride,
  onSaveText,
  onPersona,
  onClear,
  title = "サーバーコンテキスト",
  desc = "このサーバーでの応答に常に添える前提テキスト。",
  placeholder = "例: このサーバーは…",
}: {
  value: string;
  personaOverride: boolean;
  onSaveText: (text: string) => void;
  onPersona: (v: boolean | null) => void;
  onClear: () => void;
  title?: string;
  desc?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const dirty = text !== value;

  return (
    <Panel
      id="context"
      icon={<Icon.doc />}
      title={title}
      desc={desc}
      foot={
        <>
          <span className="field-hint">
            {text.length.toLocaleString()} 文字
            {dirty ? " · 未保存の変更あり" : ""}
          </span>
          <div className="inline-actions" style={{ marginLeft: "auto" }}>
            <button type="button" className="btn btn-danger" onClick={onClear}>
              <Icon.trash />
              クリア
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!dirty}
              onClick={() => onSaveText(text)}
            >
              <Icon.save />
              保存
            </button>
          </div>
        </>
      }
    >
      <div className="fields">
        <div className="field field-wide">
          <label className="field-label" htmlFor="ctx-text">
            <Icon.doc />
            テキスト
          </label>
          <textarea
            id="ctx-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
          />
        </div>
        <BooleanSetting
          label="persona override"
          icon={<Icon.users />}
          hint="ON にすると既定ペルソナをこのテキストで置き換えます。"
          value={personaOverride}
          onChange={onPersona}
        />
      </div>
    </Panel>
  );
}

function BackLink() {
  return (
    <Link to="/" className="backlink">
      <Icon.arrowLeft size={14} />
      サーバー一覧
    </Link>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "idle")
    return (
      <span className="status-pill">
        <Icon.save size={14} />
        変更は自動保存されます
      </span>
    );
  if (state === "saving")
    return (
      <span className="status-pill saving">
        <span className="spinner" style={{ width: 14, height: 14 }} />
        保存中…
      </span>
    );
  if (state === "saved")
    return (
      <span className="status-pill saved">
        <Icon.checkCircle size={14} />
        保存済み
      </span>
    );
  return (
    <span className="status-pill failed">
      <Icon.alert size={14} />
      保存に失敗
    </span>
  );
}

function booleanLabel(v: boolean | null | undefined): string {
  return v === true ? "ON" : "OFF";
}

function secsHint(v: number | null | undefined): string {
  if (v == null) return "秒数を指定してください。";
  const h = Math.floor(v / 3600);
  const m = Math.round((v % 3600) / 60);
  return `= ${h > 0 ? `${h} 時間 ` : ""}${m} 分`;
}

/* ============================================================
   ユーザー管理
   ============================================================ */
type UserRow = { discord_id: string; username: string; role: string };

function UsersPage({ me }: { me: Me }) {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [assignable, setAssignable] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  useDocumentTitle("ユーザー");

  const load = () => {
    api<{ users: UserRow[]; assignable: string[] }>("/api/users")
      .then((r) => {
        setRows(r.users);
        setAssignable(r.assignable);
      })
      .catch((e) => setErr(String(e.message ?? e)));
  };
  useEffect(load, []);

  async function setRole(u: UserRow, role: string) {
    try {
      await api(`/api/users/${u.discord_id}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      push("ok", `${u.username} を ${role} にした`);
      load();
    } catch (e) {
      push("error", String((e as Error).message ?? e));
    }
  }

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <div>
          <h1>ユーザー</h1>
          <p className="lead">
            ログインしたユーザーは既定で Free。Administrator は WEB_ADMIN_IDS
            のみ。自分より下のユーザーに、自分より下のロールだけ付けられます。
          </p>
        </div>
      </div>

      {err && <Alert>{err}</Alert>}

      {!rows && !err && <Skeleton height={220} />}

      {rows && rows.length === 0 && <Empty title="ユーザーがまだいない" />}

      {rows && rows.length > 0 && (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ユーザー</th>
                  <th>ロール</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.discord_id}>
                    <td>
                      <div className="cell-user">
                        <Avatar src={null} name={u.username} />
                        <div>
                          <div className="name">
                            {u.username}
                            {u.discord_id === me.id && (
                              <>
                                {" "}
                                <Badge tone="accent">自分</Badge>
                              </>
                            )}
                          </div>
                          <div className="field-hint mono">{u.discord_id}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge>
                        <Icon.shield size={12} />
                        {u.role}
                      </Badge>
                    </td>
                    <td style={{ width: 184 }}>
                      {u.discord_id !== me.id && assignable.length > 0 && (
                        <Select
                          value=""
                          aria-label={`${u.username} のロールを変更`}
                          onValueChange={(e) => {
                            if (e) void setRole(u, e);
                          }}
                        >
                          <option value="">ロールを変更…</option>
                          {assignable.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ToastArea toasts={toasts} />
    </div>
  );
}

/* ============================================================
   モデル公開 / プレミアム
   ============================================================ */
function ModelsPage() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  useDocumentTitle("モデル");

  const load = () => {
    api<Catalog>("/api/catalog")
      .then(setCatalog)
      .catch((e) => setErr(String(e.message ?? e)));
  };
  useEffect(load, []);

  async function patchPreset(
    p: Preset,
    body: { published?: boolean; premium?: boolean },
    ok: string,
  ) {
    setBusy(p.id);
    try {
      await api(`/api/catalog/presets/${p.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      push("ok", ok);
      clearApiCache();
      load();
    } catch (e) {
      push("error", String((e as Error).message ?? e));
    } finally {
      setBusy(null);
    }
  }

  const rows = catalog?.presets ?? null;
  const unpublished = rows?.filter((p) => p.published === false).length ?? 0;
  const premium = rows?.filter((p) => p.min_role === "premium").length ?? 0;

  return (
    <div className="page">
      <ChatgptAccounts />
      <div className="page-head">
        <div>
          <h1>モデル</h1>
          <p className="lead">
            Administrator / Moderator が /switch
            とダッシュボードに出すモデルを切り替えます。非公開はリリース前にカタログへ載せておき、公開にした瞬間から使えます。プレミアムは
            Premium / Moderator / Administrator だけが選べます。
          </p>
        </div>
        {rows && (
          <div className="option-row">
            <a className="btn btn-secondary" href={apiUrl("/auth/chatgpt")}>ChatGPTアカウントを登録</a>
            <Badge tone="muted">
              非公開 {unpublished} / {rows.length}
            </Badge>
            <Badge tone="muted">
              プレミアム {premium} / {rows.length}
            </Badge>
          </div>
        )}
      </div>

      {err && <Alert>{err}</Alert>}
      {!rows && !err && <Skeleton height={280} />}

      {rows && (
        <section className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>モデル</th>
                  <th>preset</th>
                  <th>公開</th>
                  <th>プレミアム</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const meta = providerMeta(p.provider, p.label);
                  const on = p.published !== false;
                  const gated = p.min_role === "premium";
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="cell-user">
                          <span className="pmark" style={{ color: meta.color }}>
                            <ProviderMark
                              provider={p.provider}
                              label={p.label}
                              size={18}
                            />
                          </span>
                          <div>
                            <div className="name">{p.model ?? p.id}</div>
                            <div className="field-hint">{meta.label}</div>
                          </div>
                        </div>
                      </td>
                      <td className="mono">{p.id}</td>
                      <td style={{ width: 168 }}>
                        <div
                          className="option-row"
                          role="group"
                          aria-label={`${p.id} の公開`}
                        >
                          <button
                            type="button"
                            className={`option ${on ? "active" : ""}`}
                            aria-pressed={on}
                            disabled={busy === p.id || on}
                            onClick={() =>
                              void patchPreset(
                                p,
                                { published: true },
                                `${p.id} を公開にした`,
                              )
                            }
                          >
                            公開
                          </button>
                          <button
                            type="button"
                            className={`option ${!on ? "active" : ""}`}
                            aria-pressed={!on}
                            disabled={busy === p.id || !on}
                            onClick={() =>
                              void patchPreset(
                                p,
                                { published: false },
                                `${p.id} を非公開にした`,
                              )
                            }
                          >
                            非公開
                          </button>
                        </div>
                      </td>
                      <td style={{ width: 188 }}>
                        <div
                          className="option-row"
                          role="group"
                          aria-label={`${p.id} のプレミアム`}
                        >
                          <button
                            type="button"
                            className={`option ${!gated ? "active" : ""}`}
                            aria-pressed={!gated}
                            disabled={busy === p.id || !gated}
                            onClick={() =>
                              void patchPreset(
                                p,
                                { premium: false },
                                `${p.id} を通常にした`,
                              )
                            }
                          >
                            通常
                          </button>
                          <button
                            type="button"
                            className={`option ${gated ? "active" : ""}`}
                            aria-pressed={gated}
                            disabled={busy === p.id || gated}
                            onClick={() =>
                              void patchPreset(
                                p,
                                { premium: true },
                                `${p.id} をプレミアムにした`,
                              )
                            }
                          >
                            プレミアム
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ToastArea toasts={toasts} />
    </div>
  );
}
