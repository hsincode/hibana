import { useEffect, useState } from "react";
import { api, clearApiCache } from "./api";
import { Alert, Badge, Icon, Modal, Section } from "./ui";

type Account = { id: string; email: string | null; enabled: boolean };
type Login = { id: string; user_code: string; verification_url: string; expires_at: number; interval: number };

/** ChatGPT のマスターアカウント。有効なものが 1 つでもあれば、一般ユーザーも ChatGPT モデルを使える。 */
export function ChatgptAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [login, setLogin] = useState<Login | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [removing, setRemoving] = useState<Account | null>(null);
  const load = async () => setAccounts((await api<{ accounts: Account[] }>("/api/chatgpt/accounts")).accounts);
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!login) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (Date.now() >= login.expires_at) { setLogin(null); setError("認証コードが期限切れです"); return; }
      try {
        const result = await api<{ status: string }>("/api/chatgpt/login/" + login.id, { method: "POST" });
        if (cancelled) return;
        if (result.status === "complete") { setLogin(null); setMessage("登録しました。一般ユーザーも ChatGPT モデルを利用できます。"); clearApiCache(); await load(); return; }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      if (!cancelled) timer = setTimeout(poll, login.interval);
    };
    timer = setTimeout(poll, login.interval);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [login]);
  async function start() { setBusy(true); setError(""); try { setLogin(await api<Login>("/api/chatgpt/login", { method: "POST" })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function manage(a: Account, remove: boolean) {
    setBusy(true);
    try { await api("/api/chatgpt/accounts/" + encodeURIComponent(a.id), { method: remove ? "DELETE" : "PATCH", body: remove ? undefined : JSON.stringify({ enabled: !a.enabled }) }); clearApiCache(); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); setRemoving(null); }
  }
  return (
    <Section
      title="ChatGPT マスターアカウント"
      desc="有効なマスターアカウントがあれば、一般ユーザーも ChatGPT モデルを利用できます。"
    >
      <div className="toolbar">
        <button type="button" className="btn" disabled={busy} onClick={start}>
          ChatGPT アカウントを登録・再認証
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {message && <p className="muted" role="status">{message}</p>}
      {login && (
        <div className="auth-box" role="status">
          <span>
            認証コード：<strong className="code-big">{login.user_code}</strong>
          </span>
          <a className="link" href={login.verification_url} target="_blank" rel="noreferrer">
            ブラウザで ChatGPT にログイン <Icon.external size={13} />
          </a>
          <span className="muted">認証画面でコードを入力してください。</span>
        </div>
      )}
      {accounts.length > 0 && (
        <ul className="account-list">
          {accounts.map(a => (
            <li key={a.id}>
              <span>
                <span className="mono">{a.email ?? a.id}</span>
                {" · "}
                <Badge tone={a.enabled ? "ok" : ""}>{a.enabled ? "有効" : "無効"}</Badge>
              </span>
              <span className="cell-actions">
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => manage(a, false)}>
                  {a.enabled ? "無効にする" : "有効にする"}
                </button>
                <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => setRemoving(a)}>
                  削除
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={removing !== null}
        onClose={() => !busy && setRemoving(null)}
        title="マスターアカウントを削除"
        size="narrow"
      >
        <p>このマスターアカウントを削除しますか？</p>
        <p className="mono">{removing?.email ?? removing?.id}</p>
        <div className="modal-foot">
          <button type="button" className="btn" disabled={busy} onClick={() => setRemoving(null)}>
            キャンセル
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => removing && void manage(removing, true)}>
            <Icon.trash size={14} />
            削除
          </button>
        </div>
      </Modal>
    </Section>
  );
}
