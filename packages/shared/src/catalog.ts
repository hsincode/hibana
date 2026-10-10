/**
 * Shared model catalogs.
 * Imported by both the bot and settings API.
 */
export const MODEL_PRESETS = [
  {
    id: "ds-deepseek-flash",
    provider: "deepseek",
    model: "deepseek-flash",
    label: "DeepSeek official / DeepSeek V4.1 Flash",
  },
  {
    id: "grok-4.5",
    provider: "grok_free",
    model: "grok-4.5",
    label: "Grok Free / Grok 4.5",
  },
  {
    id: "grok-4.5-heavy",
    provider: "grok_heavy",
    model: "grok-4.5",
    label: "Grok Heavy / Grok 4.5",
  },
  {
    id: "grok-4.6",
    provider: "grok_free",
    model: "grok-4.6",
    label: "Grok Free / Grok 4.6",
  },
  {
    id: "grok-4.6-heavy",
    provider: "grok_heavy",
    model: "grok-4.6",
    label: "Grok Heavy / Grok 4.6",
  },
  // Unreleased SKU. Catalog id is wired so flipping `published` on the
  // admin screen is enough at launch — no code deploy. Default unpublished.
  {
    id: "grok-4.7-heavy",
    provider: "grok_heavy",
    model: "grok-4.7",
    label: "Grok Heavy / Grok 4.7",
    published: false,
  },
  {
    id: "opus-5",
    provider: "claude_kiro",
    model: "claude-opus-5",
    label: "Claude Kiro / Claude Opus 5",
  },
  {
    id: "opus-5-1",
    provider: "claude_kiro",
    model: "claude-opus-5-1",
    label: "Claude Kiro / Claude Opus 5.1",
    published: false,
  },
  // Unreleased SKU. Catalog id is wired so flipping `published` on the
  // admin screen is enough at launch — no code deploy. Default unpublished.
  {
    id: "opus-5-5",
    provider: "claude_kiro",
    model: "claude-opus-5-5",
    label: "Claude Kiro / Claude Opus 5.5",
    published: false,
  },
  // Gateway wire id is the pinned `claude-sonnet-5` (no date suffix).
  // Already on the Kiro account, so it ships published — /switch and the
  // dashboard can select it without an admin flip.
  {
    id: "sonnet-5",
    provider: "claude_kiro",
    model: "claude-sonnet-5",
    label: "Claude Kiro / Claude Sonnet 5",
  },
  // Not yet on the Kiro or Claude Max group (both /v1/models omit it and a
  // request returns model_not_found, checked 2026-09-29). Wired unpublished so
  // flipping `published` on the admin screen is enough at launch.
  {
    id: "sonnet-5-5",
    provider: "claude_kiro",
    model: "claude-sonnet-5-5",
    label: "Claude Kiro / Claude Sonnet 5.5",
    published: false,
  },
  // Claude Max: own account/key (`CLAUDE_MAX_API_KEY`). Premium / Moderator /
  // Administrator only — PATCH and the dashboard picker both check `min_role`.
  // Catalog id stays `fable-5` after the wire id moved to `claude-fable-5-1`,
  // so saved role presets and the Premium overlay key still match. Reads
  // rewrite the old wire id.
  {
    id: "fable-5",
    provider: "claude_max",
    model: "claude-fable-5-1",
    label: "Claude Max / Claude Fable 5.1",
    min_role: "premium",
  },
  {
    id: "max-opus-5-5",
    provider: "claude_max",
    model: "claude-opus-5-5",
    label: "Claude Max / Claude Opus 5.5",
    min_role: "premium",
  },
  // Anthropic's own API (`ANTHROPIC_API_KEY`), billed per token. A Premium /
  // Moderator / Administrator picks it; `server_shared` then lets every
  // member of a server use the server's pick (decision record: #35).
  {
    id: "anthropic-auto",
    provider: "anthropic",
    model: "auto",
    label: "Anthropic / Auto (Jev)",
    min_role: "premium",
    server_shared: true,
  },
  {
    id: "anthropic-haiku-5-5",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    label: "Anthropic / Claude Haiku 5.5",
    min_role: "premium",
    server_shared: true,
  },
  {
    id: "anthropic-sonnet-5-5",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    label: "Anthropic / Claude Sonnet 5.5",
    min_role: "premium",
    server_shared: true,
  },
  {
    id: "anthropic-opus-5-5",
    provider: "anthropic",
    model: "claude-opus-5-5",
    label: "Anthropic / Claude Opus 5.5",
    min_role: "premium",
    server_shared: true,
  },
  {
    id: "gemini-3.7-flash",
    provider: "codex_gemini",
    model: "gemini-3.7-flash",
    label: "Gemini / Gemini 3.7 Flash",
  },
  // Official wire id is `gemini-3.8-flash` (no bare `gemini-3.8` SKU).
  // Default unpublished; leftover dashboard PATCHes alias via PRESET_ALIASES.
  {
    id: "gemini-3.8-flash",
    provider: "codex_gemini",
    model: "gemini-3.8-flash",
    label: "Gemini / Gemini 3.8 Flash",
    published: false,
  },
  // Unreleased SKUs. Wired now so flipping `published` on the admin
  // screen is enough at launch — no code deploy. Default unpublished.
  {
    id: "gemini-4-pro",
    provider: "codex_gemini",
    model: "gemini-4-pro",
    label: "Gemini / Gemini 4 Pro",
    published: false,
  },
  {
    id: "gemini-4-flash",
    provider: "codex_gemini",
    model: "gemini-4-flash",
    label: "Gemini / Gemini 4 Flash",
    published: false,
  },
  // GPT-5.6 Sol / Luna are retired. Sol now points at GPT-6.1 Sol and Luna at
  // GPT-6 Luna. The old `plus-6-*` / `pro-6-*` / `chatgpt-6-*` ids alias here
  // so a saved preset still resolves. Reads rewrite `gpt-5.6-sol` /
  // `gpt-6-sol` / `gpt-5.6-luna` on Codex Plus, Codex Pro, and ChatGPT.
  {
    id: "sol",
    provider: "codex_plus",
    model: "gpt-6.1-sol",
    label: "Codex Plus / GPT-6.1 Sol",
  },
  {
    id: "plus-luna",
    provider: "codex_plus",
    model: "gpt-6-luna",
    label: "Codex Plus / GPT-6 Luna",
  },
  // Unreleased GPT-6 Astra. Wired now so flipping `published` on the admin
  // screen is enough at launch — no code deploy. Default unpublished.
  {
    id: "plus-astra",
    provider: "codex_plus",
    model: "gpt-6-astra",
    label: "Codex Plus / GPT-6 Astra",
    published: false,
  },
  // Codex Pro: the same GPT models as Codex Plus on a second account
  // (own key / quota), so the id has to say which one a turn is billed to.
  {
    id: "pro-sol",
    provider: "codex_pro",
    model: "gpt-6.1-sol",
    label: "Codex Pro / GPT-6.1 Sol",
  },
  {
    id: "pro-luna",
    provider: "codex_pro",
    model: "gpt-6-luna",
    label: "Codex Pro / GPT-6 Luna",
  },
  {
    id: "pro-astra",
    provider: "codex_pro",
    model: "gpt-6-astra",
    label: "Codex Pro / GPT-6 Astra",
    published: false,
  },
  // Match Codex Pro's model and publication defaults, with independent
  // credentials. Public models are usable by Free users after staff login.
  { id: "chatgpt-sol", provider: "chatgpt", model: "gpt-6.1-sol", label: "ChatGPT / GPT-6.1 Sol" },
  { id: "chatgpt-luna", provider: "chatgpt", model: "gpt-6-luna", label: "ChatGPT / GPT-6 Luna" },
  { id: "chatgpt-astra", provider: "chatgpt", model: "gpt-6-astra", label: "ChatGPT / GPT-6 Astra", published: false },
] as const;

