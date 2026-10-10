import { useEffect, useState } from "react";
import { api, clearApiCache, type Catalog, type Preset } from "./api";
import { ChatgptAccounts } from "./ChatgptAccounts";
import {
  Alert,
  Badge,
  ProviderTile,
  Section,
  Seg,
  Skeleton,
  ToastArea,
  providerMeta,
  useDocumentTitle,
  useToasts,
} from "./ui";

/* ============================================================
   モデル公開 / プレミアム
   ============================================================ */
export function ModelsPage() {
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
    <div className="page is-wide">
      <header className="page-head">
        <div className="page-head-row">
          <h1>モデル</h1>
          {rows && (
            <div className="counts">
              <Badge>
                非公開 {unpublished} / {rows.length}
              </Badge>
              <Badge>
                プレミアム {premium} / {rows.length}
              </Badge>
            </div>
          )}
        </div>
        <p className="lead">
          Administrator / Moderator が /switch
          とダッシュボードに出すモデルを切り替えます。非公開はリリース前にカタログへ載せておき、公開にした瞬間から使えます。プレミアムは
          Premium / Moderator / Administrator だけが選べます。
        </p>
      </header>

      <ChatgptAccounts />

      <Section title="プリセット">
        {err && <Alert>{err}</Alert>}
        {!rows && !err && <Skeleton height={280} />}
        {rows && (
          <div className="table-wrap">
            <table className="stack">
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
                      <td className="full" data-label="モデル">
                        <div className="cell-main">
                          <ProviderTile provider={p.provider} label={p.label} />
                          <div>
                            <div className="cell-title mono">{p.model ?? p.id}</div>
                            <div className="cell-sub">{meta.label}</div>
                          </div>
                        </div>
                      </td>
                      <td className="mono full" data-label="preset">
                        {p.id}
                      </td>
                      <td data-label="公開">
                        <Seg
                          label={`${p.id} の公開`}
                          value={on ? "on" : "off"}
                          disabled={busy === p.id}
                          options={[
                            { value: "on", label: "公開" },
                            { value: "off", label: "非公開" },
                          ]}
                          onChange={(next) =>
                            void patchPreset(
                              p,
                              { published: next === "on" },
                              `${p.id} を${next === "on" ? "公開" : "非公開"}にした`,
                            )
                          }
                        />
                      </td>
                      <td data-label="プレミアム">
                        <Seg
                          label={`${p.id} のプレミアム`}
                          value={gated ? "on" : "off"}
                          disabled={busy === p.id}
                          options={[
                            { value: "off", label: "通常" },
                            { value: "on", label: "プレミアム" },
                          ]}
                          onChange={(next) =>
                            void patchPreset(
                              p,
                              { premium: next === "on" },
                              `${p.id} を${next === "on" ? "プレミアム" : "通常"}にした`,
                            )
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <ToastArea toasts={toasts} />
    </div>
  );
}
