import {
  createContext,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Link,
  NavLink,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router-dom";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import {
  api,
  apiCached,
  clearApiCache,
  invalidateApi,
  type GuildSummary,
  type Me,
} from "./api";
import { ThemeMenu } from "./controls";
import { GUILD_PAGES, guildPath } from "./nav";
import { Palette, type PaletteNavState } from "./Palette";
import { SaveStatus, SaveStatusContext, type SaveState } from "./save";
import { Avatar, Badge, GUILD_PAGE_ICON, Icon, cdnUrl } from "./ui";

/* ============================================================
   シェル: 上部バー + サイドバー + 本文
   サイドバーは「今のサーバー」の 5 ページ、全体、管理の順。
   1000px 以下では引き出しになる。
   ============================================================ */

const LAST_GUILD_KEY = "hibana-guild";

/**
 * サーバーの一覧を読み直す合図。サーバーを止めた・再開したあとに呼ぶと、
 * サイドバーの切替とコマンドパレットの「停止中」が追いつく。
 */
export const ReloadGuildsContext = createContext<() => void>(() => {});
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

function readLastGuild(): string | null {
  try {
    return localStorage.getItem(LAST_GUILD_KEY);
  } catch {
    return null;
  }
}

/** サイドバーに出す「今のサーバー」。サーバーの外のページでは、最後に見ていたサーバー。 */
export function useCurrentGuild(guilds: GuildSummary[]): {
  id: string | undefined;
  guild: GuildSummary | undefined;
  /** URL が指しているサーバー（サーバーのページにいるときだけ）。 */
  routeId: string | undefined;
} {
  const routeId = useMatch("/g/:id/*")?.params.id;
  const [last, setLast] = useState(readLastGuild);
  useEffect(() => {
    if (!routeId) return;
    setLast(routeId);
    try {
      localStorage.setItem(LAST_GUILD_KEY, routeId);
    } catch {
      /* Storage can be unavailable in private browsers. */
    }
  }, [routeId]);
  const id =
    routeId ?? (guilds.some((g) => g.id === last) ? (last ?? undefined) : guilds[0]?.id);
  return { id, guild: guilds.find((g) => g.id === id), routeId };
}

