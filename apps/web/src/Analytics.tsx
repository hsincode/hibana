import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { billingBounds, billingMonth } from "@hibana/shared/billing";
import { api } from "./api";
import { BudgetFallbackPanel } from "./BudgetFallback";
import {
  Alert,
  Badge,
  Empty,
  Icon,
  Section,
  Skeleton,
  useDocumentTitle,
} from "./ui";

/* ============================================================
   利用料（Anthropic の cost report）
   金額・目安・超過の判定はすべて API（apps/api/src/analytics.ts）が計算する。
   ここは表示だけ。判定を二重に持つと、画面と API で食い違うため。
   「月」は、クレジットが付与される 5日から翌月 4日までの期間（#81）。
   始まる月の名前で呼ぶ。期間の計算は API と同じ packages/shared のものを使う。
   進行中の日（今日）は cost report に載らないので、usage report のトークン数から
   API が推計した額を別に出し、今月を見ている間は 1 分ごとに読み直す（#85）。
   利用状況（ターン数・利用ユーザー数・公開サイトの数）は Administrator にだけ、
   同じ月で出す（#110）。数えるのは API で、ここは表示だけ。
   ============================================================ */

type CostDay = { date: string; cost_usd: number | null; over: boolean };
type CostMonth = {
  configured: true;
  month: string;
  current: boolean;
  today: string;
  monthly_budget_usd: number;
  days_in_month: number;
  daily_guideline_usd: number;
  days: CostDay[];
  spent_usd: number;
  remaining_usd: number;
  pace_usd: number;
  days_left: number;
  fetched_at: number;
};
type CostResponse = CostMonth | { configured: false };
type CostToday = {
  configured: true;
  date: string;
  through: string;
  last_usage_at: string | null;
  cost_usd: number;
  daily_guideline_usd: number;
  over: boolean;
  unpriced: {
    model: string | null;
    service_tier: string | null;
    tokens: number;
  }[];
  fetched_at: number;
};
type TodayResponse = CostToday | { configured: false };
type UsageCounts = {
  turns: number;
  failed: number;
  users: number;
  users_excluding_admins: number;
};
/** GET /api/analytics/usage（#110）。人数と件数だけで、だれが使ったかは含まない。 */
type UsageMonth = {
  month: string;
  current: boolean;
  start: string;
  end: string;
  /** 記録を始めた日（全期間でいちばん古い日）。まだ無ければ null。 */
  first_day: string | null;
  retention_days: number;
  days: ({ date: string } & UsageCounts)[];
  totals: UsageCounts;
  models: { provider: string; model: string; turns: number }[];
  sites: { published: number; created: number };
  /** 残っている全期間の数（#116）。月の切り替えでは変わらない。旧 API は返さない。 */
  all_time?: UsageCounts;
};
/** 今日の推計。取得に失敗しても、月の表示は出す。 */
type TodayState = { data: CostToday | null; error: string | null };

// API は今日の分を 1 分キャッシュするので、それより短い間隔で読んでも同じ値になる。
const TODAY_REFRESH_MS = 60_000;

const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const usd = (n: number) => usdFormat.format(n);
/** 目安との差。表示が $0.00 に丸まる差には符号を付けない（「−$0.00」にしない）。 */
const signedUsd = (n: number) =>
  `${Math.abs(n) < 0.005 ? "±" : n < 0 ? "−" : "+"}${usd(Math.abs(n))}`;
const tickFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
// 日付は cost report と同じ UTC で読む。ブラウザの時間帯で解釈すると 1 日ずれる。
const dayFormat = new Intl.DateTimeFormat("ja-JP", {
  month: "numeric",
  day: "numeric",
  weekday: "short",
  timeZone: "UTC",
});
const day = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));
const shortDay = (date: string) =>
  `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  hour: "2-digit",
  minute: "2-digit",
});

function monthLabel(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return `${year}年${mon}月`;
}

function shiftMonth(month: string, by: number): string {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1 + by, 1)).toISOString().slice(0, 7);
}

const DAY_MS = 86_400_000;
const utcMonth = () => billingMonth(new Date().toISOString().slice(0, 10));
/** 期間の i 日目（0 始まり）の日付。 */
const dayOf = (month: string, i: number) =>
  new Date(Date.parse(`${billingBounds(month).start}T00:00:00Z`) + i * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** 期間の最初の日と最後の日。「10/5〜11/4」 */
function rangeLabel(month: string): string {
  const { start, end } = billingBounds(month);
  const last = new Date(Date.parse(`${end}T00:00:00Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
  return `${shortDay(start)}〜${shortDay(last)}`;
}

