import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Check,
  CircleAlert,
  Cpu,
  Ban,
  Download,
  Ellipsis,
  ExternalLink,
  FileText,
  Gauge,
  Info,
  LayoutGrid,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Network,
  Package,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Search,
  Server,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";

/* ============================================================
   共通 UI プリミティブ
   画面側にマークアップ詳細を散らさないよう、
   面・印・トースト等はここに集約する。
   ============================================================ */

/* ---------- icons ---------- */
type IconProps = { size?: number; className?: string };

/** 線の太さと `ic` クラス（縮まない・色は親に従う）をそろえる。 */
const icon =
  (Glyph: LucideIcon, base = 16) =>
  ({ size = base, className }: IconProps) => (
    <Glyph
      size={size}
      className={className ? `ic ${className}` : "ic"}
      strokeWidth={1.6}
      aria-hidden="true"
    />
  );

/** favicon と同じ四芒星。ロゴとログインの図版で使う。 */
export const LOGO_PATH =
  "M16 6.5l2.9 7.5 7.5 2.9-7.5 2.9L16 27.3l-2.9-7.5L5.6 16.9l7.5-2.9L16 6.5z";

export const Icon = {
  logo: ({ size = 18, className }: IconProps) => (
    <svg
      className={className ? `ic ${className}` : "ic"}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <path d={LOGO_PATH} fill="currentColor" />
    </svg>
  ),
  server: icon(Server),
  agent: icon(Network),
  sliders: icon(SlidersHorizontal),
  doc: icon(FileText),
  skill: icon(Sparkles),
  box: icon(Package),
  grid: icon(LayoutGrid),
  user: icon(UserRound),
  users: icon(Users),
  cpu: icon(Cpu),
  gauge: icon(Gauge),
  search: icon(Search),
  chevronDown: icon(ChevronDown),
  chevronRight: icon(ChevronRight),
  chevronLeft: icon(ChevronLeft),
  updown: icon(ChevronsUpDown),
  close: icon(X),
  menu: icon(Menu),
  check: icon(Check),
  sun: icon(Sun),
  moon: icon(Moon),
  monitor: icon(Monitor),
  refresh: icon(RefreshCw),
  download: icon(Download),
  trash: icon(Trash2),
  pencil: icon(Pencil),
  plus: icon(Plus),
  alert: icon(CircleAlert),
  info: icon(Info),
  external: icon(ExternalLink),
  logout: icon(LogOut),
  reset: icon(RotateCcw),
  more: icon(Ellipsis),
  power: icon(Power),
  ban: icon(Ban),
  log: icon(ScrollText),
  discord: ({ size = 18, className }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className ? `ic ${className}` : "ic"}
      aria-hidden="true"
    >
      <path d="M19.3 5.4A16.7 16.7 0 0 0 15.2 4l-.3.6c1.4.3 2.6.9 3.7 1.6a13.4 13.4 0 0 0-12.6-.4c.8-.5 1.9-1 3-1.2L8.8 4a16.7 16.7 0 0 0-4.1 1.4C2.1 9.3 1.4 13 1.7 16.7a16.8 16.8 0 0 0 5.1 2.6l1-1.7c-.9-.3-1.7-.8-2.4-1.3l.6-.4a12 12 0 0 0 10 0l.6.4c-.7.5-1.5 1-2.4 1.3l1 1.7a16.8 16.8 0 0 0 5.1-2.6c.4-4.3-.6-7.9-1-11.3zM8.7 14.6c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z" />
    </svg>
  ),
};

/** サーバー設定の 5 ページの印（nav.ts の `path` で引く）。 */
export const GUILD_PAGE_ICON: Record<string, ReactNode> = {
  "": <Icon.agent />,
  tools: <Icon.sliders />,
  context: <Icon.doc />,
  skills: <Icon.skill />,
  artifacts: <Icon.box />,
};

/* ---------- provider marks ---------- */
/**
 * モデルはプロバイダ数が多く、文字列 label だけだと一覧で探しづらい。
 * ブランドを想起できる簡易マークを持たせて、視覚で絞り込めるようにする。
 * 色は付けない（印は文字と同じ色。色数を増やさないため。#61）。
 */
export type ProviderMeta = {
  label: string;
  mark: (p: IconProps) => ReactNode;
};

