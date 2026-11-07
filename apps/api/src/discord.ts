import type { WebEnv } from "./env";

export type DiscordUser = {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
};

export type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
  /** Only on the user's own list: whether they own the server. */
  owner?: boolean;
  /** Only on the user's own list: their permissions there, as a decimal string. */
  permissions?: string;
};

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

/** Whether an entry of the user's guild list lets them manage that server. */
export function canManageGuild(guild: DiscordGuild): boolean {
  if (guild.owner) return true;
  try {
    const bits = BigInt(guild.permissions ?? "0");
    return (bits & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
  } catch {
    return false;
  }
}

export type DiscordChannel = {
  id: string;
  name: string;
  /** The category it sits in, by name; null outside one. */
  category: string | null;
};

const TEXT_CHANNEL = 0;
const ANNOUNCEMENT_CHANNEL = 5;
const CATEGORY = 4;
const channelsCache = new Map<string, CacheEntry<DiscordChannel[]>>();

/** A server's text and announcement channels, in Discord's order. */
export async function fetchGuildChannels(
  env: WebEnv,
  guildId: string,
): Promise<DiscordChannel[]> {
  const now = Date.now();
  const hit = channelsCache.get(guildId);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const res = await fetch(
    `https://discord.com/api/guilds/${encodeURIComponent(guildId)}/channels`,
    { headers: { Authorization: `Bot ${env.discordToken}` } },
  );
  if (!res.ok) throw new Error(`discord guild channels failed (${res.status})`);
  const raw = (await res.json()) as {
    id: string;
    name: string;
    type: number;
    position: number;
    parent_id?: string | null;
  }[];
  const categories = new Map(
    raw.filter((c) => c.type === CATEGORY).map((c) => [c.id, c]),
  );
  const rank = (c: (typeof raw)[number]) => {
    const parent = c.parent_id ? categories.get(c.parent_id) : undefined;
    // Channels outside a category come first, as in the Discord client.
    return [parent ? parent.position + 1 : 0, c.position] as const;
  };
  const value = raw
    .filter((c) => c.type === TEXT_CHANNEL || c.type === ANNOUNCEMENT_CHANNEL)
    .sort((a, b) => {
      const [pa, ca] = rank(a);
      const [pb, cb] = rank(b);
      return pa - pb || ca - cb;
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      category: (c.parent_id && categories.get(c.parent_id)?.name) || null,
    }));
  if (channelsCache.size > 500) channelsCache.clear();
  channelsCache.set(guildId, { at: now, value });
  return value;
}

type CacheEntry<T> = { at: number; value: T };
const botGuildsCache: { current: CacheEntry<DiscordGuild[]> | null } = {
  current: null,
};
const TTL_MS = 60_000;

export async function exchangeCode(
  env: WebEnv,
  code: string,
  verifier: string,
): Promise<{ access_token: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: env.discordClientId,
    client_secret: env.discordClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: `${env.publicBaseUrl.replace(/\/$/, "")}/auth/discord/callback`,
    code_verifier: verifier,
  });
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`discord token exchange failed (${res.status})`);
  }
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

export async function fetchMe(accessToken: string): Promise<DiscordUser> {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`discord /users/@me failed (${res.status})`);
  return res.json() as Promise<DiscordUser>;
}

export async function fetchUserGuilds(
  accessToken: string,
): Promise<DiscordGuild[]> {
  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`discord user guilds failed (${res.status})`);
  return res.json() as Promise<DiscordGuild[]>;
}

export async function fetchBotGuilds(env: WebEnv): Promise<DiscordGuild[]> {
  const now = Date.now();
  if (botGuildsCache.current && now - botGuildsCache.current.at < TTL_MS) {
    return botGuildsCache.current.value;
  }
  const res = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: { Authorization: `Bot ${env.discordToken}` },
  });
  if (!res.ok) throw new Error(`discord bot guilds failed (${res.status})`);
  const value = (await res.json()) as DiscordGuild[];
  botGuildsCache.current = { at: now, value };
  return value;
}

export function intersectGuilds(
  user: DiscordGuild[],
  bot: DiscordGuild[],
): DiscordGuild[] {
  const botIds = new Set(bot.map((g) => g.id));
  return user.filter((g) => botIds.has(g.id));
}

export function authorizeUrl(
  env: WebEnv,
  state: string,
  challenge: string,
): string {
  const q = new URLSearchParams({
    client_id: env.discordClientId,
    redirect_uri: `${env.publicBaseUrl.replace(/\/$/, "")}/auth/discord/callback`,
    response_type: "code",
    scope: "identify guilds",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://discord.com/api/oauth2/authorize?${q}`;
}
