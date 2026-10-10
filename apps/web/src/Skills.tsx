import { Select } from "./controls";
import { useCallback, useEffect, useState } from "react";
import { zipSync } from "fflate";
import { api, type GuildSummary } from "./api";
import { Alert, Badge, Icon, Loading, Modal, Seg } from "./ui";

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

/** サーバー設定の「スキル」ページの中身。どのサーバーかは URL（サイドバーの切替）で決まる。 */
export function SkillManager({
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
    <>
      <div className="toolbar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setName("");
            setDescription("");
            setBody("");
            setModal("create");
          }}
        >
          <Icon.plus size={14} />
          作成
        </button>
        <button type="button" className="btn" onClick={() => setModal("import")}>
          インポート
        </button>
        <span className="grow" />
        <button
          type="button"
          className="icon-btn bordered"
          aria-label="更新"
          title="更新"
          onClick={() => void load()}
        >
          <Icon.refresh />
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {pending.map((c) => (
        <p className="pending" role="status" key={c.id}>
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
        <p className="muted">スキルはありません。</p>
      ) : (
        <ul className="skill-list">
          {data.skills.map((s) => {
            const locked = busy || pending.some((c) => c.args.name === s.name);
            return (
              <li key={s.name} className="skill">
                <div className="skill-main">
                  <div className="skill-top">
                    <button type="button" className="skill-name" onClick={() => setPreview(s)}>
                      {s.name}
                    </button>
                    <Badge>{s.builtin ? "内蔵" : "カスタム"}</Badge>
                  </div>
                  <p className="skill-desc">{s.description}</p>
                </div>
                <div className="skill-actions">
                  <Seg
                    label={`${s.name} の有効・無効`}
                    value={s.enabled ? "on" : "off"}
                    disabled={locked}
                    options={[
                      { value: "on", label: "有効" },
                      { value: "off", label: "無効" },
                    ]}
                    onChange={(next) =>
                      void act({
                        action: "enabled",
                        name: s.name,
                        enabled: next === "on",
                      })
                    }
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    title="ダウンロード"
                    aria-label={`${s.name} をダウンロード`}
                    onClick={() => download(s)}
                  >
                    <Icon.download />
                  </button>
                  {s.builtin ? (
                    // 内蔵スキルは削除できない。列をそろえるための空き。
                    <span className="icon-btn" aria-hidden="true" />
                  ) : (
                    <button
                      type="button"
                      className="icon-btn"
                      title="削除"
                      aria-label={`${s.name} を削除`}
                      disabled={locked}
                      onClick={() => setDeleting(s)}
                    >
                      <Icon.trash />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Modal
        open={modal !== null}
        onClose={() => !busy && setModal(null)}
        title={modal === "create" ? "スキルを作成" : "他サーバーからインポート"}
      >
        {error && <Alert>{error}</Alert>}
        <form
          className="form-grid"
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
              <label className="field">
                <span className="field-name">名前</span>
                <input
                  className="input mono"
                  required
                  minLength={2}
                  maxLength={64}
                  pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <span className="field-hint">英小文字・数字・ハイフン。2〜64 文字。</span>
              </label>
              <label className="field">
                <span className="field-name">説明</span>
                <textarea
                  className="textarea sm"
                  required
                  maxLength={2000}
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-name">本文</span>
                <textarea
                  className="textarea mono"
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
              <label className="field">
                <span className="field-name">コピー元サーバー</span>
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
              <label className="field">
                <span className="field-name">スキル</span>
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
                <p className="muted">コピーできるスキルはありません。</p>
              )}
            </>
          )}
          <div className="modal-foot">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || (modal === "import" && !sourceName)}
            >
              {busy ? "送信中" : modal === "create" ? "作成" : "コピー"}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={deleting !== null}
        onClose={() => !busy && setDeleting(null)}
        title="スキルを削除"
        size="narrow"
      >
        <p>{deleting?.name} と補助ファイルを削除します。</p>
        {error && <Alert>{error}</Alert>}
        <div className="modal-foot">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setDeleting(null)}
          >
            キャンセル
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() =>
              deleting && void act({ action: "delete", name: deleting.name })
            }
          >
            <Icon.trash size={14} />
            削除
          </button>
        </div>
      </Modal>
      <Modal
        open={preview !== null}
        onClose={() => setPreview(null)}
        title={preview?.name ?? "スキル"}
        size="wide"
      >
        {preview && (
          <>
            <pre className="code">
              {new TextDecoder().decode(
                Uint8Array.from(atob(preview.files["SKILL.md"] ?? ""), (c) =>
                  c.charCodeAt(0),
                ),
              )}
            </pre>
            <ul className="files">
              {Object.keys(preview.files).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="modal-foot">
              <button type="button" className="btn" onClick={() => download(preview)}>
                <Icon.download size={14} />
                ダウンロード
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
