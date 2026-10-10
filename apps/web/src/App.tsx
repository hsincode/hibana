import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { AnalyticsPage } from "./Analytics";
import { apiCached, type GuildSummary, type Me } from "./api";
import { ArtifactsPage } from "./Artifacts";
import { GuildPage } from "./Guild";
import { Login } from "./Login";
import { LogsPage } from "./Logs";
import { MePage } from "./Me";
import { ModelsPage } from "./Models";
import { guildPath } from "./nav";
import { GuildList } from "./Servers";
import { Shell, useCurrentGuild } from "./Shell";
import { Alert, Empty, Loading, Skeleton } from "./ui";
import { UsersPage } from "./Users";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    apiCached<Me>("/api/me")
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  // セッション判定が終わるまでは Login にも一覧にも飛ばさない（ちらつき防止）
  if (me === undefined) {
    return (
      <div className="center-full">
        <Loading />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={me ? <Navigate to="/" replace /> : <Login />}
      />
      <Route
        path="/*"
        element={
          me ? (
            <Shell me={me} onLogout={() => setMe(null)}>
              <Routes>
                <Route path="/" element={<GuildList />} />
                <Route path="/me" element={<MePage />} />
                <Route path="/artifacts" element={<ArtifactsPage />} />
                <Route path="/skills" element={<SkillsRedirect />} />
                <Route path="/g/:id/*" element={<GuildPage />} />
                <Route
                  path="/users"
                  element={
                    me.can_manage_users ? (
                      <UsersPage me={me} />
                    ) : (
                      <Navigate to="/" />
                    )
                  }
                />
                <Route
                  path="/models"
                  element={
                    me.can_manage_users ? <ModelsPage /> : <Navigate to="/" />
                  }
                />
                <Route
                  path="/analytics"
                  element={
                    me.can_view_analytics ? <AnalyticsPage /> : <Navigate to="/" />
                  }
                />
                <Route
                  path="/logs"
                  element={me.can_moderate ? <LogsPage /> : <Navigate to="/" />}
                />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Shell>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="page">
      <Empty
        heading
        title="ページが見つからない"
        body="URL を確認してね。"
        action={
          <Link className="btn" to="/">
            サーバー一覧へ
          </Link>
        }
      />
    </div>
  );
}

/**
 * 以前の `/skills`（サーバーを選ぶ欄つきのページ）。スキルはサーバーごとのページに
 * なったので、最後に見ていたサーバー（無ければ先頭）のスキルへ送る。
 */
function SkillsRedirect() {
  const [guilds, setGuilds] = useState<GuildSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiCached<{ guilds: GuildSummary[] }>("/api/guilds")
      .then((r) => setGuilds(r.guilds))
      .catch((e) => setErr(String(e.message ?? e)));
  }, []);
  const current = useCurrentGuild(guilds ?? []);

  if (current.id) return <Navigate to={guildPath(current.id, "skills")} replace />;
  return (
    <div className="page">
      {err ? (
        <Alert>{err}</Alert>
      ) : guilds ? (
        <Empty
          heading
          title="まだサーバーがない"
          body="ボットをサーバーに招待すると、そのサーバーのスキルを管理できます。"
        />
      ) : (
        <Skeleton height={160} />
      )}
    </div>
  );
}
