import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import {
  BUILTIN_TRIGGERS,
  catalogPremium,
  catalogPublished,
  effectiveMinRole,
  REASONING_EFFORTS,
  EXA_MODES,
  isPresetId,
  isPublished,
  parsePremiumOverrides,
  parseVisibilityOverrides,
  premiumPresetIds,
  SELECTABLE_PRESETS,
  unpublishedPresetIds,
} from "./catalog";
import {
  canAssignRole,
  canManageUsers,
  canModerate,
  canSelectPreset,
  canViewAllGuilds,
  canViewAnalytics,
  parseRole,
  rank,
  ROLES,
  rolesAssignableBy,
  type Role,
} from "./roles";
import {
  LOG_RETENTION_MS,
  parseLogEntry,
  parseLogQuery,
  type LogEntry,
} from "./audit";
import {
  authorizeUrl,
  exchangeCode,
  fetchBotGuilds,
  fetchMe,
  fetchUserGuilds,
  intersectGuilds,
} from "./discord";
import { cookieCrossOrigin, type WebEnv } from "./env";
import { randomUrlSafe, s256Challenge } from "./pkce";
import {
  parseSnapshotEtag,
  SnapshotHub,
  snapshotEtag,
  SSE_PING_MS,
  SSE_VERSION_WATCH_MS,
  type CachedSnapshot,
} from "./hub";
import {
  applyPatch,
  applyUserOverridePatch,
  emptyGuild,
  normalizeGuild,
  guildPatchSchema,
  patchPresetIds,
  userOverridePatchSchema,
} from "./settings";
import {
  isArtifactAction,
  type ArtifactAction,
  type ArtifactRow,
  type Store,
} from "./store";
import { guildId, guildSkills, skillAction, skillRow } from "./skills";
import { ChatgptAccounts, ChatgptError } from "./chatgpt";
import { CostReport, CostReportError, parseMonth } from "./analytics";

async function loadSnapshot(
  store: Store,
  hub: SnapshotHub,
  knownVersion: number,
  adminIds: string[],
  chatgpt?: ChatgptAccounts,
): Promise<CachedSnapshot> {
  const cached = hub.get();
  if (cached && cached.version === knownVersion) return cached;
  const guilds = await store.allGuilds();
  const user_contexts = await store.allUserContexts();
  const user_overrides = await store.allUserOverrides();
  // Read-only for the bot. Deliberately **not** part of PUT /internal/snapshot:
  // that call replaces guilds/user_contexts wholesale, so round-tripping the
  // block list through the bot would let a stale bot process unban someone.
  const blocked_users = (await store.listBlocked()).map((b) => b.discord_id);
  const admin = new Set(adminIds);
  const user_roles = Object.fromEntries(
    (await store.listUsers()).map((u) => [
      u.discord_id,
      admin.has(u.discord_id) ? "administrator" : u.role,
    ]),
  );
  const unpublished_presets = unpublishedPresetIds(
    parseVisibilityOverrides(await store.getMeta("preset_visibility")),
  );
  const premium_presets = premiumPresetIds(
    parsePremiumOverrides(await store.getMeta("preset_premium")),
  );
  const artifact_commands = (await store.listArtifactCommands()).map((c) => ({
    id: c.id,
    token: c.token,
    guild_id: c.guild_id,
    action: c.action,
  }));
  const skill_commands = (await store.listSkillCommands()).filter(
    (c) => c.result === null,
  );
  const versionAfter = await store.version();
  const body: CachedSnapshot = {
    version: versionAfter,
    guilds,
    user_contexts,
    user_overrides,
    blocked_users,
    user_roles,
    unpublished_presets,
    premium_presets,
    artifact_commands,
    skill_commands,
    chatgpt_available: await chatgpt?.available() ?? false,
  };
  // Skip caching a torn read: a write between the loads and versionAfter
  // would pin old rows under the new version until the next bump.
  if (knownVersion === versionAfter) hub.set(body);
  return body;
}

const COOKIE = "hibana_session";

export type AppHooks = {
  chatgptFetch?: typeof fetch;
  /** Stands in for Anthropic's Admin API (the cost report) in tests. */
  anthropicFetch?: typeof fetch;
  /** Clock for the cost report: which UTC day is "today", and its cache age. */
  now?: () => number;
  guildAccess?: (accessToken: string, guildId: string) => Promise<boolean>;
  listGuilds?: (
    accessToken: string,
  ) => Promise<{ id: string; name: string; icon: string | null }[]>;
  /** Every guild the **bot** is in — what admins/mods see instead of the intersection. */
  listBotGuilds?: () => Promise<
    { id: string; name: string; icon: string | null }[]
  >;
};