export function Shell({
  me,
  onLogout,
  children,
}: {
  me: Me;
  onLogout: () => void;
  children: ReactNode;
}) {
  const nav = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [guilds, setGuilds] = useState<GuildSummary[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [save, setSave] = useState<SaveState | null>(null);
  const navToggle = useRef<HTMLButtonElement>(null);
  const side = useRef<HTMLElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const indicator = useRef<HTMLDivElement>(null);
  const saveline = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLElement>(null);
  const current = useCurrentGuild(guilds);

  const loadGuilds = useCallback(() => {
    apiCached<{ guilds: GuildSummary[] }>("/api/guilds")
      .then((r) => setGuilds(r.guilds))
      .catch(() => undefined);
  }, []);
  useEffect(loadGuilds, [loadGuilds]);
  const reloadGuilds = useCallback(() => {
    invalidateApi("/api/guilds");
    loadGuilds();
  }, [loadGuilds]);

  /* ---------- 引き出し（狭い幅のナビ） ---------- */
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    // 開いたら、引き出しの最初の項目へフォーカスを移す（上部バーの残りを飛ばす）。
    navigation.current?.querySelector<HTMLElement>("button, a")?.focus();
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!side.current?.contains(target) && !navToggle.current?.contains(target))
        setNavOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      setNavOpen(false);
      navToggle.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [navOpen]);

  /* ---------- コマンドパレット ---------- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // パレットでページを選んだあとは、本文へフォーカスを送る（設定項目のときは、その行が受け取る）。
  useEffect(() => {
    if ((location.state as PaletteNavState | null)?.focusMain)
      main.current?.focus({ preventScroll: true });
  }, [location.key]);

  /* ---------- 現在地の線 ---------- */
  // 現在地のリンクの位置へ線を移す。ページを移ると、線は前の位置から滑って動く。
  const placeIndicator = () => {
    const box = navigation.current;
    const line = indicator.current;
    if (!box || !line) return;
    const link = box.querySelector<HTMLElement>('.nav-link[aria-current="page"]');
    if (!link || link.offsetParent === null) {
      line.classList.remove("is-on", "is-moving");
      return;
    }
    const y =
      link.getBoundingClientRect().top -
      box.getBoundingClientRect().top +
      (link.offsetHeight - line.offsetHeight) / 2;
    // 最初に置くときは滑らせない。
    line.classList.toggle("is-moving", line.classList.contains("is-on"));
    line.style.transform = `translateY(${y}px)`;
    line.classList.add("is-on");
  };
  useLayoutEffect(placeIndicator, [location.pathname, guilds, current.id, navOpen, me]);
  useEffect(() => {
    window.addEventListener("resize", placeIndicator);
    return () => window.removeEventListener("resize", placeIndicator);
  }, []);

  /* ---------- 保存ライン ---------- */
  // 保存できたとき（と失敗したとき）に、上部バーの下端を光が 1 回走る。
  useEffect(() => {
    const line = saveline.current;
    if (!line || (save !== "saved" && save !== "failed")) return;
    line.classList.remove("run", "run-fail");
    void line.offsetWidth;
    line.classList.add(save === "saved" ? "run" : "run-fail");
  }, [save]);

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

  const link = (to: string, icon: ReactNode, label: string, end = false) => (
    <NavLink key={to} to={to} end={end} className="nav-link">
      {icon}
      <span>{label}</span>
    </NavLink>
  );

  return (
    <SaveStatusContext.Provider value={setSave}>
      <a className="skip-link" href="#main-content">
        メインコンテンツへ
      </a>
      <header className="topbar">
        <button
          ref={navToggle}
          type="button"
          className="icon-btn nav-toggle"
          aria-label={navOpen ? "ナビゲーションを閉じる" : "ナビゲーションを開く"}
          aria-expanded={navOpen}
          aria-controls="main-navigation"
          onClick={() => setNavOpen(!navOpen)}
        >
          {navOpen ? <Icon.close size={20} /> : <Icon.menu size={20} />}
        </button>
        <Link to="/" className="brand" aria-label="Hibana サーバー一覧へ">
          <span className="brand-mark">
            <Icon.logo />
          </span>
          <span className="brand-name">Hibana</span>
        </Link>
        <button
          type="button"
          className="palette-btn"
          aria-label="検索・移動（コマンドパレット）"
          aria-haspopup="dialog"
          onClick={() => setPaletteOpen(true)}
        >
          <Icon.search />
          <span>検索・移動</span>
          <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>

        <div className="topbar-spacer" />

        <SaveStatus state={save} />
        <ThemeMenu />
        <Dropdown.Root>
          <Dropdown.Trigger className="account-btn" aria-label="アカウントメニュー">
            <Avatar
              small
              round
              src={cdnUrl("avatars", me.id, me.avatar)}
              name={me.username}
            />
            <span className="account-name">{me.username}</span>
            <Icon.chevronDown size={14} />
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content
              className="pop"
              align="end"
              sideOffset={6}
              collisionPadding={8}
            >
              <Dropdown.Label className="pop-label">
                <strong>{me.username}</strong>
                <Badge>{me.role}</Badge>
              </Dropdown.Label>
              <Dropdown.Separator className="pop-sep" />
              <Dropdown.Item className="pop-item" asChild>
                <Link to="/me">
                  <Icon.user />
                  <span className="grow">マイ設定</span>
                </Link>
              </Dropdown.Item>
              <Dropdown.Item
                className="pop-item is-danger"
                disabled={busy}
                onSelect={() => void logout()}
              >
                <Icon.logout />
                <span className="grow">ログアウト</span>
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <div ref={saveline} className="saveline" aria-hidden="true" />
      </header>

      <div className="shell">
        <div
          className={`side-backdrop${navOpen ? " is-open" : ""}`}
          aria-hidden="true"
        />
        <aside ref={side} className={`side${navOpen ? " is-open" : ""}`}>
          <nav
            ref={navigation}
            id="main-navigation"
            className="side-nav"
            aria-label="メイン"
          >
            <div ref={indicator} className="nav-indicator" aria-hidden="true" />
            {current.id && (
              <>
                <GuildSwitcher
                  guilds={guilds}
                  currentId={current.id}
                  name={current.guild?.name ?? current.id}
                  icon={current.guild?.icon ?? null}
                />
                <div className="nav-group">
                  {GUILD_PAGES.map((p) =>
                    link(guildPath(current.id!, p.path), GUILD_PAGE_ICON[p.path], p.label, true),
                  )}
                </div>
                <div className="nav-label">全体</div>
              </>
            )}
            <div className="nav-group">
              {link("/", <Icon.grid />, "サーバー一覧", true)}
              {link("/me", <Icon.user />, "マイ設定")}
              {link("/artifacts", <Icon.box />, "すべての成果物")}
            </div>
            {(me.can_manage_users || me.can_view_analytics || me.can_moderate) && (
              <>
                <div className="nav-label">管理</div>
                <div className="nav-group">
                  {me.can_manage_users && link("/users", <Icon.users />, "ユーザー")}
                  {me.can_manage_users && link("/models", <Icon.cpu />, "モデル")}
                  {me.can_view_analytics && link("/analytics", <Icon.gauge />, "利用料")}
                  {me.can_moderate && link("/logs", <Icon.log />, "会話ログ")}
                </div>
              </>
            )}
          </nav>
        </aside>

        <main ref={main} id="main-content" className="main" tabIndex={-1}>
          <ReloadGuildsContext.Provider value={reloadGuilds}>
            {children}
          </ReloadGuildsContext.Provider>
        </main>
      </div>

      <Palette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        guilds={guilds}
        currentId={current.id}
        me={me}
      />
    </SaveStatusContext.Provider>
  );
}

