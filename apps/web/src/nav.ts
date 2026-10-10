/* ============================================================
   ページの一覧
   サイドバー・狭い幅のタブ帯・コマンドパレットが同じ一覧を使う。
   画面テスト（tests/）からも読むので、ここには React を持ち込まない。
   ============================================================ */

/** サーバー設定の 5 ページ。`path` は `/g/:id/` に続く部分で、空がエージェント。 */
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
  { label: "temperature", page: "tools", row: "g-temperature" },
  { label: "exa", page: "tools", row: "g-exa" },
  { label: "スレッド履歴の保持（秒）", page: "tools", row: "g-history" },
  { label: "外部 MCP", page: "tools", row: "g-mcp-enabled" },
  { label: "MCP サーバー URL", page: "tools", row: "g-mcp-url" },
  { label: "server-tools", page: "tools", row: "g-server-tools" },
  { label: "thread-only", page: "tools", row: "g-thread-only" },
  { label: "URL previews", page: "tools", row: "g-url-previews" },
  { label: "voice-mode", page: "tools", row: "g-voice" },
  { label: "filler removal", page: "tools", row: "g-filler" },
  { label: "トリガーワード", page: "tools", row: "g-triggers" },
  { label: "サーバーコンテキスト", page: "context", row: "g-context" },
  { label: "persona override", page: "context", row: "g-persona" },
];