export function createApp(env: WebEnv, store: Store, hooks: AppHooks = {}) {
  const chatgpt = new ChatgptAccounts(store, env.sessionSecret, hooks.chatgptFetch);
  const now = hooks.now ?? Date.now;
  const costReport = new CostReport(env.anthropicAdminKey, hooks.anthropicFetch, now);
  const cross = cookieCrossOrigin(env);
  const cookieOpts = {
    httpOnly: true,
    path: "/",
    sameSite: (cross ? "none" : "lax") as "none" | "lax",
    // Cross-site cookies require Secure; HTTPS in production, localhost is same-site via Vite proxy.
    secure: cross || env.publicBaseUrl.startsWith("https://"),
    maxAge: 60 * 60 * 24 * 14,
  };

  const effectiveRole = (discordId: string, stored: Role): Role => {
    if (env.adminIds.includes(discordId)) return "administrator";
    return stored;
  };

  const cookieSid = (
    cookie: Record<string, { value?: unknown } | undefined>,
  ) => {
    const v = cookie[COOKIE]?.value;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const requireSession = async (sid: string | undefined) => {
    if (!sid) return null;
    const sess = await store.getSession(sid);
    if (!sess || sess.expires_at < Date.now()) return null;
    const user = await store.getUser(sess.discord_id);
    if (!user) return null;
    return {
      ...user,
      role: effectiveRole(user.discord_id, user.role),
      access_token: sess.access_token,
      session_id: sid,
    };
  };

  const requireInternal = (auth: string | undefined) =>
    Boolean(env.internalToken) && auth === `Bearer ${env.internalToken}`;

  const botGuilds = () =>
    hooks.listBotGuilds ? hooks.listBotGuilds() : fetchBotGuilds(env);

  const hub = new SnapshotHub();
  const publish = async () => {
    hub.invalidate();
    hub.notify(await store.version());
  };

  // Pruning on every ingest would add a DELETE to each bot flush; once an hour
  // is enough for a 30-day window and keeps the hot path a single INSERT batch.
  let lastPrune = 0;

  return new Elysia()
    .use(
      cors({
        origin: env.frontendOrigin,
        credentials: true,
      }),
    )
    .onError(({ error, set }) => {
      if (error instanceof ChatgptError || error instanceof CostReportError) {
        set.status = error.status;
        return { error: error.message };
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes("required") ||
        msg.includes("unknown") ||
        msg.includes("invalid")
      ) {
        set.status = 400;
        return { error: msg };
      }
      set.status = 500;
      return { error: "internal error" };
    })
    .get("/healthz", () => "ok")
    // Not a secret: the repository is public and the commit is on GitHub.
    .get("/version", () => ({ commit: env.commit }))
    .group("/api/chatgpt", app => app
      .onBeforeHandle(async ({ cookie, request, set }) => {
        set.headers["cache-control"] = "no-store";
        const s = await requireSession(cookieSid(cookie as never));
        if (!s) { set.status = 401; return { error: "unauthorized" }; }
        if (!canManageUsers(s.role)) { set.status = 403; return { error: "forbidden" }; }
        // Cross-site session cookies are needed by the dashboard; CORS alone
        // does not prevent another website from submitting a mutation.
        if (request.method !== "GET" && request.headers.get("origin") !== new URL(env.frontendOrigin).origin) {
          set.status = 403; return { error: "forbidden origin" };
        }
      })
      .get("/accounts", async () => ({ accounts: await chatgpt.list() }))
      .post("/login", async ({ cookie }) => chatgpt.start(cookieSid(cookie as never)!))
      .post("/login/:id", async ({ cookie, params }) => {
        const result = await chatgpt.poll(cookieSid(cookie as never)!, params.id);
        if (result.status === "complete") { await store.bumpVersion(); await publish(); }
        return result;
      })
      .patch("/accounts/:id", async ({ params, body, set }) => {
        const enabled = (body as { enabled?: unknown } | null)?.enabled;
        if (typeof enabled !== "boolean") { set.status = 400; return { error: "enabled boolean required" }; }
        const result = await chatgpt.manage(params.id, enabled);
        await store.bumpVersion(); await publish();
        return result;
      })
      .delete("/accounts/:id", async ({ params }) => {
        const result = await chatgpt.manage(params.id, null);
        await store.bumpVersion(); await publish();
        return result;
      }))
    .post("/internal/chatgpt/credential", async ({ headers, set }) => {
      set.headers["cache-control"] = "no-store";
      if (!requireInternal(headers.authorization)) { set.status = 401; return { error: "unauthorized" }; }
      return chatgpt.credential();
    })
    .get("/auth/discord", async ({ set, redirect }) => {
      if (!env.discordClientId || !env.discordClientSecret) {
        set.status = 503;
        return {
          error:
            "Discord OAuth is not configured (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET)",
        };
      }
      const state = randomUrlSafe(16);
      const verifier = randomUrlSafe(32);
      await store.putPending(state, verifier);
      const challenge = await s256Challenge(verifier);
      // Elysia 1.4: `set.redirect` is deprecated and a no-op through `.handle()`.
      return redirect(authorizeUrl(env, state, challenge));
    })
    .get("/auth/discord/callback", async ({ query, set, cookie, redirect }) => {
      const code = String(query.code ?? "");
      const state = String(query.state ?? "");
      const verifier = await store.takePending(state);
      if (!code || !verifier) {
        set.status = 400;
        return { error: "invalid oauth callback" };
      }
      const tok = await exchangeCode(env, code, verifier);
      const me = await fetchMe(tok.access_token);
      await store.upsertUser({
        discord_id: me.id,
        username: me.global_name || me.username,
        avatar: me.avatar,
        // WEB_ADMIN_IDS is the only bootstrap Administrator. Everyone else
        // starts as Free (`DEFAULT_ROLE`); admins/mods promote from the dashboard.
        role: env.adminIds.includes(me.id) ? "administrator" : undefined,
      });
      const sid = randomUrlSafe(24);
      await store.putSession(
        sid,
        me.id,
        tok.access_token,
        Date.now() + tok.expires_in * 1000,
      );
      cookie[COOKIE]?.set({ value: sid, ...cookieOpts });
      return redirect(env.frontendOrigin.replace(/\/$/, "") + "/");
    })
    .post("/auth/logout", async ({ cookie, set }) => {
      const sid = cookieSid(cookie as never);
      if (sid) await store.deleteSession(sid);
      cookie[COOKIE]?.remove();
      set.status = 204;
    })
    .get("/api/me", async ({ cookie, set }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return {
        id: s.discord_id,
        username: s.username,
        avatar: s.avatar,
        role: s.role,
        can_manage_users: canManageUsers(s.role),
        can_moderate: canModerate(s.role),
        can_view_all_guilds: canViewAllGuilds(s.role),
        can_view_analytics: canViewAnalytics(s.role),
      };
    })
    .get("/api/me/settings", async ({ cookie, set }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return {
        settings: await store.getUserOverride(s.discord_id),
        version: await store.version(),
      };
    })
    .patch("/api/me/settings", async ({ cookie, set, body }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const parsed = userOverridePatchSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues.map((i) => i.message).join("; ") };
      }
      const gated = refuseRestrictedPatch(
        s.role,
        parsed.data,
        await loadPremium(store),
      );
      if (gated) {
        set.status = 403;
        return { error: gated };
      }
      const hidden = refuseUnpublishedPatch(
        await loadUnpublished(store),
        parsed.data,
      );
      if (hidden) {
        set.status = 403;
        return { error: hidden };
      }
      const next = applyUserOverridePatch(
        await store.getUserOverride(s.discord_id),
        parsed.data,
        store.defaults,
      );
      await store.putUserOverride(s.discord_id, next);
      await publish();
      return { settings: next, version: await store.version() };
    })
    .get("/api/catalog", async ({ cookie }) => {
      const raw = await store.getMeta("available_presets");
      let available = SELECTABLE_PRESETS.map((p) => p.id) as string[];
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) available = parsed.map(String);
        } catch {
          /* keep catalog default */
        }
      }
      const overrides = parseVisibilityOverrides(
        await store.getMeta("preset_visibility"),
      );
      const premium = parsePremiumOverrides(
        await store.getMeta("preset_premium"),
      );
      const s = await requireSession(cookieSid(cookie as never));
      // The bot advertises configured providers separately. Master account
      // availability is owned here and must update immediately after login.
      available = available.filter(id => !id.startsWith("chatgpt-"));
      const hasChatgpt = await chatgpt.available();
      if (hasChatgpt) available.push(...SELECTABLE_PRESETS.filter(p => p.provider === "chatgpt").map(p => p.id));
      const staff = s ? canManageUsers(s.role) : false;
      // Staff see unpublished rows so the /models admin page can toggle them.
      // Everyone else only gets currently public presets — the unreleased
      // SKUs stay out of the picker JSON until an admin publishes them.
      // `min_role` is the live floor after the Premium overlay (picker lock).
      const presets = SELECTABLE_PRESETS.filter(
        (p) => p.provider === "chatgpt" ? (staff || hasChatgpt) : staff || isPublished(p.id, overrides),
      ).map((p) => ({
        ...p,
        published: isPublished(p.id, overrides),
        min_role: effectiveMinRole(p.id, premium) ?? undefined,
      }));
      return {
        presets,
        efforts: REASONING_EFFORTS,
        exa: EXA_MODES,
        roles: ROLES,
        available_presets: available,
        // Built-in wake words. Guild extras / disabled live on the settings row.
        triggers: BUILTIN_TRIGGERS,
      };
    })
    .patch(
      "/api/catalog/presets/:id",
      async ({ cookie, set, params, body }) => {
        const s = await requireSession(cookieSid(cookie as never));
        if (!s) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        if (!canManageUsers(s.role)) {
          set.status = 403;
          return { error: "forbidden" };
        }
        if (!isPresetId(params.id)) {
          set.status = 400;
          return { error: "unknown preset" };
        }
        const patch =
          body && typeof body === "object"
            ? (body as { published?: unknown; premium?: unknown })
            : {};
        const published = patch.published;
        const premiumFlag = patch.premium;
        if (
          typeof published !== "boolean" &&
          typeof premiumFlag !== "boolean"
        ) {
          set.status = 400;
          return { error: "published or premium boolean required" };
        }
        const overrides = parseVisibilityOverrides(
          await store.getMeta("preset_visibility"),
        );
        const premium = parsePremiumOverrides(
          await store.getMeta("preset_premium"),
        );
        // Store only deviations from the catalog default so a later catalog
        // change (new unpublished SKU / new Premium-floor preset) still applies
        // without a meta migration.
        if (typeof published === "boolean") {
          if (published === catalogPublished(params.id))
            delete overrides[params.id];
          else overrides[params.id] = published;
          await store.setMeta("preset_visibility", JSON.stringify(overrides));
        }
        if (typeof premiumFlag === "boolean") {
          if (premiumFlag === catalogPremium(params.id))
            delete premium[params.id];
          else premium[params.id] = premiumFlag;
          await store.setMeta("preset_premium", JSON.stringify(premium));
        }
        // Snapshot GET includes unpublished_presets / premium_presets; bump so
        // If-None-Match / SSE cannot 304 a stale picker list.
        await store.bumpVersion();
        await publish();
        return {
          id: params.id,
          published: isPublished(params.id, overrides),
          min_role: effectiveMinRole(params.id, premium),
          unpublished_presets: unpublishedPresetIds(overrides),
          premium_presets: premiumPresetIds(premium),
          version: await store.version(),
        };
      },
    )
    .get("/api/users", async ({ cookie, set }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!canManageUsers(s.role)) {
        set.status = 403;
        return { error: "forbidden" };
      }
      const users = await store.listUsers();
      const blocked = new Set(
        (await store.listBlocked()).map((b) => b.discord_id),
      );
      return {
        users: users.map((u) => ({
          ...u,
          role: effectiveRole(u.discord_id, u.role),
          blocked: blocked.has(u.discord_id),
        })),
        assignable: rolesAssignableBy(s.role),
      };
    })
    .patch("/api/users/:id", async ({ cookie, set, params, body }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!canManageUsers(s.role)) {
        set.status = 403;
        return { error: "forbidden" };
      }
      if (params.id === s.discord_id) {
        set.status = 403;
        return { error: "cannot change your own role" };
      }
      const nextRaw =
        body && typeof body === "object"
          ? (body as { role?: string }).role
          : undefined;
      const next = nextRaw ? parseRole(nextRaw) : null;
      if (!next) {
        set.status = 400;
        return { error: "unknown role" };
      }
      const target = await store.getUser(params.id);
      if (!target) {
        set.status = 404;
        return { error: "user not found" };
      }
      const targetRole = effectiveRole(target.discord_id, target.role);
      if (!canAssignRole(s.role, targetRole, next)) {
        set.status = 403;
        return { error: "cannot assign that role to this user" };
      }
      await store.setUserRole(params.id, next);
      await publish();
      return { ok: true, discord_id: params.id, role: next };
    })
    .get("/api/guilds", async ({ cookie, set }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const mine = hooks.listGuilds
        ? await hooks.listGuilds(s.access_token)
        : intersectGuilds(
            await fetchUserGuilds(s.access_token),
            await fetchBotGuilds(env),
          );
      // Admin / moderator see every server the bot is in — including ones they
      // were never invited to. `member` tells the UI which are theirs so the
      // extra rows read as moderation scope, not as "you joined 200 servers".
      const all = canViewAllGuilds(s.role) ? await botGuilds() : mine;
      const mineIds = new Set(mine.map((g) => g.id));
      const guilds = await Promise.all(
        all.map(async (g) => {
          const row = await store.getGuild(g.id);
          return {
            id: g.id,
            name: g.name,
            icon: g.icon,
            preset: row.selection?.model ?? null,
            bot_disabled: row.bot_disabled,
            member: mineIds.has(g.id),
          };
        }),
      );
      return { guilds };
    })
    .get("/api/guilds/:id/settings", async ({ cookie, set, params }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!(await guildOk(env, hooks, s.access_token, params.id, s.role))) {
        set.status = 404;
        return { error: "guild not found" };
      }
      return {
        settings: await store.getGuild(params.id),
        version: await store.version(),
      };
    })
    .patch(
      "/api/guilds/:id/settings",
      async ({ cookie, set, params, body }) => {
        const s = await requireSession(cookieSid(cookie as never));
        if (!s) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        if (!(await guildOk(env, hooks, s.access_token, params.id, s.role))) {
          set.status = 404;
          return { error: "guild not found" };
        }
        const parsed = guildPatchSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return {
            error: parsed.error.issues.map((i) => i.message).join("; "),
          };
        }
        const gated = refuseRestrictedPatch(
          s.role,
          parsed.data,
          await loadPremium(store),
        );
        if (gated) {
          set.status = 403;
          return { error: gated };
        }
        const hidden = refuseUnpublishedPatch(
          await loadUnpublished(store),
          parsed.data,
        );
        if (hidden) {
          set.status = 403;
          return { error: hidden };
        }
        const next = applyPatch(await store.getGuild(params.id), parsed.data, store.defaults);
        await store.putGuild(params.id, next);
        await publish();
        return { settings: next, version: await store.version() };
      },
    )
    .get("/internal/snapshot", async ({ request, set }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const version = await store.version();
      const inm = parseSnapshotEtag(request.headers.get("if-none-match"));
      if (inm !== null && inm === version) {
        return new Response(null, {
          status: 304,
          headers: { ETag: snapshotEtag(version) },
        });
      }
      const body = await loadSnapshot(store, hub, version, env.adminIds, chatgpt);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          ETag: snapshotEtag(body.version),
        },
      });
    })
    .get("/internal/events", ({ request, set }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const encoder = new TextEncoder();
      let unsub: (() => void) | undefined;
      let ping: ReturnType<typeof setInterval> | undefined;
      let watch: ReturnType<typeof setInterval> | undefined;
      let lastEmitted = -1;
      let closed = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const send = (event: string, data: unknown) => {
            if (closed) return;
            try {
              controller.enqueue(
                encoder.encode(
                  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
                ),
              );
            } catch {
              closed = true;
            }
          };
          const emit = (nextVersion: number) => {
            if (nextVersion === lastEmitted) return;
            const first = lastEmitted < 0;
            lastEmitted = nextVersion;
            send(first ? "hello" : "update", { version: nextVersion });
          };
          emit(await store.version());
          unsub = hub.subscribe(emit);
          ping = setInterval(() => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              closed = true;
            }
          }, SSE_PING_MS);
          watch = setInterval(() => {
            void store
              .version()
              .then(emit)
              .catch(() => {
                /* next tick retries; do not tear the stream on a blip */
              });
          }, SSE_VERSION_WATCH_MS);
          const abort = () => {
            closed = true;
            unsub?.();
            if (ping) clearInterval(ping);
            if (watch) clearInterval(watch);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          request.signal.addEventListener("abort", abort);
        },
        cancel() {
          closed = true;
          unsub?.();
          if (ping) clearInterval(ping);
          if (watch) clearInterval(watch);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      });
    })
    .put("/internal/snapshot", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const raw =
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : {};
      const guilds = raw.guilds;
      if (!guilds || typeof guilds !== "object" || Array.isArray(guilds)) {
        set.status = 400;
        return { error: "guilds object required" };
      }
      const normalized: Record<string, ReturnType<typeof emptyGuild>> = {};
      for (const [id, settings] of Object.entries(
        guilds as Record<string, unknown>,
      )) {
        if (!id || typeof settings !== "object" || settings === null) continue;
        normalized[id] = normalizeGuild(settings as object, store.defaults);
      }
      const userContexts: Record<
        string,
        { text: string; persona_override: boolean }
      > = {};
      const rawCtx = raw.user_contexts;
      if (rawCtx && typeof rawCtx === "object" && !Array.isArray(rawCtx)) {
        for (const [id, entry] of Object.entries(
          rawCtx as Record<string, unknown>,
        )) {
          if (!id || typeof entry !== "object" || entry === null) continue;
          const e = entry as { text?: unknown; persona_override?: unknown };
          const text = typeof e.text === "string" ? e.text : "";
          const persona_override = Boolean(e.persona_override);
          if (!text.trim() && !persona_override) continue;
          userContexts[id] = { text, persona_override };
        }
      }
      await store.replaceSnapshot(normalized, userContexts);
      await publish();
      return {
        version: await store.version(),
        n_guilds: Object.keys(normalized).length,
      };
    })
    .patch("/internal/guilds/:id", async ({ request, set, params, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const parsed = guildPatchSchema.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: parsed.error.issues.map((i) => i.message).join("; ") };
      }
      const next = applyPatch(await store.getGuild(params.id), parsed.data, store.defaults);
      await store.putGuild(params.id, next);
      await publish();
      return { settings: next, version: await store.version() };
    })
    .patch(
      "/internal/users/:id/settings",
      async ({ request, set, params, body }) => {
        if (
          !requireInternal(request.headers.get("authorization") ?? undefined)
        ) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        // Same snowflake rule as /api/blocked: a username here would write a row
        // the bot never looks up.
        if (!/^\d{5,25}$/.test(params.id)) {
          set.status = 400;
          return { error: "discord_id must be a snowflake" };
        }
        const parsed = userOverridePatchSchema.safeParse(body);
        if (!parsed.success) {
          set.status = 400;
          return {
            error: parsed.error.issues.map((i) => i.message).join("; "),
          };
        }
        const next = applyUserOverridePatch(
          await store.getUserOverride(params.id),
          parsed.data,
          store.defaults,
        );
        await store.putUserOverride(params.id, next);
        await publish();
        return { settings: next, version: await store.version() };
      },
    )
    .get("/api/blocked", async ({ cookie, set }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!canModerate(s.role)) {
        set.status = 403;
        return { error: "forbidden" };
      }
      return { blocked: await store.listBlocked() };
    })
    .post("/api/blocked", async ({ cookie, set, body }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!canModerate(s.role)) {
        set.status = 403;
        return { error: "forbidden" };
      }
      const raw = (body ?? {}) as { discord_id?: unknown; reason?: unknown };
      const id = String(raw.discord_id ?? "").trim();
      // Snowflakes only: the bot matches on the numeric id, so a username here
      // would silently block nobody.
      if (!/^\d{5,25}$/.test(id)) {
        set.status = 400;
        return { error: "discord_id must be a snowflake" };
      }
      if (id === s.discord_id) {
        set.status = 403;
        return { error: "cannot block yourself" };
      }
      const target = await store.getUser(id);
      // Only guards accounts that exist here; an unknown id has no role to outrank.
      if (
        target &&
        rank(effectiveRole(target.discord_id, target.role)) <= rank(s.role)
      ) {
        set.status = 403;
        return { error: "cannot block that user" };
      }
      const reason =
        typeof raw.reason === "string" ? raw.reason.slice(0, 500) : null;
      await store.setBlocked({
        discord_id: id,
        username: target?.username ?? null,
        reason: reason && reason.trim() ? reason : null,
        blocked_by: s.discord_id,
        blocked_at: Date.now(),
      });
      await publish();
      return { ok: true, discord_id: id };
    })
    .delete("/api/blocked/:id", async ({ cookie, set, params }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!canModerate(s.role)) {
        set.status = 403;
        return { error: "forbidden" };
      }
      await store.unblock(params.id);
      await publish();
      return { ok: true, discord_id: params.id };
    })
    .get("/api/logs", async ({ cookie, set, query }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      // DM turns are in here, so this is admin/mod only — never guild-scoped.
      if (!canModerate(s.role)) {
        set.status = 403;
        return { error: "forbidden" };
      }
      if (!env.logsEnabled) {
        return {
          logs: [],
          next: null,
          retention_days: Math.round(LOG_RETENTION_MS / 86_400_000),
          enabled: false,
        };
      }
      const q = parseLogQuery(query as Record<string, string | undefined>);
      const logs = await store.listLogs(q);
      // `next` is the keyset cursor for the following page; null = end of log.
      const next = logs.length === q.limit ? logs[logs.length - 1].id : null;
      return {
        logs,
        next,
        retention_days: Math.round(LOG_RETENTION_MS / 86_400_000),
        enabled: true,
      };
    })
    .get("/api/analytics/cost", async ({ cookie, set, query }) => {
      // Billing figures: never held by a shared cache or the browser's.
      set.headers["cache-control"] = "no-store";
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!canViewAnalytics(s.role)) {
        set.status = 403;
        return { error: "forbidden" };
      }
      // Same shape as /api/logs when it is switched off: the page explains
      // what to set instead of showing an error.
      if (!costReport.configured) return { configured: false };
      const month = parseMonth(
        (query as Record<string, string | undefined>).month,
        now(),
      );
      if (!month) {
        set.status = 400;
        return { error: "month must be YYYY-MM and not in the future" };
      }
      return costReport.month(month);
    })
    .post("/internal/logs", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!env.logsEnabled) {
        return { ok: true, n: 0, enabled: false };
      }
      const raw = (body ?? {}) as { entries?: unknown };
      const list = Array.isArray(raw.entries) ? raw.entries : [];
      const entries = list
        .map(parseLogEntry)
        .filter((e): e is LogEntry => e !== null);
      if (entries.length) await store.appendLogs(entries);
      const now = Date.now();
      if (now - lastPrune > 3_600_000) {
        lastPrune = now;
        await store.pruneLogs(now - LOG_RETENTION_MS);
      }
      return { ok: true, n: entries.length, enabled: true };
    })
    .post("/internal/capabilities", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const presets =
        body && typeof body === "object"
          ? (body as { available_presets?: string[] }).available_presets
          : undefined;
      await store.setMeta(
        "available_presets",
        JSON.stringify(Array.isArray(presets) ? presets : []),
      );
      return { ok: true };
    })
    .post("/internal/skills/chunk", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const raw = body as {
        id?: unknown;
        index?: unknown;
        total?: unknown;
        data?: unknown;
      };
      if (
        !raw ||
        typeof raw.id !== "string" ||
        !/^[a-f0-9]{16}$/.test(raw.id) ||
        !Number.isInteger(raw.index) ||
        !Number.isInteger(raw.total) ||
        Number(raw.total) < 1 ||
        Number(raw.total) > 128 ||
        Number(raw.index) < 0 ||
        Number(raw.index) >= Number(raw.total) ||
        typeof raw.data !== "string" ||
        raw.data.length > 256000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)
      ) {
        set.status = 400;
        return { error: "invalid skill chunk" };
      }
      // Bounded staging slots survive Vercel isolates; publish only a complete upload.
      await store.setMeta(
        `skill_upload_${raw.index}`,
        JSON.stringify({ id: raw.id, data: raw.data }),
      );
      if (Number(raw.index) === Number(raw.total) - 1) {
        const parts = await Promise.all(
          Array.from({ length: Number(raw.total) }, (_, i) =>
            store.getMeta(`skill_upload_${i}`),
          ),
        );
        const buffers: Buffer[] = [];
        for (const part of parts) {
          const chunk = JSON.parse(part ?? "null") as {
            id: string;
            data: string;
          } | null;
          if (!chunk || chunk.id !== raw.id) {
            set.status = 409;
            return { error: "incomplete skill upload" };
          }
          buffers.push(Buffer.from(chunk.data, "base64"));
        }
        let catalog: unknown;
        try {
          catalog = JSON.parse(Buffer.concat(buffers).toString("utf8"));
        } catch {
          set.status = 400;
          return { error: "invalid skill JSON" };
        }
        const parsed = skillRow.array().max(10000).safeParse(catalog);
        if (!parsed.success) {
          set.status = 400;
          return { error: "invalid skill catalog" };
        }
        await store.replaceSkills(parsed.data);
      }
      return { ok: true };
    })
    .post("/internal/skills", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const parsed = skillRow
        .array()
        .max(10000)
        .safeParse((body as { skills?: unknown })?.skills);
      if (!parsed.success) {
        set.status = 400;
        return { error: "invalid skill catalog" };
      }
      await store.replaceSkills(parsed.data);
      return { ok: true };
    })
    .get("/internal/skills/commands", async ({ request, set }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return (await store.listSkillCommands()).filter((c) => c.result === null);
    })
    .post("/internal/skills/ack", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const raw = body as { id?: unknown; result?: unknown };
      if (
        !Number.isSafeInteger(raw?.id) ||
        Number(raw.id) < 1 ||
        !raw.result ||
        typeof raw.result !== "object" ||
        Array.isArray(raw.result)
      ) {
        set.status = 400;
        return { error: "invalid acknowledgement" };
      }
      await store.ackSkillCommand(
        Number(raw.id),
        raw.result as Record<string, unknown>,
      );
      await publish();
      return { ok: true };
    })
    .get("/api/guilds/:id/skills", async ({ cookie, set, params }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (
        !guildId.safeParse(params.id).success ||
        !(await guildOk(env, hooks, s.access_token, params.id, s.role))
      ) {
        set.status = 404;
        return { error: "guild not found" };
      }
      return {
        skills: guildSkills(await store.listSkills(), params.id),
        commands: (await store.listSkillCommands()).filter(
          (c) => c.guild_id === params.id,
        ),
      };
    })
    .post("/api/guilds/:id/skills", async ({ cookie, set, params, body }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (
        !guildId.safeParse(params.id).success ||
        !(await guildOk(env, hooks, s.access_token, params.id, s.role))
      ) {
        set.status = 404;
        return { error: "guild not found" };
      }
      const parsed = skillAction.safeParse(body);
      if (!parsed.success) {
        set.status = 400;
        return { error: "invalid skill action" };
      }
      const { action, ...args } = parsed.data;
      const rows = await store.listSkills();
      const existing = guildSkills(rows, params.id).find(
        (r) => r.name === args.name,
      );
      if (action === "import") {
        const source = (parsed.data as { source_guild_id: string })
          .source_guild_id;
        if (!(await guildOk(env, hooks, s.access_token, source, s.role))) {
          set.status = 404;
          return { error: "source guild not found" };
        }
        if (
          !rows.some(
            (r) => r.guild_id === source && r.name === args.name && !r.builtin,
          )
        ) {
          set.status = 404;
          return { error: "source skill not found" };
        }
      }
      if ((action === "create" || action === "import") && existing) {
        set.status = 409;
        return { error: "skill already exists" };
      }
      if ((action === "enabled" || action === "delete") && !existing) {
        set.status = 404;
        return { error: "skill not found" };
      }
      if (action === "delete" && existing?.builtin) {
        set.status = 400;
        return { error: "builtin skills cannot be deleted" };
      }
      const command = await store.enqueueSkillCommand(params.id, action, args);
      await publish();
      return { ok: true, command };
    })
    .post("/internal/artifacts", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const raw =
        body && typeof body === "object"
          ? (body as { sites?: unknown }).sites
          : null;
      const list = Array.isArray(raw) ? raw : [];
      const sites = list
        .map(parseArtifactSite)
        .filter((s): s is ArtifactRow => s !== null);
      await store.replaceArtifacts(sites);
      return { ok: true, n: sites.length };
    })
    .post("/internal/artifacts/ack", async ({ request, set, body }) => {
      if (!requireInternal(request.headers.get("authorization") ?? undefined)) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const raw =
        body && typeof body === "object"
          ? (body as { ids?: unknown }).ids
          : null;
      const ids = Array.isArray(raw)
        ? raw.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
        : [];
      const n = await store.ackArtifactCommands(ids);
      if (n) await publish();
      return { ok: true, n };
    })
    .get("/api/artifacts", async ({ cookie, set }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      const allowed = await accessibleGuildIds(
        env,
        hooks,
        s.access_token,
        s.role,
      );
      const [sites, commands] = await Promise.all([
        store.listArtifacts(),
        store.listArtifactCommands(),
      ]);
      return {
        sites: decorateArtifacts(
          sites.filter((row) => row.guild_id && allowed.has(row.guild_id)),
          commands,
        ),
      };
    })
    .get("/api/guilds/:id/artifacts", async ({ cookie, set, params }) => {
      const s = await requireSession(cookieSid(cookie as never));
      if (!s) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      if (!(await guildOk(env, hooks, s.access_token, params.id, s.role))) {
        set.status = 404;
        return { error: "guild not found" };
      }
      const [sites, commands] = await Promise.all([
        store.listArtifacts(params.id),
        store.listArtifactCommands(),
      ]);
      return { sites: decorateArtifacts(sites, commands) };
    })
    .patch(
      "/api/guilds/:id/artifacts/:token",
      async ({ cookie, set, params, body }) => {
        const s = await requireSession(cookieSid(cookie as never));
        if (!s) {
          set.status = 401;
          return { error: "unauthorized" };
        }
        if (!(await guildOk(env, hooks, s.access_token, params.id, s.role))) {
          set.status = 404;
          return { error: "guild not found" };
        }
        const action = parseArtifactAction(body);
        if (!action) {
          set.status = 400;
          return { error: "action must be month, permanent, or unpermanent" };
        }
        const token = String(params.token ?? "").trim();
        if (!isArtifactToken(token)) {
          set.status = 400;
          return { error: "invalid site token" };
        }
        const site = await store.getArtifact(token);
        if (!site || site.guild_id !== params.id) {
          set.status = 404;
          return { error: "artifact not found" };
        }
        const cmd = await store.enqueueArtifactCommand(
          token,
          params.id,
          action,
        );
        await publish();
        return { ok: true, pending: cmd.action, token };
      },
    )
    .post("/api/guilds/:id/clear", unavailable)
    .post("/api/guilds/:id/retry", unavailable)
    .get("/api/guilds/:id/context", unavailable)
    .get("/api/guilds/:id/channels", unavailable)
    .get("/api/vpn/status", unavailable)
    .get("/api/github/status", unavailable);
}