/** Retired DeepSeek preset ids → current catalog id. Dashboard PATCH + leftover rows. */
export const PRESET_ALIASES: Record<string, string> = {
  "ds-v4-flash": "ds-deepseek-flash",
  "ds-v4-pro": "ds-deepseek-flash",
  "ds-v4.1-flash": "ds-deepseek-flash",
  "ds-flash": "ds-deepseek-flash",
  "ds-pro": "ds-deepseek-flash",
  "gemini-3.8": "gemini-3.8-flash",
  // Separate ids only existed so GPT-6 could sit beside GPT-5.6.
  "plus-6-sol": "sol",
  "plus-6-luna": "plus-luna",
  "pro-6-sol": "pro-sol",
  "pro-6-luna": "pro-luna",
  "chatgpt-6-sol": "chatgpt-sol",
  "chatgpt-6-luna": "chatgpt-luna",
};

export function canonicalPresetId(raw: string): string {
  return PRESET_ALIASES[raw] ?? raw;
}

/** Retired wire ids on the accounts that shipped them. Custom and OpenRouter
 *  keep a literal model string — those endpoints are not this catalog. */
const MODEL_WIRE_ALIASES: Record<string, { model: string; providers: readonly string[] }> = {
  "gpt-5.6-sol": { model: "gpt-6.1-sol", providers: ["codex_plus", "codex_pro", "chatgpt"] },
  "gpt-6-sol": { model: "gpt-6.1-sol", providers: ["codex_plus", "codex_pro", "chatgpt"] },
  "gpt-5.6-luna": { model: "gpt-6-luna", providers: ["codex_plus", "codex_pro", "chatgpt"] },
  "claude-fable-5": { model: "claude-fable-5-1", providers: ["claude_max"] },
};

