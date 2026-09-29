import { Select } from "./controls";
import { useCallback, useEffect, useState } from "react";
import {
  Download,
  Plus,
  Copy,
  Trash2,
  RefreshCw,
  BookOpen,
} from "lucide-react";
import { zipSync } from "fflate";
import { api, type GuildSummary } from "./api";
import { Alert, Loading, Modal } from "./ui";
import "./skills.css";

type Skill = {
  guild_id: string;
  name: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  files: Record<string, string>;
};
type Command = {
  id: number;
  action: string;
  args: { name: string };
  result: { ok: boolean; error?: string } | null;
};
type Catalog = { skills: Skill[]; commands: Command[] };

function download(skill: Skill) {
  const files: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(skill.files))
    files[`${skill.name}/${path}`] = Uint8Array.from(atob(content), (c) =>
      c.charCodeAt(0),
    );
  const zipped = zipSync(files);
  const url = URL.createObjectURL(
    new Blob([zipped.slice().buffer], { type: "application/zip" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${skill.name}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SkillsPage() {
  const [guilds, setGuilds] = useState<GuildSummary[]>([]);
  const [guild, setGuild] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ guilds: GuildSummary[] }>("/api/guilds")
      .then((r) => {
        setGuilds(r.guilds);
        setGuild(r.guilds[0]?.id ?? "");
      })
      .catch((e) => setError(String(e)));
  }, []);
  return (
    <div className="skills-page">
      <h1>スキル</h1>
      {error && <Alert>{error}</Alert>}
      <label className="skill-field">
        サーバー
        <Select
          aria-label="サーバー"
          value={guild}
          onValueChange={(e) => setGuild(e)}
        >
          <option value="" disabled>
            サーバーを選択
          </option>
          {guilds.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
      </label>
      {guild && <SkillManager key={guild} guildId={guild} guilds={guilds} />}
    </div>
  );
}

function SkillManager({
  guildId,
  guilds,
}: {
  guildId: string;
  guilds: GuildSummary[];
}) {
  const [data, setData] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<"create" | "import" | null>(null);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const [preview, setPreview] = useState<Skill | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [source, setSource] = useState("");
  const [sourceSkills, setSourceSkills] = useState<Skill[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceName, setSourceName] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await api<Catalog>(`/api/guilds/${guildId}/skills`));
    } catch (e) {
      setError(String(e));
    }
  }, [guildId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    setSourceSkills([]);
    setSourceName("");
    if (!source) return;
    let live = true;
    setSourceLoading(true);
    api<Catalog>(`/api/guilds/${source}/skills`)
      .then((r) => {
        if (live) {
          setSourceSkills(r.skills.filter((s) => !s.builtin));
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setSourceLoading(false);
      });
    return () => {
      live = false;
    };
  }, [source]);
  async function act(action: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/guilds/${guildId}/skills`, {
        method: "POST",
        body: JSON.stringify(action),
      });
      setModal(null);
      setDeleting(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const pending = data?.commands.filter((c) => c.result === null) ?? [];
  return (
    <section className="skill-manager">
      <div className="skill-toolbar">
        <button
          className="btn btn-primary"
          onClick={() => {
            setName("");
            setDescription("");
            setBody("");
            setModal("create");
          }}
        >
          <Plus size={16} />
          作成
        </button>
        <button className="btn" onClick={() => setModal("import")}>
          <Copy size={16} />
          インポート
        </button>
        <button
          className="btn icon-button"
          aria-label="更新"
          title="更新"
          onClick={() => void load()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {pending.map((c) => (
        <p className="skill-pending" role="status" key={c.id}>
          {c.args.name}: 反映待ち
        </p>
      ))}
      {data?.commands
        .filter((c) => c.result?.ok === false)
        .slice(-3)
        .map((c) => (
          <Alert key={c.id}>
            {c.args.name}: {c.result?.error ?? "操作に失敗しました"}
          </Alert>
        ))}
      {!data ? (
        <Loading />
      ) : !data.skills.length ? (
        <p>スキルはありません。</p>
      ) : (
        <div className="skill-list">
          {data.skills.map((s) => {
            const locked = busy || pending.some((c) => c.args.name === s.name);
            return (
              <article key={s.name} className="skill-row">
                <div className="skill-info">
                  <button className="skill-name" onClick={() => setPreview(s)}>
                    <BookOpen size={16} />
                    {s.name}
                  </button>
                  <span className="skill-source">
                    {s.builtin ? "内蔵" : "カスタム"}
                  </span>
                  <p>{s.description}</p>
                </div>
                <div className="skill-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={locked}
                      onChange={(e) =>
                        void act({
                          action: "enabled",
                          name: s.name,
                          enabled: e.target.checked,
                        })
                      }
                    />
                    {s.enabled ? "有効" : "無効"}
                  </label>
                  <button
                    className="btn icon-button"
                    title="ダウンロード"
                    aria-label={`${s.name} をダウンロード`}
                    onClick={() => download(s)}
                  >
                    <Download size={16} />
                  </button>
                  {!s.builtin && (
                    <button
                      className="btn icon-button"
                      title="削除"
                      aria-label={`${s.name} を削除`}
                      disabled={locked}
                      onClick={() => setDeleting(s)}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <Modal
        open={modal !== null}
        onClose={() => !busy && setModal(null)}
        title={modal === "create" ? "スキルを作成" : "他サーバーからインポート"}
      >
        {error && <Alert>{error}</Alert>}
        <form
          className="skill-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              modal === "create"
                ? { action: "create", name, description, body }
                : {
                    action: "import",
                    source_guild_id: source,
                    name: sourceName,
                  },
            );
          }}
        >
          {modal === "create" ? (
            <>
              <label>
                名前
                <input
                  required
                  minLength={2}
                  maxLength={64}
                  pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                説明
                <textarea
                  required
                  maxLength={2000}
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label>
                本文
                <textarea
                  required
                  maxLength={80000}
                  rows={12}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                コピー元サーバー
                <Select
                  aria-label="コピー元サーバー"
                  required
                  value={source}
                  onValueChange={(e) => setSource(e)}
                >
                  <option value="">選択</option>
                  {guilds
                    .filter((g) => g.id !== guildId)
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label>
                スキル
                <Select
                  aria-label="スキル"
                  required
                  disabled={sourceLoading}
                  value={sourceName}
                  onValueChange={(e) => setSourceName(e)}
                >
                  <option value="">
                    {sourceLoading ? "読み込み中" : "選択"}
                  </option>
                  {sourceSkills.map((s) => (
                    <option
                      key={s.name}
                      value={s.name}
                      disabled={data?.skills.some((d) => d.name === s.name)}
                    >
                      {s.name}
                    </option>
                  ))}
                </Select>
              </label>
              {source && !sourceLoading && !sourceSkills.length && (
                <p>コピーできるスキルはありません。</p>
              )}
            </>
          )}
          <button
            className="btn btn-primary"
            type="submit"
            disabled={busy || (modal === "import" && !sourceName)}
          >
            {busy ? "送信中" : modal === "create" ? "作成" : "コピー"}
          </button>
        </form>
      </Modal>
      <Modal
        open={deleting !== null}
        onClose={() => !busy && setDeleting(null)}
        title="スキルを削除"
      >
        <p>{deleting?.name} と補助ファイルを削除します。</p>
        {error && <Alert>{error}</Alert>}
        <div className="modal-actions">
          <button
            className="btn"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            キャンセル
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() =>
              deleting && void act({ action: "delete", name: deleting.name })
            }
          >
            <Trash2 size={16} />
            削除
          </button>
        </div>
      </Modal>
      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.name ?? "スキル"}
      >
        {preview && (
          <>
            <pre className="skill-preview">
              {new TextDecoder().decode(
                Uint8Array.from(atob(preview.files["SKILL.md"] ?? ""), (c) =>
                  c.charCodeAt(0),
                ),
              )}
            </pre>
            <ul>
              {Object.keys(preview.files).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <button className="btn" onClick={() => download(preview)}>
              <Download size={16} />
              ダウンロード
            </button>
          </>
        )}
      </Modal>
    </section>
  );
}