async function loadUnpublished(store: Store): Promise<string[]> {
  return unpublishedPresetIds(
    parseVisibilityOverrides(await store.getMeta("preset_visibility")),
  );
}

async function loadPremium(store: Store): Promise<Record<string, boolean>> {
  return parsePremiumOverrides(await store.getMeta("preset_premium"));
}

/** Reject a PATCH that picks a Premium-floor preset without the plan. */
function refuseRestrictedPatch(
  role: Role,
  patch: Parameters<typeof patchPresetIds>[0],
  premium: Record<string, boolean>,
): string | null {
  // Includes per-role Multi-Agent presets, not only the main/common ones.
  for (const id of patchPresetIds(patch)) {
    const min = parseRole(effectiveMinRole(id, premium) ?? "");
    if (min && !canSelectPreset(role, min)) {
      return `preset \`${id}\` is Premium / Moderator / Administrator only`;
    }
  }
  return null;
}

/** Unpublished presets stay in the catalog so launch is a toggle, not a deploy. */
function refuseUnpublishedPatch(
  unpublished: string[],
  patch: Parameters<typeof patchPresetIds>[0],
): string | null {
  for (const id of patchPresetIds(patch)) {
    if (unpublished.includes(id)) {
      return `preset \`${id}\` is unpublished`;
    }
  }
  return null;
}