/**
 * サーバーの切替。名前か ID で絞り込み、同じページのまま別のサーバーへ移る。
 * 入力欄のある一覧なので、メニューではなく絞り込みつきの選択肢として組んである
 * （入力欄にフォーカスを置いたまま、↑ ↓ で候補を選ぶ）。
 */
function GuildSwitcher({
  guilds,
  currentId,
  name,
  icon,
}: {
  guilds: GuildSummary[];
  currentId: string;
  name: string;
  icon: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const nav = useNavigate();
  const sub = useMatch("/g/:id/*")?.params["*"] ?? "";
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const needle = query.trim().toLowerCase();
  // ID でも探せるようにする（同名サーバーの区別に要る）
  const shown = needle
    ? guilds.filter((g) => g.name.toLowerCase().includes(needle) || g.id.includes(needle))
    : guilds;
  const active = Math.min(index, Math.max(shown.length - 1, 0));

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(Math.max(guilds.findIndex((g) => g.id === currentId), 0));
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function pick(g: GuildSummary | undefined) {
    if (!g) return;
    close(true);
    // 同じ種類のページのまま、別のサーバーへ移る。
    const page = GUILD_PAGES.some((p) => p.path === sub) ? sub : "";
    nav(guildPath(g.id, page));
  }

  return (
    <div className="switcher" ref={root}>
      <button
        ref={button}
        type="button"
        className="guild-switch"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`サーバーを切り替える（今は ${name}）`}
        onClick={() => setOpen(!open)}
      >
        <Avatar key={currentId} small src={cdnUrl("icons", currentId, icon)} name={name} />
        <span className="name">{name}</span>
        <Icon.updown />
      </button>
      {open && (
        <div
          className="pop"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // 引き出しまで一緒に閉じないよう、ここで止める。
              e.preventDefault();
              e.stopPropagation();
              close(true);
            }
          }}
        >
          <label className="search">
            <span className="sr">サーバーを探す</span>
            <Icon.search />
            <input
              className="input"
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown.length ? `${listId}-${active}` : undefined}
              placeholder="名前 / ID で絞り込み"
              autoComplete="off"
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (shown.length)
                    setIndex((active + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length);
                } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  pick(shown[active]);
                } else if (e.key === "Tab") {
                  setOpen(false);
                }
              }}
            />
          </label>
          <div className="switch-list" id={listId} ref={list} role="listbox" aria-label="サーバー">
            {shown.map((g, i) => (
              <button
                key={g.id}
                type="button"
                className={`pop-item${i === active ? " is-active" : ""}${g.id === currentId ? " is-current" : ""}`}
                role="option"
                id={`${listId}-${i}`}
                aria-selected={i === active}
                tabIndex={-1}
                onClick={() => pick(g)}
              >
                <Avatar small src={cdnUrl("icons", g.id, g.icon)} name={g.name} />
                <span className="grow">{g.name}</span>
                {(g.bot_disabled || g.id === currentId) && (
                  <span className="end">
                    {g.bot_disabled && <Badge tone="danger">停止中</Badge>}
                    {g.id === currentId && (
                      <>
                        <Icon.check size={14} />
                        <span className="sr">今のサーバー</span>
                      </>
                    )}
                  </span>
                )}
              </button>
            ))}
            {shown.length === 0 && <div className="pop-label">一致するサーバーがない</div>}
          </div>
        </div>
      )}
    </div>
  );
}
