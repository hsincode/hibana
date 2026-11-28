import { useCallback, useEffect, useState } from "react";
import type { PublicWorkspaceExportCommand } from "@hibana/shared/exports";
import { api, type GuildExportsResponse } from "./api";
import {
  Alert,
  Badge,
  Empty,
  Icon,
  ManageNote,
  Section,
  Seg,
  Skeleton,
  type Toast,
} from "./ui";

/* ============================================================
   データ（ワークスペースの .tar.gz エクスポート、#193）
   ============================================================ */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatDateTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatExpiry(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** サーバー設定の「データ」ページ。 */
export function GuildData({
  guildId,
  push,
}: {
  guildId: string;
  push: (kind: Toast["kind"], text: string) => void;
}) {
  const [data, setData] = useState<GuildExportsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [includeSettings, setIncludeSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await api<GuildExportsResponse>(
        `/api/guilds/${guildId}/exports`,
      );
      setData(res);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }, [guildId]);

  useEffect(() => {
    setData(null);
    setErr(null);
    void load();
  }, [load]);

  const exportsList = data?.exports ?? [];
  const hasPending = exportsList.some((c) => c.result === null);
  const hasLiveLink = exportsList.some(
    (c) =>
      c.result?.ok === true &&
      c.result.expires_at_unix * 1000 > nowMs &&
      Boolean(c.result.url),
  );

  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [hasPending, load]);

  useEffect(() => {
    if (!hasLiveLink) return;
    const timer = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [hasLiveLink]);

  const canEdit = data ? data.can_edit !== false : false;
  const maxRaw = data?.limits?.max_raw_bytes ?? 1024 * 1024 * 1024;
  const maxArchive = data?.limits?.max_archive_bytes ?? 500 * 1024 * 1024;
  const ttlMin = Math.round((data?.limits?.ttl_secs ?? 900) / 60);
  const cooldownSec = data?.limits?.cooldown_secs ?? 60;

  async function requestExport() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/guilds/${guildId}/exports`, {
        method: "POST",
        body: JSON.stringify({ include_settings: includeSettings }),
      });
      push("ok", "エクスポートを依頼しました。bot の同期後に圧縮を始めます。");
      await load();
    } catch (e) {
      const message = String((e as Error).message ?? e);
      setErr(message);
      push("error", message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="data"
      title="データ"
      desc="このサーバーのローカルワークスペースを .tar.gz 形式で圧縮してダウンロードします。bot が次に同期したときに圧縮を始め、完了すると短時間だけ有効なリンクが出ます。"
    >
      {data && !canEdit && <ManageNote />}
      {err && <Alert>{err}</Alert>}
      {!data && !err ? (
        <Skeleton height={160} />
      ) : (
        <>
          <div className="rows">
            <div className="row">
              <div className="row-label">
                <div className="row-name" id="export-settings-label">
                  サーバー設定（JSON）を含める
                </div>
                <p className="row-hint">
                  オンにすると、このサーバーの設定（
                  <span className="mono">settings.json</span>
                  ）をアーカイブの直下に同梱します。
                </p>
              </div>
              <div className="row-control">
                <Seg
                  labelledBy="export-settings-label"
                  wideOnMobile
                  value={includeSettings ? "on" : "off"}
                  disabled={!canEdit || busy || hasPending}
                  options={[
                    { value: "off", label: "含めない" },
                    { value: "on", label: "含める" },
                  ]}
                  onChange={(v) => setIncludeSettings(v === "on")}
                />
              </div>
              <div className="row-mark" aria-hidden="true" />
            </div>
            <div className="row">
              <div className="row-label">
                <div className="row-name">アーカイブを作成</div>
                <p className="row-hint">
                  対象はローカルワークスペース（
                  <span className="mono">workspaces/guilds/{guildId}</span>
                  ）です。スレッド専用ワークスペース・Anthropic
                  Workspace・スキル・定時アクション素材・成果物・動画プロジェクト・会話履歴・GitHub
                  認証情報・シンボリックリンクは含めません。上限は圧縮前{" "}
                  {formatBytes(maxRaw)}・圧縮後 {formatBytes(maxArchive)}
                  、リンク有効期限は {ttlMin} 分、再実行間隔は {cooldownSec}{" "}
                  秒です。
                </p>
              </div>
              <div className="row-control">
                <div className="toolbar">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!canEdit || busy || hasPending}
                    onClick={() => void requestExport()}
                  >
                    <Icon.download size={14} />
                    {busy
                      ? "依頼中…"
                      : hasPending
                        ? "準備中…"
                        : "エクスポートを作成"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn bordered"
                    aria-label="更新"
                    title="更新"
                    onClick={() => {
                      setNowMs(Date.now());
                      void load();
                    }}
                  >
                    <Icon.refresh />
                  </button>
                </div>
              </div>
              <div className="row-mark" aria-hidden="true" />
            </div>
          </div>

          {exportsList.length === 0 ? (
            <Empty
              title="エクスポートの履歴はありません"
              body="「エクスポートを作成」を押すと、ここに圧縮の進捗とダウンロードリンクが表示されます。"
            />
          ) : (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>作成日時</th>
                    <th>内容</th>
                    <th>状態</th>
                    <th>
                      <span className="sr">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exportsList.map((item) => (
                    <ExportRow
                      key={item.id}
                      item={item}
                      canEdit={canEdit}
                      nowMs={nowMs}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function ExportRow({
  item,
  canEdit,
  nowMs,
}: {
  item: PublicWorkspaceExportCommand;
  canEdit: boolean;
  nowMs: number;
}) {
  const res = item.result;
  const expired = res?.ok === true && res.expires_at_unix * 1000 <= nowMs;

  return (
    <tr>
      <td data-label="作成日時">
        <span className="mono">{formatDateTime(item.created_at)}</span>
      </td>
      <td className="full" data-label="内容">
        <div>
          ワークスペース
          {item.include_settings ? " + 設定 JSON" : ""}
        </div>
        {res?.ok === true && (
          <div className="muted mono">
            {res.filename} · {formatBytes(res.bytes)} · {res.file_count} 件
          </div>
        )}
      </td>
      <td data-label="状態">
        {res === null ? (
          <span className="pending" role="status">
            準備中（bot の同期待ち）
          </span>
        ) : res.ok === false ? (
          <div>
            <Badge tone="warn">失敗</Badge>{" "}
            <span className="muted">{res.error}</span>
          </div>
        ) : expired ? (
          <Badge>期限切れ</Badge>
        ) : (
          <Badge tone="ok">{formatExpiry(res.expires_at_unix)} まで有効</Badge>
        )}
      </td>
      <td className="full">
        {res?.ok === true && !expired && canEdit && res.url ? (
          <div className="cell-actions">
            <a
              className="btn btn-sm btn-primary"
              href={res.url}
              download={res.filename}
              rel="noreferrer"
            >
              <Icon.download size={14} />
              ダウンロード
            </a>
          </div>
        ) : res?.ok === true && !expired && !canEdit ? (
          <span className="muted">管理者のみ取得可</span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}