async function guildOk(
  env: WebEnv,
  hooks: AppHooks,
  accessToken: string,
  guildId: string,
  role: Role,
): Promise<boolean> {
  // Moderation scope: an admin/mod may open any server the bot is in, even one
  // they do not share. Everyone else still needs the OAuth intersection.
  // A failed bot-guild fetch falls through to the member check rather than
  // returning false, so a Discord hiccup cannot lock an admin out of a server
  // they are actually in.
  if (canViewAllGuilds(role)) {
    try {
      const bot = hooks.listBotGuilds
        ? await hooks.listBotGuilds()
        : await fetchBotGuilds(env);
      if (bot.some((g) => g.id === guildId)) return true;
    } catch {
      /* fall through to the member check */
    }
  }
  if (hooks.guildAccess) return hooks.guildAccess(accessToken, guildId);
  try {
    const [userG, botG] = await Promise.all([
      fetchUserGuilds(accessToken),
      fetchBotGuilds(env),
    ]);
    return intersectGuilds(userG, botG).some((g) => g.id === guildId);
  } catch {
    return false;
  }
}

function unavailable({ set }: { set: { status?: number | string } }) {
  set.status = 503;
  return { error: "bot control plane unavailable" };
}

function isArtifactToken(token: string): boolean {
  return token.length > 0 && token.length <= 64 && /^[0-9a-fA-F]+$/.test(token);
}

