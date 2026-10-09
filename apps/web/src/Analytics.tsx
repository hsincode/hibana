import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { api } from "./api";
import { Alert, Badge, Empty, Skeleton, useDocumentTitle } from "./ui";
import "./analytics.css";

/* ============================================================
   利用料（Anthropic の cost report）
   金額・目安・超過の判定はすべて API（apps/api/src/analytics.ts）が計算する。
   ここは表示だけ。判定を二重に持つと、画面と API で食い違うため。
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

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
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
const shortDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const timeFormat = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });

function monthLabel(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return `${year}年${mon}月`;
}

function shiftMonth(month: string, by: number): string {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1 + by, 1)).toISOString().slice(0, 7);
}

const utcMonth = () => new Date().toISOString().slice(0, 7);

/** 目安との差を、色に頼らず文でも言う。 */
function Verdict({ over }: { over: boolean }) {
  return over ? <Badge tone="danger">目安超過</Badge> : <Badge tone="ok">目安以内</Badge>;
}

export function AnalyticsPage() {
  // null = 今月。どの月が「今月」かは API が UTC で決める。
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
  // 読み込み中は前の表示を薄くして残す（枠が跳ねない）。読み込みが終わったあとは、
  // 見出しの月と違う月の数字を出さない。
  const report = loaded && (loading || loaded.month === shown) ? loaded : null;

  return (
    <div className="page analytics">
      <div className="page-head">
        <div>
          <h1>利用料</h1>
          <p className="lead">
            Anthropic の cost report（請求ベース・組織全体）を表示します。日付は UTC
            区切りで、日本時間の 9:00 に切り替わります。反映には数分かかります。
          </p>
        </div>
      </div>

      <div className="analytics-bar">
        <div className="month-nav" role="group" aria-label="表示する月">
          <button
            className="btn btn-ghost icon-button"
            aria-label="前の月"
            onClick={() => setMonth(shiftMonth(shown, -1))}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <strong aria-live="polite">{monthLabel(shown)}</strong>
          <button
            className="btn btn-ghost icon-button"
            aria-label="次の月"
            // 今月より先は API も受け付けない。
            disabled={shown >= utcMonth()}
            onClick={() => setMonth(shiftMonth(shown, 1))}
          >
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
        {report && !loading && (
          <span className="analytics-fetched">{timeFormat.format(report.fetched_at)} に取得</span>
        )}
        <button
          className="btn"
          disabled={loading}
          // API は同じ月を 1 分間キャッシュするので、それより短い間隔では同じ値が返る。
          onClick={() => setReloads((n) => n + 1)}
        >
          <RefreshCw size={15} aria-hidden="true" />
          再読み込み
        </button>
      </div>

      {err && <Alert>{err}</Alert>}
      {!data && !err && <Skeleton height={320} />}
      {data && !data.configured && (
        <Empty
          title="Admin API キーが未設定"
          body="API サーバーの環境変数 ANTHROPIC_ADMIN_KEY に Anthropic の Admin API キーを設定すると、ここに日毎の利用料が表示されます。"
        />
      )}
      {report && <Report m={report} stale={loading} />}
    </div>
  );
}

