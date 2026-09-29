import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Store } from "./store";

// Same public client and device endpoints as hsincli/codex-rs/login.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const STATE = "chatgpt_master_accounts_v1";
type Tokens = { access_token: string; refresh_token: string; id_token?: string; expires_in?: number };
type Account = { id: string; email: string | null; enabled: boolean; created_at: number; expires_at: number; tokens: Tokens };
type Pending = { owner: string; device_auth_id: string; user_code: string; expires_at: number; next_poll: number; interval: number };
type State = { accounts: Account[]; pending: Record<string, Pending> };

export class ChatgptError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class ChatgptAccounts {
  private key: Buffer;
  constructor(private store: Store, secret: string, private fetcher: typeof fetch = fetch) {
    // OAuth credentials are runtime data. Only the encryption secret lives in
    // the environment; neither dashboard JSON nor bot snapshots contain tokens.
    this.key = createHash("sha256").update("hibana-chatgpt-v1:" + secret).digest();
  }
  private seal(state: State) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  private async read(): Promise<State> {
    const raw = await this.store.getMeta(STATE);
    if (!raw) return { accounts: [], pending: {} };
    const data = Buffer.from(raw, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
  }
  private async change<T>(fn: (state: State) => Promise<T>): Promise<T> {
    const key = STATE + "_lock";
    const previous = await this.store.getMeta(key);
    if (previous && JSON.parse(previous).until > Date.now())
      throw new ChatgptError(409, "ChatGPT の処理中です。少し待って再試行してください");
    const lock = JSON.stringify({ id: randomUUID(), until: Date.now() + 90_000 });
    if (!await this.store.compareMeta(key, previous, lock))
      throw new ChatgptError(409, "ChatGPT の処理中です。再試行してください");
    try {
      const state = await this.read();
      for (const [id, p] of Object.entries(state.pending))
        if (p.expires_at <= Date.now()) delete state.pending[id];
      const result = await fn(state);
      await this.store.setMeta(STATE, this.seal(state));
      return result;
    } finally {
      await this.store.compareMeta(key, lock, JSON.stringify({ until: 0 }));
    }
  }
  private async request(path: string, body: Record<string, string>, form = false) {
    try {
      return await this.fetcher(ISSUER + path, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams(body) : JSON.stringify(body),
      });
    } catch {
      throw new ChatgptError(502, "ChatGPT の認証サーバーに接続できません");
    }
  }
  private async token(body: Record<string, string>): Promise<Tokens> {
    const response = await this.request("/oauth/token", { client_id: CLIENT_ID, ...body }, true);
    if (!response.ok) throw new ChatgptError(502, "ChatGPT 認証を更新できません。再登録してください");
    const token = await response.json() as Tokens;
    if (!token.access_token || !token.refresh_token)
      throw new ChatgptError(502, "ChatGPT 認証情報が不完全です");
    return token;
  }
  private claims(token: string | undefined): Record<string, any> {
    // These tokens come directly from the fixed HTTPS issuer, never from user
    // input. Claims are metadata only, not proof of dashboard authorization.
    try { return JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString()); }
    catch { return {}; }
  }
  private identity(tokens: Tokens) {
    return this.claims(tokens.id_token)["https://api.openai.com/auth"]?.chatgpt_account_id
      ?? this.claims(tokens.access_token)["https://api.openai.com/auth"]?.chatgpt_account_id;
  }
  private expiry(tokens: Tokens) {
    const exp = this.claims(tokens.access_token).exp;
    return typeof exp === "number" ? exp * 1000 : Date.now() + (tokens.expires_in || 3600) * 1000;
  }
  async list() {
    return (await this.read()).accounts.map(({ tokens, ...account }) => account);
  }
  async available() { return (await this.list()).some(a => a.enabled); }
  async start(owner: string) {
    return this.change(async state => {
      const res = await this.request("/api/accounts/deviceauth/usercode", { client_id: CLIENT_ID });
      if (!res.ok) throw new ChatgptError(502, "ChatGPT のデバイス認証を開始できません");
      const data = await res.json() as { device_auth_id: string; user_code?: string; usercode?: string; interval?: string };
      const code = data.user_code ?? data.usercode;
      if (!code || !data.device_auth_id) throw new ChatgptError(502, "ChatGPT 認証コードが不完全です");
      const id = randomUUID();
      const interval = Math.max(5, Math.min(60, Number(data.interval) || 5)) * 1000;
      // One pending attempt per session bounds storage and supersedes an
      // abandoned registration without affecting another administrator.
      for (const [key, p] of Object.entries(state.pending)) if (p.owner === owner) delete state.pending[key];
      const expires_at = Date.now() + 15 * 60_000;
      state.pending[id] = { owner, device_auth_id: data.device_auth_id, user_code: code, expires_at, interval, next_poll: Date.now() + interval };
      return { id, user_code: code, verification_url: ISSUER + "/codex/device", expires_at, interval };
    });
  }
  async poll(owner: string, id: string) {
    return this.change(async state => {
      const p = state.pending[id];
      if (!p || p.owner !== owner) throw new ChatgptError(404, "認証が期限切れか、別のセッションで開始されています");
      if (p.next_poll > Date.now()) return { status: "pending" };
      p.next_poll = Date.now() + p.interval;
      const res = await this.request("/api/accounts/deviceauth/token", { device_auth_id: p.device_auth_id, user_code: p.user_code });
      if (res.status === 403 || res.status === 404) return { status: "pending" };
      if (!res.ok) throw new ChatgptError(502, "ChatGPT 認証を確認できません");
      const code = await res.json() as { authorization_code: string; code_verifier: string };
      if (!code.authorization_code || !code.code_verifier) throw new ChatgptError(502, "ChatGPT 認証結果が不完全です");
      const tokens = await this.token({ grant_type: "authorization_code", code: code.authorization_code, code_verifier: code.code_verifier, redirect_uri: ISSUER + "/deviceauth/callback" });
      const accountId = this.identity(tokens);
      if (typeof accountId !== "string" || !accountId) throw new ChatgptError(502, "ChatGPT アカウントを確認できません");
      const old = state.accounts.find(a => a.id === accountId);
      const email = this.claims(tokens.id_token).email;
      const account: Account = { id: accountId, email: typeof email === "string" ? email : null, enabled: true, created_at: old?.created_at ?? Date.now(), expires_at: this.expiry(tokens), tokens };
      state.accounts = [...state.accounts.filter(a => a.id !== accountId), account];
      delete state.pending[id];
      return { status: "complete" };
    });
  }
  async manage(id: string, enabled: boolean | null) {
    return this.change(async state => {
      const a = state.accounts.find(a => a.id === id);
      if (!a) throw new ChatgptError(404, "アカウントが見つかりません");
      if (enabled === null) state.accounts = state.accounts.filter(a => a.id !== id);
      else a.enabled = enabled;
      return { ok: true };
    });
  }
  async credential() {
    const ready = (await this.read()).accounts.find(a => a.enabled);
    if (ready && ready.expires_at >= Date.now() + 60_000)
      return { access_token: ready.tokens.access_token, account_id: ready.id };
    // Serialize refresh with deletion/disable so an in-flight refresh cannot
    // resurrect credentials removed by another Vercel instance.
    return this.change(async state => {
      const account = state.accounts.find(a => a.enabled);
      if (!account) throw new ChatgptError(503, "有効な ChatGPT マスターアカウントがありません");
      if (account.expires_at < Date.now() + 60_000) {
        const tokens = await this.token({ grant_type: "refresh_token", refresh_token: account.tokens.refresh_token });
        const identity = this.identity(tokens);
        if (identity && identity !== account.id) throw new ChatgptError(502, "ChatGPT アカウントが一致しません");
        account.tokens = tokens;
        account.expires_at = this.expiry(tokens);
      }
      return { access_token: account.tokens.access_token, account_id: account.id };
    });
  }
}