export function canonicalModel(provider: string, model: string): string {
  const alias = MODEL_WIRE_ALIASES[model];
  return alias && alias.providers.includes(provider) ? alias.model : model;
}

/** Not a wire id: Jev picks one of `AUTO_ROUTE_LEVELS` for the conversation. */
export const AUTO_ROUTE_PROVIDER = "anthropic";
export const AUTO_ROUTE_MODEL = "auto";

/** Easiest to hardest (#35). `max` never appears. Since 2026-10-10 the
 *  difficulty alone never picks Sonnet: the middle of the scale runs on Haiku
 *  and the two top levels on Opus. */
export const AUTO_ROUTE_LEVELS = [
  { model: "claude-haiku-5-5", effort: "medium" },
  { model: "claude-haiku-5-5", effort: "high" },
  { model: "claude-haiku-5-5", effort: "xhigh" },
  { model: "claude-opus-5-5", effort: "medium" },
  { model: "claude-opus-5-5", effort: "high" },
] as const;

/** Reached only when the message asks for the model by name (#35). `level` is
 *  the difficulty each one stands for when the nearest effort is picked. */
export const AUTO_ROUTE_REQUEST_ONLY = [
  { model: "claude-sonnet-5-5", effort: "medium", level: 2 },
  { model: "claude-sonnet-5-5", effort: "high", level: 3 },
] as const;

/** Used whenever Jev cannot classify the request. */
export const AUTO_ROUTE_FALLBACK = { model: "claude-haiku-5-5", effort: "high" } as const;

/** Anthropic turns, auto included, run without subagents (#35). */
export function subagentsUnsupported(provider: string | undefined): boolean {
  return provider === AUTO_ROUTE_PROVIDER;
}

export function isAutoRoute(selection: { provider: string; model: string }): boolean {
  return selection.provider === AUTO_ROUTE_PROVIDER && selection.model === AUTO_ROUTE_MODEL;
}

export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
// Accept the old wire/settings alias on reads and writes during migration,
// but new pickers use a separate Ultra mode control.
export const EFFORTS = [...REASONING_EFFORTS, "ultra"] as const;

export const EXA_MODES = ["on", "off", "auto"] as const;

/**
 * Keyword triggers that fire without a mention. Keep spellings in sync with
 * the bot `src/triggers.rs` `BUILTIN_TRIGGERS`. The dashboard lists these so
 * a guild can disable / rename them; the live set is `disabled_triggers` +
 * `extra_triggers` on the guild row (snapshot), not this constant.
 */
export const BUILTIN_TRIGGERS = [
  "hibana",
  "ひばな",
  "ヒバナ",
  "火花",
  "deepseek",
  "ds",
  "ディープシーク",
  "くじら",
  "クジラ",
  "鯨",
] as const;

/** Same cap as the bot (`TRIGGER_WORD_MAX_CHARS`) so PATCH cannot store a word the match loop will drop. */
export const TRIGGER_WORD_MAX_CHARS = 32;
/** Same cap as the bot (`TRIGGER_EXTRA_MAX`). */
export const TRIGGER_EXTRA_MAX = 32;

/** Grok Free is kept in `MODEL_PRESETS` for leftover guild rows, but is not a pick. */
export const SELECTABLE_PRESETS = MODEL_PRESETS.filter(
  (p) => p.provider !== "grok_free",
);

export const PRESET_IDS = SELECTABLE_PRESETS.map((p) => p.id);

export function isPresetId(raw: string): boolean {
  return SELECTABLE_PRESETS.some((p) => p.id === canonicalPresetId(raw));
}

/** Catalog floor role. `null` = anyone may pick it. Dashboard overlay is `isPremium`. */
export function minRoleForPreset(id: string): string | null {
  const p = MODEL_PRESETS.find((x) => x.id === id) as
    | { min_role?: string }
    | undefined;
  const r = p?.min_role?.trim().toLowerCase();
  return r || null;
}

type CatalogFlags = { published?: boolean; server_shared?: boolean };

/** The Premium floor of these presets applies to whoever saves the setting,
 *  not to the members of a server that selected one. */
