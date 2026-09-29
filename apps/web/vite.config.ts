import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * index.html の %SITE_URL% を実 origin に置き換え、本番だけ API への
 * preconnect を足す。
 * - canonical / OGP 画像は絶対 URL でないと Discord / X が解決しない。
 * - preconnect は HTML パース時点で TCP/TLS を張るためのもの。JS の
 *   ダウンロードと並列になり、初回の /api/me が 1RTT 前倒しになる。
 */
function htmlMeta(siteUrl: string, apiBase: string | undefined) {
  return {
    name: "html-meta",
    transformIndexHtml(html: string) {
      let out = html.replaceAll("%SITE_URL%", siteUrl);
      if (apiBase) out = out.replace("</head>", `  <link rel="preconnect" href="${apiBase}" crossorigin />\n  </head>`);
      return out;
    },
  };
}

export default defineConfig(({ mode }) => {
  // vite.config 内では .env* が process.env に入らないので明示的に読む。
  // prefix "" なので Vercel のビルド環境変数（VERCEL_*）も一緒に取れる。
  const env = loadEnv(mode, process.cwd(), "");
  const siteUrl = (
    env.VITE_SITE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    "http://localhost:5173"
  ).replace(/\/$/, "");
  // ローカル（未設定 = 同一 origin プロキシ）では preconnect を足さない
  const apiBase = env.VITE_API_BASE_URL?.replace(/\/$/, "") || undefined;

  return {
    plugins: [react(), htmlMeta(siteUrl, apiBase)],
    server: {
      port: 5173,
      proxy: {
        // Local: cookie stays on :5173. Production uses VITE_API_BASE_URL instead.
        "/api": "http://127.0.0.1:3000",
        "/auth": "http://127.0.0.1:3000",
      },
    },
  };
});
