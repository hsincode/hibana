import { useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "./api";
import { Select } from "./controls";
import {
  Alert,
  Avatar,
  Badge,
  Empty,
  Icon,
  Modal,
  Section,
  Skeleton,
  ToastArea,
  useDocumentTitle,
  useToasts,
} from "./ui";

/* ============================================================
   ユーザー管理と利用停止
   ============================================================ */
type UserRow = {
  discord_id: string;
  username: string;
  role: string;
  /** 利用を止めているか。旧 API は返さない。 */
  blocked?: boolean;
};
type BlockedRow = {
  discord_id: string;
  /** ID を指定して止めた相手は、名前が分からないことがある。 */
  username: string | null;
  reason: string | null;
  /** 止めた人の Discord の ID。 */
  blocked_by: string;
  blocked_at: number;
};

/** API と同じ規則。名前を入れても、bot は ID でしか照合しないので誰も止まらない。 */
const SNOWFLAKE = /^\d{5,25}$/;
const REASON_MAX = 500;
const dateTime = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function UsersPage({ me }: { me: Me }) {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [assignable, setAssignable] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<BlockedRow[] | null>(null);
  const [blockedErr, setBlockedErr] = useState<string | null>(null);
  // 止める相手。行のボタンからでも、ID の欄からでも、同じ確認のダイアログを通す。
  const [target, setTarget] = useState<{ id: string; name: string | null } | null>(null);
  const [reason, setReason] = useState("");
  const [idDraft, setIdDraft] = useState("");
  const [idError, setIdError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toasts, push } = useToasts();
  useDocumentTitle("ユーザー");
  // 旧 API は can_moderate を返さない。無ければ、利用停止は出さない。
  const canModerate = me.can_moderate === true;

  const load = () => {
    api<{ users: UserRow[]; assignable: string[] }>("/api/users")
      .then((r) => {
        setRows(r.users);
        setAssignable(r.assignable);
      })
      .catch((e) => setErr(String(e.message ?? e)));
    if (canModerate)
      api<{ blocked: BlockedRow[] }>("/api/blocked")
        .then((r) => {
          setBlocked(r.blocked);
          setBlockedErr(null);
        })
        .catch((e) => setBlockedErr(String(e.message ?? e)));
  };
  useEffect(load, []);

  async function setRole(u: UserRow, role: string) {
    try {
      await api(`/api/users/${u.discord_id}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      push("ok", `${u.username} を ${role} にした`);
      load();
    } catch (e) {
      push("error", String((e as Error).message ?? e));
    }
  }

  const nameOf = (id: string) => rows?.find((u) => u.discord_id === id)?.username ?? null;
  const roleOf = (id: string) => rows?.find((u) => u.discord_id === id)?.role;
  // 止める・解除を出す相手は、自分以外で、自分より弱いロールの相手か、一覧に無い（ロールの分からない）ID。
  // 止めるほうは API も同じ規則で断る。解除は API がロールを見ていないので、画面で同じ規則に揃えている。
  const manageable = (id: string) => {
    if (!canModerate || !rows || id === me.id) return false;
    const role = roleOf(id);
    return role === undefined || assignable.includes(role);
  };

  async function block() {
    if (!target) return;
    setBusy(true);
    try {
      await api("/api/blocked", {
        method: "POST",
        body: JSON.stringify({ discord_id: target.id, reason: reason.trim() || null }),
      });
      push("ok", `${target.name ?? target.id} の利用を停止した`);
      setTarget(null);
      setIdDraft("");
      load();
    } catch (e) {
      push("error", String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function unblock(id: string, name: string | null) {
    setBusy(true);
    try {
      await api(`/api/blocked/${encodeURIComponent(id)}`, { method: "DELETE" });
      push("ok", `${name ?? id} の停止を解除した`);
      load();
    } catch (e) {
      push("error", String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function ask(id: string, name: string | null) {
    setReason("");
    setTarget({ id, name });
  }

  function askById(event: FormEvent) {
    event.preventDefault();
    const id = idDraft.trim();
    if (!SNOWFLAKE.test(id)) {
      setIdError("Discord の ID（数字 5〜25 桁）を入力してください。");
      return;
    }
    if (id === me.id) {
      setIdError("自分自身は止められません。");
      return;
    }
    if (blocked?.some((b) => b.discord_id === id)) {
      setIdError("この ID は、すでに利用を停止しています。");
      return;
    }
    // 一覧にいて、同格以上だと分かる相手だけをここで断る。一覧に無い ID は、API が判定する。
    const role = roleOf(id);
    if (role !== undefined && !assignable.includes(role)) {
      setIdError("自分と同格以上のロールの相手は止められません。");
      return;
    }
    setIdError(null);
    ask(id, nameOf(id));
  }

  return (
    <div className="page is-wide">
      <header className="page-head">
        <h1>ユーザー</h1>
        <p className="lead">
          ログインしたユーザーは既定で Free。Administrator は WEB_ADMIN_IDS
          のみ。自分より下のユーザーに、自分より下のロールだけ付けられます。
        </p>
      </header>

      {err && <Alert>{err}</Alert>}

      {!rows && !err && <Skeleton height={220} />}

      {rows && rows.length === 0 && <Empty title="ユーザーがまだいない" />}

      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="stack">
            <thead>
              <tr>
                <th>ユーザー</th>
                <th>ロール</th>
                <th>
                  <span className="sr">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const self = u.discord_id === me.id;
                const blockable = manageable(u.discord_id);
                return (
                  <tr key={u.discord_id}>
                    <td className="full" data-label="ユーザー">
                      <div className="cell-main">
                        <Avatar small round src={null} name={u.username} />
                        <div>
                          <div className="cell-title">
                            {u.username}
                            {self && (
                              <>
                                {" "}
                                <Badge tone="solid">自分</Badge>
                              </>
                            )}
                            {u.blocked && (
                              <>
                                {" "}
                                <Badge tone="danger">利用停止</Badge>
                              </>
                            )}
                          </div>
                          <div className="cell-sub mono">{u.discord_id}</div>
                        </div>
                      </div>
                    </td>
                    <td data-label="ロール">
                      <Badge>{u.role}</Badge>
                    </td>
                    <td className="full">
                      <div className="cell-actions">
                        {!self && assignable.length > 0 && (
                          <div style={{ width: 184, maxWidth: "100%" }}>
                            <Select
                              value=""
                              aria-label={`${u.username} のロールを変更`}
                              onValueChange={(e) => {
                                if (e) void setRole(u, e);
                              }}
                            >
                              <option value="">ロールを変更…</option>
                              {assignable.map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                            </Select>
                          </div>
                        )}
                        {blockable &&
                          (u.blocked ? (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={busy}
                              aria-label={`${u.username} の停止を解除`}
                              onClick={() => void unblock(u.discord_id, u.username)}
                            >
                              停止を解除
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              disabled={busy}
                              aria-label={`${u.username} の利用を停止`}
                              onClick={() => ask(u.discord_id, u.username)}
                            >
                              <Icon.ban size={14} />
                              利用を停止
                            </button>
                          ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canModerate && (
        <Section
          id="blocked"
          title="利用停止"
          desc="利用を停止したユーザーには bot が応答しません。止める・解除できるのは、自分より弱いロールの相手だけです（自分自身と、同格以上の相手にはできません）。上の一覧に無い人（ダッシュボードにログインしたことのない人）は、Discord の ID を指定して止められます。"
        >
          <form className="block-form" onSubmit={askById} noValidate>
            <label className="field is-id">
              <span className="field-name">Discord の ID</span>
              <input
                className="input mono"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={25}
                value={idDraft}
                aria-invalid={idError ? true : undefined}
                aria-describedby={idError ? "block-id-error" : undefined}
                onChange={(e) => {
                  setIdDraft(e.target.value);
                  setIdError(null);
                }}
              />
            </label>
            <button type="submit" className="btn btn-danger" disabled={busy || !idDraft.trim()}>
              <Icon.ban size={14} />
              この ID の利用を停止…
            </button>
          </form>
          {idError && (
            <p className="field-error" id="block-id-error" role="alert">
              <Icon.alert size={13} />
              <span>{idError}</span>
            </p>
          )}

          {blockedErr && <Alert>{blockedErr}</Alert>}
          {!blocked && !blockedErr && <Skeleton height={120} />}
          {blocked && blocked.length === 0 && (
            <p className="muted">利用停止中のユーザーはいません。</p>
          )}
          {blocked && blocked.length > 0 && (
            <div className="table-wrap">
              <table className="stack">
                <thead>
                  <tr>
                    <th>ユーザー</th>
                    <th>理由</th>
                    <th>停止した人</th>
                    <th>日時</th>
                    <th>
                      <span className="sr">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {blocked.map((b) => {
                    const name = b.username ?? nameOf(b.discord_id);
                    const by = nameOf(b.blocked_by);
                    return (
                      <tr key={b.discord_id}>
                        <td className="full" data-label="ユーザー">
                          <div className="cell-title">{name ?? "（名前は分かりません）"}</div>
                          <div className="cell-sub mono">{b.discord_id}</div>
                        </td>
                        <td className="full" data-label="理由">
                          {b.reason ?? "—"}
                        </td>
                        <td data-label="停止した人">
                          {by ?? <span className="mono">{b.blocked_by}</span>}
                        </td>
                        <td className="mono" data-label="日時">
                          {dateTime.format(b.blocked_at)}
                        </td>
                        <td className="full">
                          {manageable(b.discord_id) && (
                            <div className="cell-actions">
                              <button
                                type="button"
                                className="btn btn-sm"
                                disabled={busy}
                                aria-label={`${name ?? b.discord_id} の停止を解除`}
                                onClick={() => void unblock(b.discord_id, name)}
                              >
                                停止を解除
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      <Modal
        open={target !== null}
        onClose={() => !busy && setTarget(null)}
        title="利用を停止"
        size="narrow"
      >
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void block();
          }}
        >
          <p>
            {target?.name ? (
              <>
                <strong>{target.name}</strong>（<span className="mono">{target.id}</span>）
              </>
            ) : (
              <>
                ID <strong className="mono">{target?.id}</strong>
              </>
            )}{" "}
            の利用を停止します。
          </p>
          {target && !target.name && (
            <p className="muted">
              この ID は上の一覧に無いので、誰のものかをここでは確かめられません。ID が正しいことを確かめてください。
            </p>
          )}
          <p className="muted">止めると、この人には bot が応答しなくなります。解除はいつでもできます。</p>
          <label className="field">
            <span className="field-name">理由（任意）</span>
            <input
              className="input"
              maxLength={REASON_MAX}
              autoComplete="off"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="modal-foot">
            <button type="button" className="btn" disabled={busy} onClick={() => setTarget(null)}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              <Icon.ban size={14} />
              利用を停止
            </button>
          </div>
        </form>
      </Modal>

      <ToastArea toasts={toasts} />
    </div>
  );
}