const mark = (
  size: number,
  className: string | undefined,
  children: ReactNode,
) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);

const asterisk = "M12 3.5v17M4.5 7.8l15 8.4M4.5 16.2l15-8.4";
const grokMark = (
  <>
    <path d="M5 19L15.5 5h3.5L8.5 19H5z" fill="currentColor" />
    <path
      d="M13.2 19l3.2-4.4H19L15.8 19h-2.6z"
      fill="currentColor"
      opacity="0.55"
    />
  </>
);
const codexMark = (
  <>
    <path
      d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4l8-4.6z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path
      d="M12 7.2v9.6M7.8 9.6l8.4 4.8M16.2 9.6l-8.4 4.8"
      stroke="currentColor"
      strokeWidth="1.3"
      opacity="0.75"
    />
  </>
);

export const PROVIDERS: Record<string, ProviderMeta> = {
  opencode_go: {
    label: "OpenCode Go",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <>
          <rect
            x="2.5"
            y="4"
            width="19"
            height="16"
            rx="4"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>,
      ),
  },
  deepseek: {
    label: "DeepSeek",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <path
          d="M3 13.5c2.6.4 4.4-.4 5.8-1.9 1.3-1.4 1.2-3.2.4-4.6 1.9.3 3.2 1.6 3.7 3.3 1.6-.2 3-.9 4.3-2 .2 1.6-.3 2.9-1.2 3.9 1.2.2 2.3 0 3.5-.6-.9 3.6-4.2 6.2-8.2 6.2-3.9 0-7.2-1.7-8.3-4.3z"
          fill="currentColor"
        />,
      ),
  },
  grok_free: {
    label: "Grok Free",
    mark: ({ size = 18, className }) => mark(size, className, grokMark),
  },
  // Grok Heavy: Free と同じ形。どちらの口座かは名前で区別する。
  grok_heavy: {
    label: "Grok Heavy",
    mark: ({ size = 18, className }) => mark(size, className, grokMark),
  },
  claude_kiro: {
    label: "Claude Kiro",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d={asterisk} />
        </g>,
      ),
  },
  // Anthropic 直結（従量課金）: 芯のないアスタリスクを輪で囲み、Kiro / Max と区別する。
  anthropic: {
    label: "Anthropic",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <g
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          fill="none"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 6.5v11M7.2 9.25l9.6 5.5M7.2 14.75l9.6-5.5" />
        </g>,
      ),
  },
  // Claude Max: Kiro と同じアスタリスクに芯を足して、課金先が一目で分かるようにしてある。
  claude_max: {
    label: "Claude Max",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d={asterisk} />
          <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
        </g>,
      ),
  },
  codex_gemini: {
    label: "Gemini",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <path
          d="M12 2.5c.7 5 3.8 8.1 8.8 8.8-5 .7-8.1 3.8-8.8 8.8-.7-5-3.8-8.1-8.8-8.8 5-.7 8.1-3.8 8.8-8.8z"
          fill="currentColor"
        />,
      ),
  },
  codex_plus: {
    label: "Codex Plus",
    mark: ({ size = 18, className }) => mark(size, className, codexMark),
  },
  // Codex Pro: Codex Plus と同じホスト・同じ 2 モデルの別口座。どちらに課金され
  // ているかが一目で分かるよう、同じ六角形マークに芯を足してある。
  codex_pro: {
    label: "Codex Pro",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <>
          {codexMark}
          <circle cx="12" cy="12" r="2.1" fill="currentColor" />
        </>,
      ),
  },
  openrouter: {
    label: "OpenRouter",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="5" cy="12" r="2.2" />
          <circle cx="19" cy="6.5" r="2.2" />
          <circle cx="19" cy="17.5" r="2.2" />
          <path d="M7.2 11.2l9.6-4M7.2 12.8l9.6 4" />
        </g>,
      ),
  },
};

const FALLBACK_PROVIDER: ProviderMeta = {
  label: "その他",
  mark: ({ size = 18, className }) =>
    mark(
      size,
      className,
      <path
        d="M12 3.5l8 4.4v8.2l-8 4.4-8-4.4V7.9l8-4.4z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />,
    ),
};

