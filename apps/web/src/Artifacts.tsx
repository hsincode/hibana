import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiCached, type Artifact, type GuildSummary } from "./api";
import {
  Alert,
  Badge,
  Empty,
  Section,
  Seg,
  Skeleton,
  ToastArea,
  useDocumentTitle,
  useToasts,
  type Toast,
} from "./ui";

/* ============================================================
   成果物（publish_site）
   ============================================================ */
type Retention = "all" | "ttl" | "month" | "permanent";
type Action = "month" | "permanent" | "unpermanent";

export function ArtifactsPage() {
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
    <div className="page is-wide">
      <header className="page-head">
        <h1>成果物</h1>
        <p className="lead">
          ボットが公開したサイト。既定は約 48 時間で消えます。1
          ヶ月延命か永久化できます。永久化の解除もここから。
        </p>
      </header>
      {err && <Alert>{err}</Alert>}
      {/* 一覧を取れなかったときは、読み込み中の枠を出し続けない。 */}
      {!err && (
        <section className="sec">
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
        </section>
      )}
      <ToastArea toasts={toasts} />
    </div>
  );
}

/** サーバー設定の「成果物」ページ。 */
export function GuildArtifacts({
  guildId,
  push,
}: {
  guildId: string;
  push: (kind: Toast["kind"], text: string) => void;
}) {
  const [sites, setSites] = useState<Artifact[] | null>(null);

  const load = useCallback(() => {
    api<{ sites: Artifact[] }>(`/api/guilds/${guildId}/artifacts`)
      .then((r) => setSites(r.sites))
      .catch(() => setSites([]));
  }, [guildId]);

  useEffect(() => {
    setSites(null);
    load();
  }, [load]);

  return (
    <Section
      id="artifacts"
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
    </Section>
  );
}

const PENDING_LABEL: Record<string, string> = {
  permanent: "永久化待ち",
  unpermanent: "解除待ち",
};

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
  onAct: (site: Artifact, action: Action, ok: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [filter, setFilter] = useState<Retention>("all");
  const [busy, setBusy] = useState<string | null>(null);

  if (!sites) return <Skeleton height={160} />;
  const shown = sites.filter((s) =>
    filter === "all" ? true : s.retention === filter,
  );
  const count = (key: Retention) =>
    key === "all" ? sites.length : sites.filter((s) => s.retention === key).length;

  async function act(site: Artifact, action: Action, ok: string) {
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
    <>
      <div className="toolbar">
        <Seg
          label="成果物の絞り込み"
          value={filter}
          onChange={setFilter}
          options={(
            [
              ["all", "すべて"],
              ["ttl", "既定"],
              ["month", "1ヶ月"],
              ["permanent", "永久"],
            ] as const
          ).map(([value, label]) => ({ value, label, count: count(value) }))}
        />
      </div>

      {shown.length === 0 ? (
        <Empty
          title="公開中のサイトはない"
          body="ボットが publish_site するとここに出ます。"
        />
      ) : (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                {showGuild && <th>サーバー</th>}
                <th>パス</th>
                <th>URL</th>
                <th>期限</th>
                <th>
                  <span className="sr">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.token}>
                  {showGuild && (
                    <td data-label="サーバー">
                      {(s.guild_id && guildNames?.[s.guild_id]) ||
                        s.guild_id ||
                        "DM"}
                    </td>
                  )}
                  <td className="full" data-label="パス">
                    <div className="cell-title mono">{s.source_path || "—"}</div>
                  </td>
                  <td className="full" data-label="URL">
                    <a
                      className="link mono"
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s.url}
                    </a>
                  </td>
                  <td data-label="期限">
                    <RetentionBadge site={s} />
                    {s.pending && (
                      <>
                        {" "}
                        <span className="pending">
                          {PENDING_LABEL[s.pending] ?? "延命待ち"}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="full">
                    <div className="cell-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!!busy || s.retention === "permanent"}
                        onClick={() => void act(s, "month", "1ヶ月延命を依頼した")}
                      >
                        1ヶ月
                      </button>
                      {s.retention === "permanent" ? (
                        <button
                          type="button"
                          className="btn btn-sm"
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
                          className="btn btn-sm"
                          disabled={!!busy}
                          onClick={() => void act(s, "permanent", "永久化を依頼した")}
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
    </>
  );
}

function RetentionBadge({ site }: { site: Artifact }) {
  if (site.retention === "permanent") return <Badge tone="solid">永久</Badge>;
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
  return site.retention === "month" ? (
    <Badge>1ヶ月 · {label}</Badge>
  ) : (
    <span className="mono">{label}</span>
  );
}
