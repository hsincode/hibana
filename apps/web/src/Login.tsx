import type { CSSProperties } from "react";
import { apiUrl } from "./api";
import { ThemeMenu } from "./controls";
import { Icon, LOGO_PATH, useDocumentTitle } from "./ui";

/* 図版の目盛りと放射線は、中心 (50, 50) の周りに角度で並べる */
const at = (r: number, deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(50 + Math.cos(a) * r).toFixed(2)} ${(50 + Math.sin(a) * r).toFixed(2)}`;
};
/* 5 度ごとに 72 本。30 度ごとの目盛りだけ長い */
const TICKS = Array.from(
  { length: 72 },
  (_, i) => `M${at(40, i * 5)}L${at(i % 6 ? 41.6 : 43.6, i * 5)}`,
).join("");
const RAYS = Array.from({ length: 12 }, (_, i) => i * 30);
/* 輪といっしょに回る琥珀の点 */
const PIP = at(34, -40).split(" ");

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
      {/* 図版: 同心円・目盛りの輪・放射線と、中心の星（#142）。飾りなので読み上げない。 */}
      <div className="login-plate" aria-hidden="true">
        <svg viewBox="0 0 100 100">
          <circle className="ring" pathLength={1} cx="50" cy="50" r="48" />
          <circle
            className="ring"
            pathLength={1}
            cx="50"
            cy="50"
            r="34"
            style={{ "--d": "100ms" } as CSSProperties}
          />
          <circle
            className="ring"
            pathLength={1}
            cx="50"
            cy="50"
            r="21"
            style={{ "--d": "200ms" } as CSSProperties}
          />
          {/* 目盛りの輪だけは回り続ける（2 分で 1 周）。動きを減らす設定では止まる */}
          <g className="spin">
            <path className="ticks" d={TICKS} />
            <circle className="pip" cx={PIP[0]} cy={PIP[1]} r="1" />
          </g>
          {RAYS.map((deg, i) => (
            <path
              key={deg}
              className="ray"
              pathLength={1}
              d={`M${at(11, deg)}L${at(17.5, deg)}`}
              style={{ "--d": `${300 + i * 35}ms` } as CSSProperties}
            />
          ))}
          <g transform="translate(50 50) scale(0.8) translate(-16 -16.9)">
            <path className="star" d={LOGO_PATH} />
          </g>
        </svg>
      </div>
    </div>
  );
}