export function serverShared(id: string): boolean {
  const p = MODEL_PRESETS.find((x) => x.id === id) as CatalogFlags | undefined;
  return p?.server_shared === true;
}

/** Catalog default. Missing `published` = public. Grok Free is not selectable. */
export function catalogPublished(id: string): boolean {
  const p = MODEL_PRESETS.find((x) => x.id === id) as CatalogFlags | undefined;
  return p?.published !== false;
}

/** Catalog default. Missing `min_role` = anyone. Claude Max ships Premium-floor. */
export function catalogPremium(id: string): boolean {
  return minRoleForPreset(id) === "premium";
}

function parseBooleanOverrides(raw: string | null): Record<string, boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPresetId(k) && typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Dashboard overrides keyed by preset id. Missing key = catalog default. */
export function parseVisibilityOverrides(
  raw: string | null,
): Record<string, boolean> {
  return parseBooleanOverrides(raw);
}

/** Dashboard Premium-floor overrides. Missing key = catalog default. */
export function parsePremiumOverrides(
  raw: string | null,
): Record<string, boolean> {
  return parseBooleanOverrides(raw);
}

/** Effective unpublished ids after applying dashboard overrides onto catalog defaults. */
export function unpublishedPresetIds(
  overrides: Record<string, boolean>,
): string[] {
  return SELECTABLE_PRESETS.filter((p) => {
    if (Object.prototype.hasOwnProperty.call(overrides, p.id))
      return overrides[p.id] === false;
    return !catalogPublished(p.id);
  }).map((p) => p.id);
}

export function isPublished(
  id: string,
  overrides: Record<string, boolean>,
): boolean {
  if (!isPresetId(id)) return false;
  if (Object.prototype.hasOwnProperty.call(overrides, id))
    return overrides[id] === true;
  return catalogPublished(id);
}

export function isPremium(
  id: string,
  overrides: Record<string, boolean>,
): boolean {
  if (!isPresetId(id)) return false;
  if (Object.prototype.hasOwnProperty.call(overrides, id))
    return overrides[id] === true;
  return catalogPremium(id);
}

/** Effective Premium-floor ids after applying dashboard overrides onto catalog defaults. */
export function premiumPresetIds(overrides: Record<string, boolean>): string[] {
  return SELECTABLE_PRESETS.filter((p) => isPremium(p.id, overrides)).map(
    (p) => p.id,
  );
}

/** Live floor after dashboard overlay. `null` = anyone. */
export function effectiveMinRole(
  id: string,
  overrides: Record<string, boolean>,
): string | null {
  return isPremium(id, overrides) ? "premium" : null;
}

/** USD per million tokens on Anthropic's own API (`provider: "anthropic"`).
 *  Source: https://platform.claude.com/docs/en/about-claude/pricing, read
 *  2026-10-09 (#44). Hibana only sets 1-hour cache breakpoints and sends no
 *  server tools, so 5-minute writes and per-search fees are not priced. Update
 *  this table by hand when Anthropic changes its prices. */
export type AnthropicPrice = {
  input: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
};
export const ANTHROPIC_PRICES: Record<
  string,
  AnthropicPrice & { long?: { above: number } & AnthropicPrice }
> = {
  "claude-opus-5-5": { input: 4, cache_write_1h: 8, cache_read: 0.2, output: 20 },
  "claude-sonnet-5-5": { input: 2, cache_write_1h: 4, cache_read: 0.1, output: 10 },
  // Haiku 5.5 bills a whole request at the higher row once its prompt,
  // cache reads and writes included, is over 100,000 tokens.
  "claude-haiku-5-5": {
    input: 0.1, cache_write_1h: 0.2, cache_read: 0.01, output: 0.5,
    long: { above: 100_000, input: 0.5, cache_write_1h: 1, cache_read: 0.05, output: 2.5 },
  },
};

/** Estimated USD for one Anthropic request, or `undefined` for a model the
 *  table does not price. `prompt` counts uncached input plus cache reads and
 *  writes, as the bot's normalized usage does. */
export function anthropicCost(
  model: string,
  usage: { prompt: number; cache_read: number; cache_write: number; output: number },
): number | undefined {
  const row = ANTHROPIC_PRICES[model];
  if (!row) return undefined;
  const price = row.long && usage.prompt > row.long.above ? row.long : row;
  const uncached = Math.max(0, usage.prompt - usage.cache_read - usage.cache_write);
  return (
    uncached * price.input +
    usage.cache_write * price.cache_write_1h +
    usage.cache_read * price.cache_read +
    usage.output * price.output
  ) / 1_000_000;
}
