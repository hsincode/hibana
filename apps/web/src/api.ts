import type { MultiAgentRoles, SubagentModel, SubagentEffort, ServiceTier } from "@hibana/shared/settings";
const API =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
    /\/$/,
    "",
  ) ?? "";

export function apiUrl(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  return `${API}${path}`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const res = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

/**
 * GET のみの共有キャッシュ。
 * /api/me → /api/guilds が直列に走ると本番（別 origin + サーバーレス）で
 * 待ち時間が二重になるので、起動時にまとめて投げて結果を使い回す。
 * 書き込み系は必ず api() を直接使うこと。
 */
const inflight = new Map<string, Promise<unknown>>();

export function apiCached<T>(path: string): Promise<T> {
  const hit = inflight.get(path);
  if (hit) return hit as Promise<T>;
  const req = api<T>(path);
  inflight.set(path, req);
  // 失敗はキャッシュしない（再試行できなくなるため）
  req.catch(() => inflight.delete(path));
  return req;
}

/** 起動直後に投げておくパス。未ログインなら 401 が返るだけで害はない。 */
export function prefetch(paths: string[]): void {
  for (const p of paths) void apiCached(p).catch(() => undefined);
}

export function clearApiCache(): void {
  inflight.clear();
}

export type Me = {
  id: string;
  username: string;
  avatar: string | null;
  role: string;
  can_manage_users: boolean;
};

export type GuildSummary = {
  id: string;
  name: string;
  icon: string | null;
  preset: string | null;
};

export type Artifact = {
  token: string;
  guild_id: string | null;
  channel_id: string;
  url: string;
  source_path: string;
  created_at_unix: number;
  updated_at_unix: number | null;
  expires_at_unix: number;
  retention: "ttl" | "month" | "permanent";
  bytes: number;
  file_count: number;
  permanent: boolean;
  pending: "month" | "permanent" | "unpermanent" | string | null;
};

export type Preset = {
  id: string;
  label: string;
  /** 旧 API は provider / model を返さないので、無い場合は label から推定する。 */
  provider?: string;
  model?: string;
  /** これより弱い plan は選べない。未指定 = 誰でも。ダッシュボード overlay 後の live 値。 */
  min_role?: string;
  /** false = 未公開。Admin/Mod の /models 以外では出さない。未指定 = 公開。 */
  published?: boolean;
};

export type Catalog = {
  presets: Preset[];
  efforts: string[];
  exa: string[];
  roles: string[];
  /** ボットが今使える preset id。未定義なら全部使える扱い。 */
  available_presets?: string[];
  /** メンションなしで発火する内蔵キーワード。旧 API は返さない。 */
  triggers?: string[];
};

export type GuildSettings = Record<string, unknown> & {
  mcp_enabled?: boolean | null;
  mcp_url?: string | null;
  selection?: {
    provider?: string;
    model?: string;
    effort?: string | null;
  } | null;
  effort?: string | null;
  service_tier?: ServiceTier | null;
  subagent_enabled?: boolean | null;
  ultra_mode?: boolean | null;
  multi_agent?: boolean | null;
  multi_agent_roles?: MultiAgentRoles | null;
  subagent_model?: SubagentModel | null;
  subagent_effort?: SubagentEffort | null;
  jev_enabled?: boolean | null;
  jev_task_enabled?: boolean | null;
  server_tools?: boolean;
  thread_only?: boolean;
  /** API returns a concrete boolean; nullable only for older responses. */
  suppress_embeds?: boolean | null;
  voice_mode?: string;
  filler_removal?: boolean;
  temperature?: number | null;
  exa_mode?: string | null;
  thread_history_max_age_secs?: number | null;
  extra_triggers?: string[] | null;
  disabled_triggers?: string[];
  context?: { text: string; persona_override: boolean } | null;
};

/** Independent personal settings, initialized with concrete defaults. */
export type UserSettings = {
  selection?: {
    provider?: string;
    model?: string;
    effort?: string | null;
  } | null;
  effort?: string | null;
  service_tier?: ServiceTier | null;
  subagent_enabled?: boolean | null;
  ultra_mode?: boolean | null;
  multi_agent?: boolean | null;
  multi_agent_roles?: MultiAgentRoles | null;
  subagent_model?: SubagentModel | null;
  subagent_effort?: SubagentEffort | null;
  jev_enabled?: boolean | null;
  jev_task_enabled?: boolean | null;
  context?: { text: string; persona_override: boolean } | null;
};