function parseArtifactAction(body: unknown): ArtifactAction | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { action?: unknown }).action;
  if (typeof raw !== "string") return null;
  const mapped =
    raw === "pin"
      ? "permanent"
      : raw === "unpin"
        ? "unpermanent"
        : raw.trim().toLowerCase();
  return isArtifactAction(mapped) ? mapped : null;
}

function parseArtifactSite(raw: unknown): ArtifactRow | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const token = typeof o.token === "string" ? o.token.trim() : "";
  if (!isArtifactToken(token)) return null;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!url) return null;
  const channel_id = typeof o.channel_id === "string" ? o.channel_id : "";
  if (!channel_id) return null;
  const retentionRaw = typeof o.retention === "string" ? o.retention : "ttl";
  const retention: ArtifactRow["retention"] =
    retentionRaw === "month" || retentionRaw === "permanent"
      ? retentionRaw
      : "ttl";
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    token,
    guild_id: typeof o.guild_id === "string" && o.guild_id ? o.guild_id : null,
    channel_id,
    url,
    source_path: typeof o.source_path === "string" ? o.source_path : "",
    created_at_unix: num(o.created_at_unix),
    updated_at_unix: o.updated_at_unix == null ? null : num(o.updated_at_unix),
    expires_at_unix: num(o.expires_at_unix),
    retention,
    bytes: num(o.bytes),
    file_count: num(o.file_count),
  };
}

