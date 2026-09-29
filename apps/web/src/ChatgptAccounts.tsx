import { useEffect, useState } from "react";
import { api, clearApiCache } from "./api";
import { Alert } from "./ui";
type Account = { id: string; email: string | null; enabled: boolean };
type Login = { id: string; user_code: string; verification_url: string; expires_at: number; interval: number };
export function ChatgptAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [login, setLogin] = useState<Login | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
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
    if (remove && !window.confirm("このマスターアカウントを削除しますか？")) return;
    setBusy(true);
    try { await api("/api/chatgpt/accounts/" + encodeURIComponent(a.id), { method: remove ? "DELETE" : "PATCH", body: remove ? undefined : JSON.stringify({ enabled: !a.enabled }) }); clearApiCache(); await load(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-body"><h2>ChatGPT マスターアカウント</h2><p>有効なマスターアカウントがあれば、一般ユーザーも ChatGPT モデルを利用できます。</p><button className="btn btn-secondary" disabled={busy} onClick={start}>ChatGPT アカウントを登録・再認証</button>{error && <Alert>{error}</Alert>}{message && <p role="status">{message}</p>}{login && <div role="status"><p>認証コード：<strong>{login.user_code}</strong></p><a className="btn btn-secondary" href={login.verification_url} target="_blank" rel="noreferrer">ブラウザで ChatGPT にログイン</a><p>認証画面でコードを入力してください。</p></div>}<ul>{accounts.map(a => <li key={a.id}>{a.email ?? a.id} · {a.enabled ? "有効" : "無効"} <button className="btn btn-ghost" disabled={busy} onClick={() => manage(a, false)}>{a.enabled ? "無効にする" : "有効にする"}</button> <button className="btn btn-ghost" disabled={busy} onClick={() => manage(a, true)}>削除</button></li>)}</ul></div></section>;
}
