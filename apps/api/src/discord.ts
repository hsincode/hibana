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
};

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
