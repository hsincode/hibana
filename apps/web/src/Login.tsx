import { apiUrl } from "./api";
import { ThemeMenu } from "./controls";
import { Icon, LOGO_PATH, useDocumentTitle } from "./ui";

export function Login() {
  useDocumentTitle("ログイン");
  return (
    <div className="login">
      <div className="login-theme">
        <ThemeMenu bordered />
      </div>
      <main className="login-card frame">
        <span className="brand-mark lg">
          <Icon.logo size={26} />
        </span>
        <div>
          <h1>Hibana</h1>
          <p className="sub">Discord ワークスペース</p>
        </div>
        <a className="btn btn-primary" href={apiUrl("/auth/discord")}>
          <Icon.discord />
          Discord でログイン
        </a>
        <p className="login-foot">Discord アカウントで安全にログイン</p>
      </main>
      {/* 図版: ロゴの星を箔の線で描き、周りに軌道を置く。飾りなので読み上げない。 */}
      <div className="login-plate" aria-hidden="true">
        <svg viewBox="0 0 100 100">
          <defs>
            <linearGradient id="plate-star" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0" style={{ stopColor: "var(--f1)" }} />
              <stop offset="0.4" style={{ stopColor: "var(--f2)" }} />
              <stop offset="0.75" style={{ stopColor: "var(--f3)" }} />
              <stop offset="1" style={{ stopColor: "var(--f4)" }} />
            </linearGradient>
            <radialGradient id="plate-aura">
              <stop offset="0" style={{ stopColor: "var(--f2)", stopOpacity: 0.3 }} />
              <stop offset="0.55" style={{ stopColor: "var(--f1)", stopOpacity: 0.12 }} />
              <stop offset="1" style={{ stopColor: "var(--f1)", stopOpacity: 0 }} />
            </radialGradient>
            <filter id="plate-blur" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="1.1" />
            </filter>
          </defs>
          <circle cx="50" cy="50" r="48" fill="url(#plate-aura)" />
          <g className="orbits">
            <ellipse className="orbit a" cx="50" cy="50" rx="45" ry="15" transform="rotate(-28 50 50)" />
            <ellipse className="orbit b" cx="50" cy="50" rx="45" ry="15" transform="rotate(32 50 50)" />
            <ellipse className="orbit c" cx="50" cy="50" rx="45" ry="15" transform="rotate(92 50 50)" />
            <circle className="ion a" cx="89.7" cy="28.9" r="1.5" />
            <circle className="ion b" cx="11.8" cy="26.2" r="1.5" />
            <circle className="ion c" cx="48.4" cy="95" r="1.5" />
          </g>
          <g transform="translate(50 50) scale(2.2) translate(-16 -16.9)">
            <path className="star-glow" filter="url(#plate-blur)" d={LOGO_PATH} />
            <path className="star" pathLength={100} d={LOGO_PATH} />
          </g>
        </svg>
      </div>
    </div>
  );
}
