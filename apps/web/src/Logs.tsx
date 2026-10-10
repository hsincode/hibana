import { Fragment, useEffect, useRef, useState } from "react";
import { api, apiCached, type GuildSummary } from "./api";
import { Alert, Badge, Empty, Icon, Seg, Skeleton, useDocumentTitle } from "./ui";

/* ============================================================
   会話ログ（bot が応答したやりとりの監査ログ）
   DM のやりとりを含むので、API は Administrator / Moderator にだけ返す。
   ここは読むだけ。絞り込みと続きの読み込みは API に任せる（apps/api/src/audit.ts）。
   ============================================================ */

type LogRow = {
  id: number;
  /** やりとりを始めたメッセージの時刻（Unix ミリ秒）。 */
  at: number;
  /** null は DM。 */
  guild_id: string | null;
  guild_name: string | null;
  channel_id: string;
  channel_name: string | null;
  user_id: string;
  username: string;
  trigger: string | null;
  prompt: string;
  reply: string | null;
  provider: string | null;
  model: string | null;
  /** 失敗したやりとりだけに入る。そのとき reply は null。 */
  error: string | null;
  failure_phase: string | null;
  failure_code: string | null;
  http_status: number | null;
  has_checkpoint: boolean | null;
  failure_stage: string | null;
  failure_reason: string | null;
  error_type: string | null;
  retries: number | null;
  effort: string | null;
  latency_ms: number | null;
};
type LogsResponse = {
  logs: LogRow[];
  /** 続きを読むカーソル。null なら、ここで終わり。 */
  next: number | null;
  retention_days: number;
  /** 記録が有効か（API の環境変数 WEB_LOGS_ENABLED）。 */
  enabled: boolean;
};
type Scope = "all" | "guild" | "dm";

const PAGE_SIZE = 50;
/**
 * 文字での絞り込みは、入力が止まってから送る。API は、依頼・返信・ログのユーザー名の欄を部分一致で探す。
 * bot はその欄に ID を入れているので、画面に出している名前（一覧から引いた名前）では探せない。
 */
