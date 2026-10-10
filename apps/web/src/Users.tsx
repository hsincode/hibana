import { useEffect, useState } from "react";
import { api, type Me } from "./api";
import { Select } from "./controls";
import {
  Alert,
  Avatar,
  Badge,
  Empty,
  Skeleton,
  ToastArea,
  useDocumentTitle,
  useToasts,
} from "./ui";

/* ============================================================
   ユーザー管理
   ============================================================ */
type UserRow = { discord_id: string; username: string; role: string };

export function UsersPage({ me }: { me: Me }) {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [assignable, setAssignable] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const { toasts, push } = useToasts();
  useDocumentTitle("ユーザー");

  const load = () => {
    api<{ users: UserRow[]; assignable: string[] }>("/api/users")
      .then((r) => {
        setRows(r.users);
        setAssignable(r.assignable);
      })
      .catch((e) => setErr(String(e.message ?? e)));
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
              {rows.map((u) => (
                <tr key={u.discord_id}>
                  <td className="full" data-label="ユーザー">
                    <div className="cell-main">
                      <Avatar small round src={null} name={u.username} />
                      <div>
                        <div className="cell-title">
                          {u.username}
                          {u.discord_id === me.id && (
                            <>
                              {" "}
                              <Badge tone="solid">自分</Badge>
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
                  <td className="full" style={{ width: 184 }}>
                    {u.discord_id !== me.id && assignable.length > 0 && (
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
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ToastArea toasts={toasts} />
    </div>
  );
}
