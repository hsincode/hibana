import {
  Sparkles,
  Server,
  Users,
  UserRound,
  LogOut,
  Search,
  ChevronRight,
  ArrowLeft,
  Inbox,
  Route,
  ShieldCheck,
  Filter,
  Compass,
  Cpu,
  Thermometer,
  Globe,
  Clock,
  Mic,
  MessagesSquare,
  Wrench,
  FlaskConical,
  FileText,
  SlidersHorizontal,
  RotateCcw,
  Trash2,
  Save,
  Check,
  CircleCheck,
  CircleAlert,
  Minus,
  X,
  Layers,
  Gauge,
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
   画面（App.tsx）側にマークアップ詳細を散らさないよう、
   カード・フィールド・トースト等はここに集約する。
   ============================================================ */

/* ---------- icons ---------- */
type IconProps = { size?: number; className?: string };

export const Icon = {
  logo: ({ size = 18, className }: IconProps) => (
    <Sparkles
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  server: ({ size = 16, className }: IconProps) => (
    <Server
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  users: ({ size = 16, className }: IconProps) => (
    <Users
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  user: ({ size = 16, className }: IconProps) => (
    <UserRound
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  logout: ({ size = 16, className }: IconProps) => (
    <LogOut
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  search: ({ size = 16, className }: IconProps) => (
    <Search
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  chevronRight: ({ size = 16, className }: IconProps) => (
    <ChevronRight
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  arrowLeft: ({ size = 16, className }: IconProps) => (
    <ArrowLeft
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  inbox: ({ size = 32, className }: IconProps) => (
    <Inbox
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  route: ({ size = 16, className }: IconProps) => (
    <Route
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  shield: ({ size = 16, className }: IconProps) => (
    <ShieldCheck
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  filter: ({ size = 16, className }: IconProps) => (
    <Filter
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  compass: ({ size = 16, className }: IconProps) => (
    <Compass
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  cpu: ({ size = 16, className }: IconProps) => (
    <Cpu
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  thermometer: ({ size = 16, className }: IconProps) => (
    <Thermometer
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  globe: ({ size = 16, className }: IconProps) => (
    <Globe
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  clock: ({ size = 16, className }: IconProps) => (
    <Clock
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  mic: ({ size = 16, className }: IconProps) => (
    <Mic
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  thread: ({ size = 16, className }: IconProps) => (
    <MessagesSquare
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  tools: ({ size = 16, className }: IconProps) => (
    <Wrench
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  flask: ({ size = 16, className }: IconProps) => (
    <FlaskConical
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  doc: ({ size = 16, className }: IconProps) => (
    <FileText
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  sliders: ({ size = 16, className }: IconProps) => (
    <SlidersHorizontal
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  reset: ({ size = 16, className }: IconProps) => (
    <RotateCcw
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  trash: ({ size = 16, className }: IconProps) => (
    <Trash2
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  save: ({ size = 16, className }: IconProps) => (
    <Save
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  check: ({ size = 16, className }: IconProps) => (
    <Check
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  checkCircle: ({ size = 16, className }: IconProps) => (
    <CircleCheck
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  alert: ({ size = 16, className }: IconProps) => (
    <CircleAlert
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  minus: ({ size = 16, className }: IconProps) => (
    <Minus
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  close: ({ size = 16, className }: IconProps) => (
    <X size={size} className={className} strokeWidth={1.7} aria-hidden="true" />
  ),
  layers: ({ size = 16, className }: IconProps) => (
    <Layers
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  gauge: ({ size = 16, className }: IconProps) => (
    <Gauge
      size={size}
      className={className}
      strokeWidth={1.7}
      aria-hidden="true"
    />
  ),
  discord: ({ size = 18, className }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M19.3 5.4A16.7 16.7 0 0 0 15.2 4l-.3.6c1.4.3 2.6.9 3.7 1.6a13.4 13.4 0 0 0-12.6-.4c.8-.5 1.9-1 3-1.2L8.8 4a16.7 16.7 0 0 0-4.1 1.4C2.1 9.3 1.4 13 1.7 16.7a16.8 16.8 0 0 0 5.1 2.6l1-1.7c-.9-.3-1.7-.8-2.4-1.3l.6-.4a12 12 0 0 0 10 0l.6.4c-.7.5-1.5 1-2.4 1.3l1 1.7a16.8 16.8 0 0 0 5.1-2.6c.4-4.3-.6-7.9-1-11.3zM8.7 14.6c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2zm6.6 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2z" />
    </svg>
  ),
};

/* ---------- provider marks ---------- */
/**
 * モデルはプロバイダ数が多く、文字列 label だけだと一覧で探しづらい。
 * ブランドを想起できる簡易マーク + 固定色を持たせて、視覚で絞り込めるようにする。
 */
export type ProviderMeta = {
  label: string;
  color: string;
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

export const PROVIDERS: Record<string, ProviderMeta> = {
  opencode_go: {
    label: "OpenCode Go",
    color: "#25c46a",
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
    color: "#4d6bfe",
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
    color: "#8b93a7",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <>
          <path d="M5 19L15.5 5h3.5L8.5 19H5z" fill="currentColor" />
          <path
            d="M13.2 19l3.2-4.4H19L15.8 19h-2.6z"
            fill="currentColor"
            opacity="0.55"
          />
        </>,
      ),
  },
  grok_heavy: {
    label: "Grok Heavy",
    color: "#f0a132",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <>
          <path d="M5 19L15.5 5h3.5L8.5 19H5z" fill="currentColor" />
          <path
            d="M13.2 19l3.2-4.4H19L15.8 19h-2.6z"
            fill="currentColor"
            opacity="0.55"
          />
        </>,
      ),
  },
  claude_kiro: {
    label: "Claude Kiro",
    color: "#d97757",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M12 3.5v17M4.5 7.8l15 8.4M4.5 16.2l15-8.4" />
        </g>,
      ),
  },
  // Claude Max: Kiro と同じアスタリスクに芯を足して、課金先が一目で分かるようにしてある。
  claude_max: {
    label: "Claude Max",
    color: "#c9a227",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
        <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M12 3.5v17M4.5 7.8l15 8.4M4.5 16.2l15-8.4" />
          <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
        </g>,
      ),
  },
  codex_gemini: {
    label: "Gemini",
    color: "#4b8dff",
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
    color: "#12a37e",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
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
        </>,
      ),
  },
  // Codex Pro: Codex Plus と同じホスト・同じ 2 モデルの別口座。どちらに課金され
  // ているかが一目で分かるよう、同じ六角形マークに芯を足して色を変えてある。
  codex_pro: {
    label: "Codex Pro",
    color: "#e0a63c",
    mark: ({ size = 18, className }) =>
      mark(
        size,
        className,
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
          <circle cx="12" cy="12" r="2.1" fill="currentColor" />
        </>,
      ),
  },
  openrouter: {
    label: "OpenRouter",
    color: "#a878ff",
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
  color: "#8b93a7",
  mark: ({ size = 18, className }) =>
    mark(
      size,
      className,
      <>
        <path
          d="M12 3.5l8 4.4v8.2l-8 4.4-8-4.4V7.9l8-4.4z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </>,
    ),
};

export function providerMeta(
  provider: string | undefined,
  label?: string,
): ProviderMeta {
  if (provider === "chatgpt") return { ...PROVIDERS.codex_pro!, label: "ChatGPT", color: "#10a37f" };
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

export function ProviderMark({
  provider,
  label,
  size = 18,
}: {
  provider?: string;
  label?: string;
  size?: number;
}) {
  const meta = providerMeta(provider, label);
  return <>{meta.mark({ size })}</>;
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
  square,
  className = "",
}: {
  src: string | null;
  name: string;
  square?: boolean;
  className?: string;
}) {
  const cls = `avatar ${square ? "avatar-sq" : ""} ${className}`.trim();
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
  // 画像なしはイニシャル。頭文字だけだと同名で潰れるので 1 文字 + 色は付けず地味に。
  return (
    <span className={cls} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/* ---------- layout blocks ---------- */
export function Panel({
  id,
  title,
  desc,
  icon,
  children,
  foot,
}: {
  id?: string;
  title: string;
  desc?: string;
  icon?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <section
      className="panel"
      id={id}
      aria-labelledby={id ? `${id}-h` : undefined}
    >
      <div className="panel-head">
        <h2 id={id ? `${id}-h` : undefined}>
          {icon && <span className="panel-icon">{icon}</span>}
          {title}
        </h2>
        {desc && <p className="desc">{desc}</p>}
      </div>
      <div className="panel-body">{children}</div>
      {foot && <div className="panel-foot">{foot}</div>}
    </section>
  );
}

export function Field({
  label,
  hint,
  icon,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  wide?: boolean;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={`field ${wide ? "field-wide" : ""}`}>
      <label className="field-label" htmlFor={id}>
        {icon}
        {label}
      </label>
      {children(id)}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

/** Two explicit states keep the selected value visible without an extra menu.
 *  `onDefault` adds デフォルト, which clears a personal override back to the server. */
export function BooleanSetting({
  label,
  hint,
  icon,
  value,
  onChange,
  onDefault,
}: {
  label: string;
  hint?: string;
  icon?: ReactNode;
  value: boolean | null | undefined;
  onChange: (v: boolean) => void;
  onDefault?: () => void;
}) {
  const labelId = useId();
  const current = value === true ? "on" : value === false ? "off" : onDefault ? "inherit" : "off";
  // 各状態にアイコンを添える（色だけだと色覚特性で ON/OFF が判別しづらい）
  const options: {
    key: string;
    text: string;
    next: boolean | null;
    glyph: ReactNode;
  }[] = [
    ...(onDefault ? [{ key: "inherit", text: "デフォルト", next: null, glyph: <Icon.layers size={13} /> }] : []),
    { key: "on", text: "ON", next: true, glyph: <Icon.check size={13} /> },
    { key: "off", text: "OFF", next: false, glyph: <Icon.close size={13} /> },
  ];
  return (
    <div className="field">
      <div className="field-label" id={labelId}>
        {icon}
        {label}
      </div>
      <div className="segmented" role="group" aria-labelledby={labelId}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={o.key}
            aria-pressed={current === o.key}
            onClick={() => {
              if (current === o.key) return;
              if (o.next === null) onDefault?.();
              else onChange(o.next);
            }}
          >
            {o.glyph}
            {o.text}
          </button>
        ))}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: "" | "accent" | "ok" | "muted" | "danger";
}) {
  return (
    <span className={`badge ${tone ? `badge-${tone}` : ""}`}>{children}</span>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Icon.inbox className="icon" />
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="alert alert-error" role="alert">
      <Icon.alert />
      <span>{children}</span>
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
    <div className="skeleton" style={{ height, width: width ?? "100%" }} />
  );
}

export function Loading({ label = "読み込み中…" }: { label?: string }) {
  return (
    <div className="status-pill" role="status">
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
  icon,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  desc?: string;
  icon?: ReactNode;
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
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal"
          aria-describedby={desc ? descriptionId : undefined}
          onOpenAutoFocus={() => {
            returnFocus.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus.current?.focus();
          }}
        >
          <div className="modal-head">
            <Dialog.Title>
              {icon && <span className="panel-icon">{icon}</span>}
              {title}
            </Dialog.Title>
            <button
              type="button"
              className="btn btn-ghost modal-x"
              onClick={onClose}
              aria-label="閉じる"
              title="閉じる"
            >
              <Icon.close />
            </button>
          </div>
          {desc && (
            <Dialog.Description id={descriptionId} className="modal-desc">
              {desc}
            </Dialog.Description>
          )}
          <div className="modal-body">{children}</div>
        </Dialog.Content>
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
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === "ok" ? <Icon.checkCircle /> : <Icon.alert />}
          {t.text}
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

/* ---------- scroll spy ---------- */
/** 設定セクションのサイドレールで、今見えている見出しを光らせる。 */
export function useActiveSection(ids: string[], ready: boolean): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    if (!ready) return;
    const nodes = ids
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => !!n);
    if (nodes.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        // 画面上部に一番近い可視セクションを採用する
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-72px 0px -65% 0px", threshold: 0 },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [ids.join(","), ready]);
  return active;
}