const SEARCH_DELAY_MS = 300;
const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const duration = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} ms`);

function logsPath(scope: Scope, q: string, before: number | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (scope !== "all") params.set("scope", scope);
  if (q) params.set("q", q);
  if (before !== null) params.set("before", String(before));
  return `/api/logs?${params}`;
}

export function LogsPage() {
  const [scope, setScope] = useState<Scope>("all");
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [reloads, setReloads] = useState(0);
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [meta, setMeta] = useState<{ retention_days: number; enabled: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  // bot はログに名前を送っていない（ユーザー名の欄には ID が入る）。読み込み済みの一覧から引けた名前だけを出す。
  const [guildNames, setGuildNames] = useState<Record<string, string>>({});
  const [userNames, setUserNames] = useState<Record<string, string>>({});
  // 絞り込みを変えたあとに届いた「続き」を、新しい一覧に混ぜないための番号。
  const listing = useRef(0);
  useDocumentTitle("会話ログ");

  useEffect(() => {
    apiCached<{ guilds: GuildSummary[] }>("/api/guilds")
      .then((r) => setGuildNames(Object.fromEntries(r.guilds.map((g) => [g.id, g.name]))))
      .catch(() => undefined);
    api<{ users: { discord_id: string; username: string }[] }>("/api/users")
      .then((r) => setUserNames(Object.fromEntries(r.users.map((u) => [u.discord_id, u.username]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setQ(draft.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    let cancelled = false;
    listing.current += 1;
    setLoading(true);
    setOpen(null);
    api<LogsResponse>(logsPath(scope, q, null))
      .then((r) => {
        if (cancelled) return;
        setRows(r.logs);
        setNext(r.next);
        setMeta({ retention_days: r.retention_days, enabled: r.enabled });
        setErr(null);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, q, reloads]);

  async function loadMore() {
    if (next === null) return;
    const started = listing.current;
    setLoadingMore(true);
    try {
      const r = await api<LogsResponse>(logsPath(scope, q, next));
      if (started !== listing.current) return;
      setRows((prev) => [...(prev ?? []), ...r.logs]);
      setNext(r.next);
      setErr(null);
    } catch (e) {
      if (started === listing.current) setErr(String((e as Error).message ?? e));
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered = scope !== "all" || q !== "";
  const shown = rows ?? [];

  return (
    <div className="page is-wide">
      <header className="page-head">
        <h1>会話ログ</h1>
        <p className="lead">
          bot が応答したやりとりの監査ログです。DM のやりとりも含むので、Administrator と Moderator
          だけが読めます。
          {meta && ` 保持は ${meta.retention_days} 日で、それより古いぶんは消えます。`}
        </p>
      </header>

      {meta && !meta.enabled ? (
        <Empty
          title="会話ログは無効です"
          body="API サーバーの環境変数 WEB_LOGS_ENABLED を有効にすると、それ以降のやりとりがここに残ります。"
        />
      ) : (
        <>
          <div className="toolbar">
            <Seg
              label="範囲"
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: "すべて" },
                { value: "guild", label: "サーバー" },
                { value: "dm", label: "DM" },
              ]}
            />
            <label className="search grow">
              <span className="sr">依頼・返信・ユーザー ID で検索</span>
              <Icon.search />
              <input
                className="input"
                type="search"
                value={draft}
                placeholder="依頼・返信・ユーザー ID で検索"
                autoComplete="off"
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn"
              disabled={loading}
              onClick={() => setReloads((n) => n + 1)}
            >
              <Icon.refresh size={14} />
              再読み込み
            </button>
          </div>

          {err && <Alert>{err}</Alert>}
          {!rows && !err && <Skeleton height={280} />}
          {rows && shown.length === 0 && (
            <p className="muted">
              {filtered ? "一致するログはありません。" : "まだログがありません。"}
            </p>
          )}
          {shown.length > 0 && (
            <div className="table-wrap" aria-busy={loading}>
              <table className="log-table stack">
                <thead>
                  <tr>
                    <th>日時</th>
                    <th>場所</th>
                    <th>ユーザー</th>
                    <th>依頼</th>
                    <th>モデル</th>
                    <th className="num">応答時間</th>
                    <th>結果</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((l) => {
                    const isOpen = open === l.id;
                    const failed = l.error !== null;
                    const guild = l.guild_id ? (l.guild_name ?? guildNames[l.guild_id]) : null;
                    // ユーザー名の欄が ID のままなら、一覧から引いた名前を出す。
                    const user = l.username !== l.user_id ? l.username : userNames[l.user_id];
                    return (
                      <Fragment key={l.id}>
                        <tr
                          className={`log-row${isOpen ? " is-open" : ""}`}
                          onClick={() => setOpen(isOpen ? null : l.id)}
                        >
                          <td data-label="日時">
                            {/* 行のどこを押しても開く。キーボードではこのボタンで開く（押すと、行のクリックとして届く）。 */}
                            <button
                              type="button"
                              className="log-toggle"
                              aria-expanded={isOpen}
                              aria-controls={`log-${l.id}`}
                            >
                              <Icon.chevronRight size={14} />
                              <span>{timeFormat.format(l.at)}</span>
                            </button>
                          </td>
                          <td data-label="場所">
                            {l.guild_id === null ? (
                              <Badge>DM</Badge>
                            ) : (
                              (guild ?? <span className="mono">{l.guild_id}</span>)
                            )}{" "}
                            <span className="cell-sub mono">
                              {l.channel_name ? `#${l.channel_name}` : `ch ${l.channel_id}`}
                            </span>
                          </td>
                          <td data-label="ユーザー">
                            {user ?? <span className="mono">{l.user_id}</span>}
                          </td>
                          <td className="full" data-label="依頼">
                            <div className="prompt">{l.prompt}</div>
                          </td>
                          <td className="mono" data-label="モデル">
                            {l.model ?? "—"}
                          </td>
                          <td className="num" data-label="応答時間">
                            {l.latency_ms === null ? "—" : duration(l.latency_ms)}
                          </td>
                          <td data-label="結果">
                            {failed ? <Badge tone="danger">失敗</Badge> : <Badge tone="ok">成功</Badge>}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="log-detail" id={`log-${l.id}`}>
                            <td colSpan={7}>
                              <div className="log-detail-in">
                                <div>
                                  <h3>依頼</h3>
                                  <p>{l.prompt}</p>
                                  <h3 className="gap">返信</h3>
                                  <p>{l.reply ?? "—（返信なし）"}</p>
                                </div>
                                <div>
                                  <h3>{failed ? "失敗の詳細" : "記録された項目"}</h3>
                                  <Fields
                                    pairs={
                                      failed
                                        ? [
                                            ["error", l.error],
                                            ["failure_phase", l.failure_phase],
                                            ["failure_code", l.failure_code],
                                            ["http_status", l.http_status],
                                            ["failure_stage", l.failure_stage],
                                            ["failure_reason", l.failure_reason],
                                            ["error_type", l.error_type],
                                            ["retries", l.retries],
                                            ["has_checkpoint", l.has_checkpoint],
                                            ["provider", l.provider],
                                            ["model", l.model],
                                            ["effort", l.effort],
                                            ["trigger", l.trigger],
                                            ["latency_ms", l.latency_ms],
                                            ["guild_id", l.guild_id],
                                            ["channel_id", l.channel_id],
                                            ["user_id", l.user_id],
                                          ]
                                        : [
                                            ["provider", l.provider],
                                            ["model", l.model],
                                            ["effort", l.effort],
                                            ["trigger", l.trigger],
                                            ["latency_ms", l.latency_ms],
                                            ["guild_id", l.guild_id],
                                            ["channel_id", l.channel_id],
                                            ["user_id", l.user_id],
                                          ]
                                    }
                                  />
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {rows && shown.length > 0 && (
            <div className="log-more">
              {next !== null ? (
                <button
                  type="button"
                  className="btn"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "読み込み中…" : "さらに読み込む"}
                </button>
              ) : (
                <span>ここまで（{shown.length} 件）</span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 記録された項目を、名前と値の表で出す。値が無い項目は出さない。 */
function Fields({ pairs }: { pairs: [string, string | number | boolean | null][] }) {
  return (
    <dl className="kv">
      {pairs
        .filter(([, value]) => value !== null && value !== "")
        .map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{String(value)}</dd>
          </Fragment>
        ))}
    </dl>
  );
}