/** 目安との差を、色に頼らず文でも言う。 */
function Verdict({ over }: { over: boolean }) {
  return over ? (
    <Badge tone="danger">目安超過</Badge>
  ) : (
    <Badge tone="ok">目安以内</Badge>
  );
}

export function AnalyticsPage({
  canViewUsage = false,
}: {
  /** 利用状況の欄を出すか（`/api/me` の `can_view_usage`。旧 API は返さない）。 */
  canViewUsage?: boolean;
}) {
  // null = 今月。どの月が「今月」かは API が UTC で決める（5日より前は、前の月から続く期間）。
  const [month, setMonth] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [data, setData] = useState<CostResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useDocumentTitle("利用料");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<CostResponse>(`/api/analytics/cost${month ? `?month=${month}` : ""}`)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setErr(null);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month, reloads]);

  const loaded = data?.configured ? data : null;
  // 取得に失敗しても月を移れるよう、月の表示と移動は応答に頼らない。
  const shown = month ?? loaded?.month ?? utcMonth();
  const showingCurrent = shown === utcMonth();

  // 今日の推計。今月を見ている間だけ、画面が見えているときに 1 分ごとに読み直す。
  const [today, setToday] = useState<TodayState>({ data: null, error: null });
  const todayDate = useRef<string | null>(null);
  useEffect(() => {
    if (!showingCurrent) return;
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      api<TodayResponse>("/api/analytics/today")
        .then((r) => {
          if (cancelled) return;
          const fresh = r.configured ? r : null;
          // UTC の日付が変わったら、昨日の確定額が cost report に載るので、月も読み直す。
          if (
            fresh &&
            todayDate.current !== null &&
            todayDate.current !== fresh.date
          )
            setReloads((n) => n + 1);
          todayDate.current = fresh?.date ?? null;
          setToday({ data: fresh, error: null });
        })
        .catch((e) => {
          if (!cancelled)
            setToday((t) => ({ data: t.data, error: String(e.message ?? e) }));
        });
    };
    load();
    const timer = setInterval(load, TODAY_REFRESH_MS);
    // 別のタブから戻ったときは、次の 1 分を待たずに読む。
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [showingCurrent, reloads]);
  // 読み込み中は前の表示を薄くして残す（枠が跳ねない）。読み込みが終わったあとは、
  // 見出しの月と違う月の数字を出さない。
  const report = loaded && (loading || loaded.month === shown) ? loaded : null;

  return (
    <div className="page is-wide">
      <header className="page-head">
        <h1>利用料</h1>
        <p className="lead">
          Anthropic の cost report（請求ベース・組織全体）を表示します。日付は
          UTC 区切り（日本時間の 9:00 に切り替わり）で、cost report
          に載るのは終わった日までです。進行中の日のぶんは、usage report
          のトークン数から推計した額を「今日の推計」に出します（数分遅れ、1
          分ごとに更新）。確定額は、次の 9:00
          を過ぎてから一覧に載ります。月の集計は、クレジットが付与される毎月5日から翌月4日までです。
        </p>
      </header>

      <div className="month-bar">
        <div className="month-nav" role="group" aria-label="表示する月">
          <button
            type="button"
            className="icon-btn bordered"
            aria-label="前の月"
            onClick={() => setMonth(shiftMonth(shown, -1))}
          >
            <Icon.chevronLeft />
          </button>
          <strong aria-live="polite">
            {monthLabel(shown)}
            <small>{rangeLabel(shown)}</small>
          </strong>
          <button
            type="button"
            className="icon-btn bordered"
            aria-label="次の月"
            // 今月より先は API も受け付けない。
            disabled={shown >= utcMonth()}
            onClick={() => setMonth(shiftMonth(shown, 1))}
          >
            <Icon.chevronRight />
          </button>
        </div>
        <div className="month-meta">
          {report && !loading && (
            <span>{timeFormat.format(report.fetched_at)} に取得</span>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            // API は同じ月を 1 分間キャッシュするので、それより短い間隔では同じ値が返る。
            onClick={() => setReloads((n) => n + 1)}
          >
            <Icon.refresh size={14} />
            再読み込み
          </button>
        </div>
      </div>

      {err && <Alert>{err}</Alert>}
      {!data && !err && <Skeleton height={320} />}
      {data && !data.configured && (
        <Empty
          title="Admin API のキーが未設定"
          body="API サーバーの環境変数 ANTHROPIC_ADMIN_API_KEY に、Anthropic の cost report を読めるキー（Admin API キーなど）を設定すると、ここに日毎の利用料が表示されます。"
        />
      )}
      {report && (
        <Report
          m={report}
          stale={loading}
          today={report.current ? today : undefined}
        />
      )}
      {/* 判定は今月のものなので、過去の月を見ている間も同じ内容を出す。今日の推計が
          読み直されるたびに、この枠の状態も読み直す。 */}
      <BudgetFallbackPanel
        reloadKey={`${reloads}:${today.data?.fetched_at ?? ""}`}
      />
      {canViewUsage && <UsagePanel month={shown} reloadKey={reloads} />}
    </div>
  );
}

const countFormat = new Intl.NumberFormat("ja-JP");
const count = (n: number) => countFormat.format(n);

/** API が利用状況を数え始めた時刻（#112 の配信）。それより前の分は #116 で一度だけ足した。 */
const COUNT_STARTED = "2026-10-24 16:16";
/** #116 で足した分のうち、これより前は Discord の履歴から推定した数。 */
const ESTIMATED_BEFORE = "2026-10-11";

/** 利用状況（#110）。見出しの月と同じ期間を、API が数えたとおりに出す。 */
function UsagePanel({
  month,
  reloadKey,
}: {
  month: string;
  reloadKey: number;
}) {
  const [data, setData] = useState<UsageMonth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<UsageMonth>(`/api/analytics/usage?month=${month}`)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setErr(null);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [month, reloadKey]);
  // 料金の欄と同じく、読み込み中は前の表示を薄くして残し、終わったら違う月の数字を出さない。
  const shown = data && (loading || data.month === month) ? data : null;
  const t = shown?.totals;
  const all = shown?.all_time;
  return (
    <Section
      title="利用状況"
      desc={
        <>
          bot が応答したターン（失敗を含む）と、使った Discord
          ユーザーの人数、公開サイトの数です。Administrator
          だけに表示します。人数と件数だけを数え、だれが使ったかは出しません（ID
          は鍵つきのハッシュで保存し、
          {shown?.retention_days ?? 400} 日で消します）。日付は UTC
          で、月は利用料と同じ期間です。
        </>
      }
    >
      {err && <Alert>{err}</Alert>}
      {!shown && !err && <Skeleton height={160} />}
      {shown && t && (
        <div
          className={`analytics-report${loading ? " is-stale" : ""}`}
          aria-busy={loading}
        >
          <p className="note">
            {shown.first_day
              ? `${shown.first_day} から記録しています。それより前の利用は数えていません。`
              : "まだ記録がありません。"}
            {shown.first_day &&
              shown.first_day < COUNT_STARTED.slice(0, 10) &&
              `${COUNT_STARTED}（UTC）より前は、残っていたログと Discord の履歴から足した数です。${ESTIMATED_BEFORE} より前は推定で、モデルは「不明」、失敗は 0 としています。`}
          </p>
          <div
            className="stats"
            role="group"
            aria-label="この月"
            style={{ "--cols": 3 } as CSSProperties}
          >
            <Stat label="利用ユーザー数" value={`${count(t.users)} 人`}>
              <p className="stat-note">
                Administrator を除くと {count(t.users_excluding_admins)} 人
              </p>
            </Stat>
            <Stat label="ターン数" value={count(t.turns)}>
              <p className="stat-note">うち失敗 {count(t.failed)}</p>
            </Stat>
            <Stat label="公開サイト" value={count(shown.sites.published)}>
              <p className="stat-note">
                今公開中のサイト。この月に作られたサイト{" "}
                {count(shown.sites.created)}
              </p>
            </Stat>
          </div>
          {shown.days.length > 0 && (
            <div className="table-wrap">
              <table
                className="cost-table usage-days"
                aria-label="日ごとの利用状況"
              >
                <thead>
                  <tr>
                    <th>日付（UTC）</th>
                    <th className="num">ターン</th>
                    <th className="num">失敗</th>
                    <th className="num">利用ユーザー</th>
                    <th className="num">Administrator を除く</th>
                  </tr>
                </thead>
                <tbody>
                  {[...shown.days].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{day(d.date)}</td>
                      <td className="num">{count(d.turns)}</td>
                      <td className="num">{count(d.failed)}</td>
                      <td className="num">{count(d.users)}</td>
                      <td className="num">{count(d.users_excluding_admins)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {shown.models.length > 0 && (
            <div className="table-wrap">
              <table
                className="cost-table usage-models"
                aria-label="モデル別のターン数"
              >
                <thead>
                  <tr>
                    <th>プロバイダー</th>
                    <th>モデル</th>
                    <th className="num">ターン</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.models.map((m) => (
                    <tr key={`${m.provider}/${m.model}`}>
                      <td>{m.provider || "不明"}</td>
                      <td>{m.model || "不明"}</td>
                      <td className="num">{count(m.turns)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {all && shown.first_day && (
            <div className="usage-all-time" role="group" aria-label="累計">
              <p className="note">
                累計（{shown.first_day}{" "}
                から今まで。月を切り替えても変わりません）
              </p>
              <div className="stats" style={{ "--cols": 2 } as CSSProperties}>
                <Stat label="利用ユーザー数" value={`${count(all.users)} 人`}>
                  <p className="stat-note">
                    Administrator を除くと {count(all.users_excluding_admins)}{" "}
                    人
                  </p>
                </Stat>
                <Stat label="ターン数" value={count(all.turns)}>
                  <p className="stat-note">うち失敗 {count(all.failed)}</p>
                </Stat>
              </div>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function Report({
  m,
  stale,
  today,
}: {
  m: CostMonth;
  stale: boolean;
  today?: TodayState;
}) {
  const guideline = m.daily_guideline_usd;
  // cost report に載るのは終わった日までなので、進行中の月でも「今日」の行はない。
  // 今月は、いちばん新しい確定日を取り上げる。
  const latest = m.current ? m.days.at(-1) : undefined;
  const until = m.days.at(-1);
  const overDays = m.days.filter((d) => d.over).length;
  const overBudget = m.remaining_usd < 0;
  const paceDiff = m.spent_usd - m.pace_usd;
  const used = Math.min(Math.max(m.spent_usd / m.monthly_budget_usd, 0), 1);
  // 今日の推計の枠は、今月で、推計か取得の失敗のどちらかがあるときに出す。
  const showToday = Boolean(today && (today.data || today.error));
  const estimate = today?.data ?? null;
  const columns = 3 + (latest ? 1 : 0) + (showToday ? 1 : 0);

  // 新しい日を上に。累計はその日までの合計なので、古い順に足してから並べ替える。
  let running = 0;
  const rows = m.days
    .map((d) => {
      running += d.cost_usd ?? 0;
      return { ...d, running };
    })
    .reverse();

  return (
    <div
      className={`analytics-report${stale ? " is-stale" : ""}`}
      aria-busy={stale}
    >
      <div className="stats" style={{ "--cols": columns } as CSSProperties}>
        <Stat
          label={m.current ? "今月の残り" : "予算の残り"}
          value={
            overBudget ? `−${usd(-m.remaining_usd)}` : usd(m.remaining_usd)
          }
          negative={overBudget}
          badge={overBudget ? <Badge tone="danger">予算超過</Badge> : undefined}
        >
          <div
            className={`meter${overBudget ? " is-over" : ""}`}
            role="meter"
            aria-label="予算のうち使った割合"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(used * 100)}
          >
            <span className="meter-fill" style={{ width: `${used * 100}%` }} />
            {[0, 25, 50, 75, 100].map((t) => (
              <i
                key={t}
                style={{ left: t === 100 ? "calc(100% - 1px)" : `${t}%` }}
              />
            ))}
          </div>
          <p className="stat-note">
            月の予算 {usd(m.monthly_budget_usd)} のうち {usd(m.spent_usd)}{" "}
            を使用
            {m.current && until && `（${shortDay(until.date)} までの確定分）`}
            {m.current && `。残り ${m.days_left} 日（今日を含む）`}
          </p>
          {estimate && (
            <p className="stat-note">
              今日の推計を含めると残り{" "}
              {signedRemaining(m.remaining_usd - estimate.cost_usd)}
            </p>
          )}
        </Stat>

        <Stat
          label={m.current ? "今月の累計" : "この月の合計"}
          value={usd(m.spent_usd)}
          badge={
            m.days.length > 0 ? <Verdict over={paceDiff > 0} /> : undefined
          }
        >
          <p className="stat-note">
            {m.days.length > 0
              ? `${m.days.length} 日ぶんの目安 ${usd(m.pace_usd)} より ${usd(Math.abs(paceDiff))} ${paceDiff > 0 ? "多い" : "少ない"}`
              : "確定した日がまだありません"}
          </p>
        </Stat>

        {showToday && (
          <Stat
            label="今日の推計"
            value={estimate ? usd(estimate.cost_usd) : "—"}
            badge={estimate ? <Verdict over={estimate.over} /> : undefined}
          >
            {estimate && <TodayNote t={estimate} />}
            {today?.error && (
              <p className="stat-note is-error">{today.error}</p>
            )}
          </Stat>
        )}

        {latest && (
          <Stat
            label={`直近の確定日（UTC ${shortDay(latest.date)}）`}
            value={latest.cost_usd === null ? "未集計" : usd(latest.cost_usd)}
            badge={
              latest.cost_usd === null ? undefined : (
                <Verdict over={latest.over} />
              )
            }
          >
            <p className="stat-note">
              {latest.cost_usd === null
                ? "cost report にまだこの日の行がありません"
                : latest.over
                  ? `目安より ${usd(latest.cost_usd - guideline)} 多い`
                  : `目安より ${usd(guideline - latest.cost_usd)} 少ない`}
            </p>
          </Stat>
        )}

        <Stat label="1日の目安" value={usd(guideline)}>
          <p className="stat-note">
            {usd(m.monthly_budget_usd)} ÷ {m.days_in_month} 日。超えた日は{" "}
            {overDays} 日（
            {m.days.length} 日中）
          </p>
        </Stat>
      </div>

      {m.days.length === 0 ? (
        <p className="note">
          この月で終わった日はまだありません。1 日のぶんは、UTC
          の日付が変わったあと（日本時間の 9:00 以降）に表示されます。
        </p>
      ) : (
        <>
          <section className="chart-panel frame" aria-labelledby="cost-chart-h">
            <div className="chart-head">
              <div>
                <h2 id="cost-chart-h">日毎の利用料</h2>
                <p>
                  棒が点線（1日の目安 {usd(guideline)}
                  ）を超えた日が目安超過です。
                </p>
              </div>
              <ul className="legend">
                <li>
                  <i className="k-in" />
                  目安以内
                </li>
                <li>
                  <i className="k-sel" />
                  選んだ日
                </li>
                <li>
                  <i className="k-over" />
                  目安超過
                </li>
                <li>
                  <i className="k-guide" />
                  1日の目安
                </li>
              </ul>
            </div>
            {/* 月を移ったら、棒が伸びる動きをもう一度見せる。 */}
            <CostChart key={m.month} m={m} />
          </section>

          <Section title="日別の一覧">
            <div className="table-wrap">
              <table className="cost-table">
                <thead>
                  <tr>
                    {/* 狭い画面では横にスクロールする。日付・利用額・判定が先に見える順にしてある。 */}
                    <th>日付（UTC）</th>
                    <th className="num">利用額</th>
                    <th>判定</th>
                    <th className="num">目安との差</th>
                    <th className="num">累計</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.date}>
                      <td>{day(d.date)}</td>
                      <td className="num">
                        {d.cost_usd === null ? "—" : usd(d.cost_usd)}
                      </td>
                      <td>
                        {d.cost_usd === null ? (
                          <Badge>未集計</Badge>
                        ) : (
                          <Verdict over={d.over} />
                        )}
                      </td>
                      <td className="num">
                        {d.cost_usd === null
                          ? "—"
                          : signedUsd(d.cost_usd - guideline)}
                      </td>
                      <td className="num">{usd(d.running)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

/** 残りの額。予算を超えたら「−」を付ける。 */
const signedRemaining = (n: number) => (n < 0 ? `−${usd(-n)}` : usd(n));
const tokenFormat = new Intl.NumberFormat("ja-JP");

/** 推計が何を数えて、何を数えていないか。 */
function TodayNote({ t }: { t: CostToday }) {
  const left = t.unpriced.reduce((sum, u) => sum + u.tokens, 0);
  const models = [...new Set(t.unpriced.map((u) => u.model ?? "不明なモデル"))];
  return (
    <>
      {/* 時刻は「取得」の時刻と同じく、ブラウザの時間帯で出す。日の始まりだけ UTC と書く。 */}
      <p className="stat-note">
        {timeFormat.format(Date.parse(t.through))}{" "}
        までの利用から単価表で計算した推計（UTC の {shortDay(t.date)} 0:00 から
        {t.last_usage_at &&
          `。最後の利用 ${timeFormat.format(Date.parse(t.last_usage_at))}`}
        ）。反映は数分遅れます。
      </p>
      {left > 0 && (
        <p className="stat-note">
          単価の分からない利用（{models.slice(0, 2).join("、")}
          {models.length > 2 && ` ほか ${models.length - 2} 件`}、
          {tokenFormat.format(left)} トークン）は含みません。
        </p>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  negative,
  badge,
  children,
}: {
  label: string;
  value: string;
  negative?: boolean;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <div className="stat-line">
        <span className={`stat-value${negative ? " is-neg" : ""}`}>
          {value}
        </span>
        {badge}
      </div>
      {children}
    </div>
  );
}

/* ---------- chart ---------- */
const PLOT_H = 220;
const PAD_TOP = 12;
const AXIS_H = 26;
const LEFT = 44;
// 右の余白に「目安」のラベルを置く。棒の上に重ねると月末の棒と当たる。
const RIGHT = 44;

/** 目盛りが 5 本前後に収まる、切りのいい刻み（1・2・2.5・5 × 10^n）。 */
function axis(max: number) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((k) => k * pow).find((s) => s >= raw) ?? 10 * pow;
  const count = Math.ceil(max / step);
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

function CostChart({ m }: { m: CostMonth }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  // 文字と棒の太さを画面の実寸で決めたいので、viewBox で拡縮せず幅を測って描く。
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const guideline = m.daily_guideline_usd;
  const peak = Math.max(...m.days.map((d) => d.cost_usd ?? 0), 0);
  // 目安の線が上端に張り付かないよう、少なくとも目安の 1.25 倍までは軸を取る。
  const ticks = axis(Math.max(peak, guideline * 1.25));
  const top = ticks[ticks.length - 1];
  const plotW = Math.max(width - LEFT - RIGHT, 0);
  const band = plotW / m.days_in_month;
  const barW = Math.max(Math.min(24, band - 2), 1);
  const base = PAD_TOP + PLOT_H;
  const y = (v: number) => base - (v / top) * PLOT_H;
  const center = (i: number) => LEFT + band * (i + 0.5);

  function pick(clientX: number) {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || band <= 0) return;
    const i = Math.floor((clientX - rect.left - LEFT) / band);
    setActive(i >= 0 && i < m.days.length ? i : null);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const last = m.days.length - 1;
    const next =
      event.key === "ArrowLeft"
        ? Math.max((active ?? last + 1) - 1, 0)
        : event.key === "ArrowRight"
          ? Math.min((active ?? -1) + 1, last)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  const shownDay = active === null ? undefined : m.days[active];
  // 塗りの定義は、同じページに別のグラフが増えても混ざらないよう、グラフごとに名前を分ける。
  // useId は記号を含むので、url(#…) にそのまま書ける英数字だけにする。
  const defs = `cost${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <>
      {/* 読み取り欄: 選んだ日の値はグラフの外に出し、棒や凡例に重ねない。どの日かは列の網掛けで示す。 */}
      <div className="chart-readout">
        {shownDay && active !== null ? (
          <div
            className="chart-tip"
            role="status"
            style={{
              // 端の日でも枠からはみ出さないよう、中心を内側に寄せる。
              left: Math.min(
                Math.max(center(active), 84),
                Math.max(width - 84, 84),
              ),
            }}
          >
            <span>{day(shownDay.date)}</span>
            <strong>
              {shownDay.cost_usd === null ? "未集計" : usd(shownDay.cost_usd)}
            </strong>
            {shownDay.cost_usd !== null && (
              <span className={shownDay.over ? "is-over" : undefined}>
                {shownDay.over ? "目安超過 " : "目安以内 "}
                {signedUsd(shownDay.cost_usd - guideline)}
              </span>
            )}
          </div>
        ) : (
          <span className="chart-hint">
            棒に触れるか、グラフを選んで ← → で日を選べます。
          </span>
        )}
      </div>
      <div
        ref={wrap}
        className="chart"
        style={{ height: PAD_TOP + PLOT_H + AXIS_H }}
        // 数値は下の表にすべてある。グラフはキーボードでも日を選べるようにしておく。
        tabIndex={0}
        role="group"
        aria-label="日毎の利用料のグラフ。左右の矢印キーで日を選べます。数値は下の一覧にもあります"
        onKeyDown={onKeyDown}
        onFocus={() => setActive((i) => i ?? m.days.length - 1)}
        onBlur={() => setActive(null)}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={() => setActive(null)}
      >
        {width > 0 && (
          <svg
            width={width}
            height={PAD_TOP + PLOT_H + AXIS_H}
            aria-hidden="true"
          >
            <defs>
              {/* 超過は色だけでなく斜線でも示す。 */}
              <pattern
                id={`${defs}-over`}
                patternUnits="userSpaceOnUse"
                width="5"
                height="5"
                patternTransform="rotate(45)"
              >
                <rect width="5" height="5" style={{ fill: "var(--danger)" }} />
                <rect
                  width="2"
                  height="5"
                  style={{ fill: "var(--danger-deep)" }}
                />
              </pattern>
            </defs>
            {active !== null && (
              <rect
                className="chart-active"
                x={LEFT + band * active}
                y={PAD_TOP}
                width={band}
                height={PLOT_H}
              />
            )}
            {ticks.map((t) => (
              <g key={t}>
                <line
                  className="chart-grid"
                  x1={LEFT}
                  x2={LEFT + plotW}
                  y1={y(t)}
                  y2={y(t)}
                />
                <text
                  className="chart-tick"
                  x={LEFT - 8}
                  y={y(t)}
                  dy="0.32em"
                  textAnchor="end"
                >
                  {tickFormat.format(t)}
                </text>
              </g>
            ))}
            {m.days.map((d, i) => {
              if (!d.cost_usd || d.cost_usd <= 0) return null;
              // 0 でない日は、額が小さくても棒が見えるようにする。
              const h = Math.max(base - y(d.cost_usd), 2);
              const r = Math.min(4, barW / 2, h);
              const x = center(i) - barW / 2;
              const t = base - h;
              return (
                <path
                  key={d.date}
                  // 超過は赤と斜線のまま。それ以外は線の色で、選んだ日だけ琥珀（#142）。
                  className={`chart-bar${d.over ? " is-over" : i === active ? " is-sel" : ""}`}
                  // 棒は左の日から順に伸びる。
                  style={
                    {
                      "--i": i,
                      ...(d.over && {
                        fill: `url(#${defs}-over) var(--danger)`,
                      }),
                    } as CSSProperties
                  }
                  // 上だけ丸め、基線側は角のまま。
                  d={`M${x},${base}V${t + r}Q${x},${t} ${x + r},${t}H${x + barW - r}Q${x + barW},${t} ${x + barW},${t + r}V${base}Z`}
                />
              );
            })}
            <line
              className="chart-guide"
              x1={LEFT}
              x2={LEFT + plotW}
              y1={y(guideline)}
              y2={y(guideline)}
            />
            <text
              className="chart-guide-label"
              x={LEFT + plotW + 8}
              y={y(guideline)}
              dy="0.32em"
            >
              目安
            </text>
            {/* 横軸は 5日から翌月 4日まで。期間の初日と月が変わる 1日には月も書く。
                30日は、隣の 1日のラベルと当たるので書かない。 */}
            {Array.from({ length: m.days_in_month }, (_, i) => ({
              i,
              date: dayOf(m.month, i),
            }))
              .map(({ i, date }) => ({ i, date, n: Number(date.slice(8, 10)) }))
              .filter(
                ({ i, n }) => i === 0 || n === 1 || (n % 5 === 0 && n <= 25),
              )
              .map(({ i, date, n }) => (
                <text
                  key={date}
                  className="chart-tick"
                  x={center(i)}
                  y={base + 17}
                  textAnchor="middle"
                >
                  {i === 0 || n === 1 ? shortDay(date) : n}
                </text>
              ))}
          </svg>
        )}
      </div>
    </>
  );
}