function decorateArtifacts(
  sites: ArtifactRow[],
  commands: { token: string; action: string }[],
) {
  const now = Math.floor(Date.now() / 1000);
  const pending = new Map<string, string>();
  for (const c of commands) pending.set(c.token, c.action);
  return sites
    .filter(
      (s) =>
        s.retention === "permanent" ||
        s.expires_at_unix === 0 ||
        s.expires_at_unix > now,
    )
    .sort((a, b) => b.created_at_unix - a.created_at_unix)
    .map((s) => ({
      ...s,
      permanent: s.retention === "permanent",
      pending: pending.get(s.token) ?? null,
    }));
}

async function accessibleGuildIds(
  env: WebEnv,
  hooks: AppHooks,
  accessToken: string,
  role: Role,
): Promise<Set<string>> {
  const mine = hooks.listGuilds
    ? await hooks.listGuilds(accessToken)
    : intersectGuilds(
        await fetchUserGuilds(accessToken),
        await fetchBotGuilds(env),
      );
  if (!canViewAllGuilds(role)) return new Set(mine.map((g) => g.id));
  try {
    const all = hooks.listBotGuilds
      ? await hooks.listBotGuilds()
      : await fetchBotGuilds(env);
    return new Set(all.map((g) => g.id));
  } catch {
    return new Set(mine.map((g) => g.id));
  }
}
