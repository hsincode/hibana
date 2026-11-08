/* ============================================================
   ページの一覧
   サイドバー・狭い幅のタブ帯・コマンドパレットが同じ一覧を使う。
   画面テスト（tests/）からも読むので、ここには React を持ち込まない。
   ============================================================ */

/** サーバー設定の 6 ページ。`path` は `/g/:id/` に続く部分で、空がエージェント。 */
export const GUILD_PAGES: {
  path: string;
  label: string;
  /** 設定行があり、変更が自動保存されるページ。上部バーに保存状態を出す。 */
  autosave?: boolean;
  /** 表が主役のページは、本文の幅を広げる。 */
  wide?: boolean;
}[] = [
  { path: "", label: "エージェント", autosave: true },
  { path: "tools", label: "ツールと挙動", autosave: true },
  { path: "context", label: "コンテキスト", autosave: true },
  { path: "skills", label: "スキル" },
  { path: "artifacts", label: "成果物", wide: true },
  { path: "schedules", label: "定時アクション" },
];

export const guildPath = (id: string, page = ""): string =>
  page ? `/g/${id}/${page}` : `/g/${id}`;

/**
 * 1 ページだった頃の節へのリンク（`/g/:id#mcp` など）を、分かれた先のページへ送る。
 * エージェントのページに残った節（model / agents / jev）は載せない。
 */
export const LEGACY_SECTION_PAGE: Record<string, string> = {
  tuning: "tools",
  mcp: "tools",
  behavior: "tools",
  triggers: "tools",
  context: "context",
  artifacts: "artifacts",
};

/**
 * コマンドパレットから飛べる設定項目。`row` は設定行の `data-row`。
 * 行のキーを変えたら、ここも合わせる（tests/design.spec.ts が全項目を開いて確かめる）。
 */
export const GUILD_SETTINGS: { label: string; page: string; row: string }[] = [
  { label: "モデル", page: "", row: "g-preset" },
  { label: "effort", page: "", row: "g-effort" },
  { label: "Service Tier", page: "", row: "g-tier" },
  { label: "サブエージェントのモード", page: "", row: "g-mode" },
  { label: "Jev 判定", page: "", row: "g-jev" },
  { label: "Jev 行動選択モード", page: "", row: "g-jev-task" },
  { label: "外部 MCP", page: "tools", row: "g-mcp-enabled" },
  { label: "server-tools", page: "tools", row: "g-server-tools" },
  { label: "thread-only", page: "tools", row: "g-thread-only" },
  { label: "URL previews", page: "tools", row: "g-url-previews" },
  { label: "Text Generation Model", page: "tools", row: "g-text-model" },
  { label: "トリガーワード", page: "tools", row: "g-triggers" },
  { label: "サーバーコンテキスト", page: "context", row: "g-context" },
  { label: "persona override", page: "context", row: "g-persona" },
];

/** 全体の設定（#161）のページ。 */
export const APP_SETTINGS_PATH = "/settings";

/**
 * コマンドパレットから飛べる、全体の設定の項目。`row` は Global.tsx の設定行の `data-row`。
 * 行のキーを変えたら、ここも合わせる（tests/design.spec.ts が全項目を開いて確かめる）。
 */
export const APP_SETTINGS: { label: string; row: string }[] = [
  { label: "temperature", row: "a-temperature" },
  { label: "exa", row: "a-exa" },
  { label: "スレッド履歴の保持（秒）", row: "a-history" },
  { label: "スレッドの要約", row: "a-compaction" },
  { label: "要約を始める大きさ", row: "a-compaction-tokens" },
  { label: "MCP サーバー URL", row: "a-mcp-url" },
  { label: "voice-mode", row: "a-voice" },
  { label: "filler removal", row: "a-filler" },
];