function Report({ m, stale }: { m: CostMonth; stale: boolean }) {
  const guideline = m.daily_guideline_usd;
  const today = m.current ? m.days.at(-1) : undefined;
  const overDays = m.days.filter((d) => d.over).length;
  const overBudget = m.remaining_usd < 0;
  const paceDiff = m.spent_usd - m.pace_usd;
  const used = Math.min(Math.max(m.spent_usd / m.monthly_budget_usd, 0), 1);

  // 新しい日を上に。累計はその日までの合計なので、古い順に足してから並べ替える。
  let running = 0;
  const rows = m.days
    .map((d) => {
      running += d.cost_usd ?? 0;
      return { ...d, running };
    })
    .reverse();

  return (
    <div className={`analytics-report${stale ? " is-stale" : ""}`} aria-busy={stale}>
      <div className="stat-row">
        <Stat
          label={m.current ? "今月の残り" : "予算の残り"}
          value={overBudget ? `−${usd(-m.remaining_usd)}` : usd(m.remaining_usd)}
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
            <span style={{ width: `${used * 100}%` }} />
          </div>
          <p className="stat-note">
            月の予算 {usd(m.monthly_budget_usd)} のうち {usd(m.spent_usd)} を使用
            {m.current && `。残り ${m.days_left} 日（今日を含む）`}
          </p>
        </Stat>

        <Stat
          label={m.current ? "今月の累計" : "この月の合計"}
          value={usd(m.spent_usd)}
          badge={<Verdict over={paceDiff > 0} />}
        >
          <p className="stat-note">
            {m.days.length} 日ぶんの目安 {usd(m.pace_usd)} より {usd(Math.abs(paceDiff))}{" "}
            {paceDiff > 0 ? "多い" : "少ない"}
          </p>
        </Stat>

        {today && (
          <Stat
            label={`今日（UTC ${shortDay(today.date)}）`}
            value={today.cost_usd === null ? "未集計" : usd(today.cost_usd)}
            badge={today.cost_usd === null ? undefined : <Verdict over={today.over} />}
          >
            <p className="stat-note">
              {today.cost_usd === null
                ? "cost report にまだ今日の行がありません"
                : today.over
                  ? `目安より ${usd(today.cost_usd - guideline)} 多い`
                  : `目安まであと ${usd(guideline - today.cost_usd)}`}
            </p>
          </Stat>
        )}

        <Stat label="1日の目安" value={usd(guideline)}>
          <p className="stat-note">
            {usd(m.monthly_budget_usd)} ÷ {m.days_in_month} 日。超えた日は {overDays} 日（
            {m.days.length} 日中）
          </p>
        </Stat>
      </div>

      <section className="panel" aria-labelledby="cost-chart-h">
        <div className="panel-head">
          <h2 id="cost-chart-h">日毎の利用料</h2>
          <p className="desc">
            棒が点線（1日の目安 {usd(guideline)}）を超えた日が目安超過です。
          </p>
        </div>
        <div className="panel-body">
          <ul className="chart-legend">
            <li>
              <span className="key key-within" />
              目安以内
            </li>
            <li>
              <span className="key key-over" />
              目安超過
            </li>
            <li>
              <span className="key key-line" />
              1日の目安
            </li>
            {m.current && (
              <li>
                <span className="key key-today" />
                今日（集計中）
              </li>
            )}
          </ul>
          <CostChart m={m} />
        </div>
      </section>

      <section className="panel" aria-labelledby="cost-table-h">
        <div className="panel-head">
          <h2 id="cost-table-h">日別の一覧</h2>
        </div>
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
                  <td>
                    {day(d.date)}
                    {d.date === today?.date && <Badge tone="muted">集計中</Badge>}
                  </td>
                  <td className="num">{d.cost_usd === null ? "—" : usd(d.cost_usd)}</td>
                  <td>
                    {d.cost_usd === null ? (
                      <Badge tone="muted">未集計</Badge>
                    ) : (
                      <Verdict over={d.over} />
                    )}
                  </td>
                  <td className="num">
                    {d.cost_usd === null ? "—" : signedUsd(d.cost_usd - guideline)}
                  </td>
                  <td className="num">{usd(d.running)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  badge,
  children,
}: {
  label: string;
  value: string;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <div className="stat-value">
        <strong>{value}</strong>
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
  const step = [1, 2, 2.5, 5, 10].map((k) => k * pow).find((s) => s >= raw) ?? 10 * pow;
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
  const todayIndex = m.current ? m.days.length - 1 : -1;

  function pick(clientX: number) {
    const rect = wrap.current?.getBoundingClientRect();
    if (!rect || band <= 0) return;
    const i = Math.floor((clientX - rect.left - LEFT) / band);
    setActive(i >= 0 && i < m.days.length ? i : null);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const last = m.days.length - 1;
    const next =
      event.key === "ArrowLeft" ? Math.max((active ?? last + 1) - 1, 0)
      : event.key === "ArrowRight" ? Math.min((active ?? -1) + 1, last)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  }

  const shownDay = active === null ? undefined : m.days[active];

  return (
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
        <svg width={width} height={PAD_TOP + PLOT_H + AXIS_H} aria-hidden="true">
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
              <line className="chart-grid" x1={LEFT} x2={LEFT + plotW} y1={y(t)} y2={y(t)} />
              <text className="chart-tick" x={LEFT - 8} y={y(t)} dy="0.32em" textAnchor="end">
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
                className={`chart-bar${d.over ? " is-over" : ""}`}
                // 上だけ丸め、基線側は角のまま。
                d={`M${x},${base}V${t + r}Q${x},${t} ${x + r},${t}H${x + barW - r}Q${x + barW},${t} ${x + barW},${t + r}V${base}Z`}
              />
            );
          })}
          <line className="chart-guide" x1={LEFT} x2={LEFT + plotW} y1={y(guideline)} y2={y(guideline)} />
          <text className="chart-guide-label" x={LEFT + plotW + 8} y={y(guideline)} dy="0.32em">
            目安
          </text>
          {Array.from({ length: m.days_in_month }, (_, i) => i + 1)
            .filter((n) => n === 1 || n % 5 === 0)
            .map((n) => (
              <text key={n} className="chart-tick" x={center(n - 1)} y={base + 17} textAnchor="middle">
                {n}
              </text>
            ))}
          {todayIndex >= 0 && <circle className="chart-today" cx={center(todayIndex)} cy={base + 5} r={2.5} />}
        </svg>
      )}
      {shownDay && active !== null && (
        <div
          className="chart-tip"
          role="status"
          style={{
            // 端の日でも枠からはみ出さないよう、中心を内側に寄せる。
            left: Math.min(Math.max(center(active), 84), Math.max(width - 84, 84)),
            // 棒や目安の線を隠さないよう、プロットの上に出す。どの日かは列の網掛けで示す。
            bottom: AXIS_H + PLOT_H + 4,
          }}
        >
          <span>
            {day(shownDay.date)}
            {active === todayIndex && "・集計中"}
          </span>
          <strong>{shownDay.cost_usd === null ? "未集計" : usd(shownDay.cost_usd)}</strong>
          {shownDay.cost_usd !== null && (
            <span>
              {shownDay.over ? "目安超過 " : "目安以内 "}
              {signedUsd(shownDay.cost_usd - guideline)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