export function providerMeta(
  provider: string | undefined,
  label?: string,
): ProviderMeta {
  if (provider === "chatgpt") return { ...PROVIDERS.codex_pro!, label: "ChatGPT" };
  if (provider && PROVIDERS[provider]) return PROVIDERS[provider];
  // provider を返さない旧 API 用: label の "Provider / Model" 前半で引く
  const head = label?.split("/")[0]?.trim().toLowerCase();
  if (head) {
    const hit = Object.values(PROVIDERS).find(
      (p) => p.label.toLowerCase() === head,
    );
    if (hit) return hit;
  }
  return FALLBACK_PROVIDER;
}

/** プロバイダの印を入れた小さな枠。名前は隣に文字で出すので、印は飾りとして扱う。 */
export function ProviderTile({
  provider,
  label,
  large,
}: {
  provider?: string;
  label?: string;
  large?: boolean;
}) {
  return (
    <span className={`mono-tile${large ? " lg" : ""}`} aria-hidden="true">
      {providerMeta(provider, label).mark({ size: large ? 20 : 15 })}
    </span>
  );
}

/* ---------- avatar ---------- */
/** Discord の avatar/icon は hash だけ返る場合と完全な URL の場合がある。 */
export function cdnUrl(
  kind: "avatars" | "icons",
  id: string,
  hash: string | null,
): string | null {
  if (!hash) return null;
  if (hash.startsWith("http")) return hash;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/${kind}/${id}/${hash}.${ext}?size=128`;
}

export function Avatar({
  src,
  name,
  small,
  round,
}: {
  src: string | null;
  name: string;
  small?: boolean;
  /** 人は丸、サーバーは角丸。 */
  round?: boolean;
}) {
  const cls = `avatar${small ? " sm" : ""}${round ? " round" : ""}`;
  const [broken, setBroken] = useState(false);
  if (src && !broken) {
    return (
      <img
        className={cls}
        src={src}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
      />
    );
  }
  // 画像なしはイニシャル 1 文字。
  return (
    <span className={cls} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/* ---------- layout blocks ---------- */
/** ページの中の 1 節。見出しと説明の下に、設定行の面や表を置く。 */
export function Section({
  id,
  title,
  desc,
  children,
}: {
  id?: string;
  title: string;
  desc?: ReactNode;
  children: ReactNode;
}) {
  const auto = useId();
  const headingId = `${id ?? auto}-t`;
  return (
    <section className="sec" id={id} aria-labelledby={headingId}>
      <header className="sec-head">
        <h2 className="sec-title" id={headingId}>
          {title}
        </h2>
        {desc && <p className="sec-desc">{desc}</p>}
      </header>
      {children}
    </section>
  );
}

/** 読み取り板（サーバー設定の「実際の動作」、マイ設定の「あなたの上書き」）の 1 項目。 */
export type EffectiveItem = {
  label: string;
  value: string;
  note?: string;
  /** 保存した値とは違う値で動いている。 */
  unused?: boolean;
  warn?: boolean;
};

export function Effective({
  title,
  caption,
  items,
}: {
  title: string;
  caption: string;
  items: EffectiveItem[];
}) {
  const headingId = useId();
  return (
    <section className="effective" aria-labelledby={headingId}>
      <div className="effective-head">
        <h2 id={headingId}>{title}</h2>
        <p>{caption}</p>
      </div>
      <dl className={`eff-list${items.length === 3 ? " is-three" : ""}`}>
        {items.map((item) => (
          <div
            key={item.label}
            className={`eff-item${item.unused ? " is-unused" : ""}${item.warn ? " is-warn" : ""}`}
          >
            <dt>{item.label}</dt>
            <dd>
              <div
                className={`eff-value${/[^\x00-\x7f]/.test(item.value) ? " is-text" : ""}`}
              >
                {item.value}
              </div>
              {item.note && <div className="eff-note">{item.note}</div>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** セグメント: 2〜4 個の選択肢を並べ、選んだ値を常に見せる。 */
export function Seg<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  mono,
  wideOnMobile,
  disabled,
}: {
  label?: string;
  labelledBy?: string;
  value: T;
  options: { value: T; label: string; count?: number; disabled?: boolean }[];
  onChange: (next: T) => void;
  mono?: boolean;
  wideOnMobile?: boolean;
  disabled?: boolean;
}) {
  return (
    <div
      className={`seg${mono ? " is-mono" : ""}${wideOnMobile ? " is-wide-mobile" : ""}`}
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={disabled || o.disabled}
          onClick={() => {
            if (value !== o.value) onChange(o.value);
          }}
        >
          {o.label}
          {o.count != null && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** ON / OFF。`onDefault` を渡すと「デフォルト」が加わり、個人の上書きをサーバー設定に戻せる。 */
export function BoolSeg({
  label,
  labelledBy,
  value,
  onChange,
  onDefault,
}: {
  label?: string;
  labelledBy?: string;
  value: boolean | null | undefined;
  onChange: (v: boolean) => void;
  onDefault?: () => void;
}) {
  const current =
    value === true ? "on" : value === false ? "off" : onDefault ? "inherit" : "off";
  return (
    <Seg
      label={label}
      labelledBy={labelledBy}
      wideOnMobile
      value={current}
      options={[
        ...(onDefault ? [{ value: "inherit" as const, label: "デフォルト" }] : []),
        { value: "on" as const, label: "ON" },
        { value: "off" as const, label: "OFF" },
      ]}
      onChange={(next) => {
        if (next === "inherit") onDefault?.();
        else onChange(next === "on");
      }}
    />
  );
}

export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: "" | "ok" | "warn" | "danger" | "solid";
}) {
  return <span className={`badge${tone ? ` is-${tone}` : ""}`}>{children}</span>;
}

export function Empty({
  title,
  body,
  action,
  heading,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  /** ページに他の見出しが無いとき、題を h1 にする。 */
  heading?: boolean;
}) {
  return (
    <div className="empty">
      {heading ? (
        <h1 className="empty-title">
          <strong>{title}</strong>
        </h1>
      ) : (
        <strong>{title}</strong>
      )}
      {body && <span>{body}</span>}
      {action}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert" role="alert">
      <Icon.alert />
      <span>{children}</span>
    </div>
  );
}

/** 誤りではない知らせ（このサーバーは止めてある、など）。`action` は右に置く操作。 */
export function Notice({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="alert is-info" role="note">
      <Icon.info />
      <span>{children}</span>
      {action}
    </div>
  );
}

export function Skeleton({
  height,
  width,
}: {
  height: number | string;
  width?: number | string;
}) {
  return (
    <span className="skeleton" style={{ height, width: width ?? "100%" }} />
  );
}

export function Loading({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}

/* ---------- modal ---------- */
export function Modal({
  open,
  onClose,
  title,
  desc,
  size,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  desc?: string;
  size?: "wide" | "narrow";
  children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const descriptionId = useId();

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        {/* Content を Overlay の中に置く: 背の高いダイアログは Overlay ごとスクロールできる。 */}
        <Dialog.Overlay className="overlay">
          <Dialog.Content
            className={`modal${size ? ` is-${size}` : ""}`}
            aria-describedby={desc ? descriptionId : undefined}
            onOpenAutoFocus={() => {
              returnFocus.current = document.activeElement as HTMLElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus.current?.focus();
            }}
          >
            <header className="modal-head">
              <Dialog.Title>{title}</Dialog.Title>
              <button
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="閉じる"
                title="閉じる"
              >
                <Icon.close size={18} />
              </button>
            </header>
            {desc && (
              <Dialog.Description id={descriptionId} className="modal-desc">
                {desc}
              </Dialog.Description>
            )}
            <div className="modal-body">{children}</div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/* ---------- toasts ---------- */
export type Toast = { id: number; kind: "ok" | "error"; text: string };

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t, { id, kind, text }]);
    // エラーは読む時間が要るので長めに残す
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === "error" ? 6000 : 2400,
    );
  }, []);
  return { toasts, push };
}

export function ToastArea({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toast-area" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.kind === "error" ? " is-danger" : ""}`}>
          {t.kind === "ok" ? <Icon.check /> : <Icon.alert />}
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- document title ---------- */
/** SPA なので履歴・ブックマーク・共有時のためにルートごとに title を差し替える。 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title} · Hibana`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

/* ---------- hash scroll ---------- */
/** `/g/1/tools#mcp` のような節への直リンク。中身が描かれてから、その節へ送る。 */
export function useHashScroll(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [ready]);
}
