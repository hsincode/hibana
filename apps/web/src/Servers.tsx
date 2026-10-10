import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { apiCached, type Catalog, type GuildSummary, type Preset } from "./api";
import {
  Alert,
  Avatar,
  Empty,
  Icon,
  ProviderTile,
  Skeleton,
  cdnUrl,
  useDocumentTitle,
} from "./ui";

/* ============================================================
   サーバー一覧
   ============================================================ */
export function GuildList() {
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
    <div className="page is-wide">
      <header className="page-head">
        <div className="page-head-row">
          <div>
            <h1>サーバー</h1>
            <p className="lead">
              {guilds
                ? `${guilds.length} 件のサーバーを管理できます。`
                : "ボットが入っているサーバーを読み込み中…"}
            </p>
          </div>
          {guilds && guilds.length > 0 && (
            <label className="search head-search">
              <Icon.search />
              <input
                className="input"
                type="search"
                value={q}
                placeholder="名前 / ID で絞り込み"
                aria-label="サーバーを絞り込み"
                autoComplete="off"
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
          )}
        </div>
      </header>

      {err && <Alert>{err}</Alert>}

      {!guilds && !err && (
        <div className="guild-grid">
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
        <div className="guild-grid">
          {shown.map((g) => (
            <Link key={g.id} to={`/g/${g.id}`} className="guild-card frame">
              <Avatar src={cdnUrl("icons", g.id, g.icon)} name={g.name} />
              <span className="body">
                <span className="name">{g.name}</span>
                <span className="meta">
                  <span className="model">
                    {g.preset ? (
                      <>
                        <ProviderTile provider={providerOf(g.preset)} />
                        {g.preset}
                      </>
                    ) : (
                      <span className="is-text">env 既定</span>
                    )}
                  </span>
                </span>
              </span>
              <Icon.chevronRight />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
