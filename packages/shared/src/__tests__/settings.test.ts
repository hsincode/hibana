import { expect, test } from "bun:test";
import {
  normalizeGuild,
  normalizeUserOverride,
  guildPatchSchema,
  userOverridePatchSchema,
  emptyGuild,
  applyPatch,
  applyUserOverridePatch,
  emptyUserOverride,
  isEmptyUserOverride,
  settingsDefaults,
  SUBAGENT_MODES,
  defaultMultiAgentRoles,
  patchPresetIds,
  subagentMode,
  subagentModePatch,
  DEFAULT_TEXT_MODEL,
  TEXT_MODEL_EFFORTS,
  isTextModelPreset,
  textModelSelection,
  APP_SETTING_KEYS,
  appSettingsDefaults,
  appSettingsPatchSchema,
  applyAppSettingsPatch,
  emptyAppSettings,
  initialAppSettings,
  normalizeAppSettings,
  type GuildRow,
  type UserOverrideRow,
  type UserOverridePatch,
} from "../settings";

test("PROVIDER=refuseless seeds new rows with its first preset, like the bot", () => {
  expect(settingsDefaults({ PROVIDER: "refuseless" }).selection).toEqual({
    provider: "refuseless",
    model: "glm-5.3-abliterated",
    effort: "high",
  });
  expect(
    settingsDefaults({
      PROVIDER: "refuseless",
      LLM_MODEL: "deepseek-v4.1-flash-abliterated",
    }).selection,
  ).toEqual({
    provider: "refuseless",
    model: "deepseek-v4.1-flash-abliterated",
    effort: "max",
  });
});

test("GPT-6.1 Terra presets select Terra on each GPT account without changing defaults (#132)", () => {
  for (const [preset, provider] of [
    ["plus-terra", "codex_plus"],
    ["pro-terra", "codex_pro"],
    ["chatgpt-terra", "chatgpt"],
  ])
    expect(applyPatch(emptyGuild(), { preset }).selection).toEqual({
      provider,
      model: "gpt-6.1-terra",
      effort: "max",
    });
  // Terra is listed after Luna, so the provider defaults stay where they were.
  expect(settingsDefaults({}).selection?.model).toBe("gpt-6-luna");
  expect(settingsDefaults({ PROVIDER: "codex_pro" }).selection?.model).toBe(
    "gpt-6.1-sol",
  );
  expect(settingsDefaults({ PROVIDER: "chatgpt" }).selection?.model).toBe(
    "gpt-6.1-sol",
  );
});

test("new and legacy settings contain concrete values and preserve false, zero and empty lists", () => {
  const defaults = settingsDefaults({
    PROVIDER: "deepseek",
    LLM_EFFORT: "low",
    JEV_ENABLED: "false",
    ULTRA_MODE: "true",
    EXTRA_TRIGGERS: "hello",
    LLM_TEMPERATURE: "1",
  });
  const migrated = normalizeGuild(
    {
      selection: null,
      effort: null,
      ultra_mode: null,
      // An app setting since #161: left out of the server's row.
      temperature: 0,
      jev_enabled: false,
      extra_triggers: [],
    } as never,
    defaults,
  );
  expect(
    Object.values(migrated).every((v) => v !== null && v !== undefined),
  ).toBe(true);
  expect(migrated.selection).toEqual({
    provider: "deepseek",
    model: "deepseek-flash",
    effort: "low",
  });
  expect(migrated.ultra_mode).toBe(true);
  expect("temperature" in migrated).toBe(false);
  expect(migrated.jev_enabled).toBe(false);
  expect(migrated.extra_triggers).toEqual([]);
  expect(normalizeGuild(migrated, emptyGuild())).toEqual(migrated);
  expect(Object.values(emptyUserOverride()).every((v) => v === null)).toBe(
    true,
  );
  expect(isEmptyUserOverride(emptyUserOverride())).toBe(true);
  expect(applyPatch(migrated, { preset: "reset" }, defaults).selection).toEqual(
    defaults.selection,
  );
});

test("switching models writes the recommended effort unless explicitly selected", () => {
  for (const patch of [applyPatch, applyUserOverridePatch]) {
    const row = patch(emptyGuild(), { preset: "opus-5" });
    expect(row.effort).toBe("high");
    expect(row.selection?.effort).toBe("high");
    expect(
      patch(emptyGuild(), { preset: "opus-5", effort: "low" }).effort,
    ).toBe("low");
    const sonnet = patch(emptyGuild(), { preset: "sonnet-5" });
    expect(sonnet.selection).toEqual({
      provider: "claude_kiro",
      model: "claude-sonnet-5",
      effort: "high",
    });
    expect(sonnet.effort).toBe("high");
  }
});
test("retired settings are rejected on writes and stripped from legacy reads", () => {
  for (const key of [
    "advisor",
    "advisor_effort",
    "advisor_skip_strong",
    "router_enabled",
    "router_classifier",
    "harness",
    "crack_v4_flash",
    "crack_profile",
    "crack_v4_flash_enhanced",
    "crack_v4_pro",
    "crack_v4_pro_profile",
    "crack_v4_pro_enhanced",
    "crack_opus",
    "crack_opus_profile",
    "crack_opus_enhanced",
    // Second-pass grading and Codex speed=fast. Old rows drop the keys on read.
    "verify_enabled",
    "fast_enabled",
  ]) {
    expect(guildPatchSchema.safeParse({ [key]: true }).success).toBe(false);
    expect(key in normalizeGuild({ ...emptyGuild(), [key]: true })).toBe(false);
    expect(userOverridePatchSchema.safeParse({ [key]: null }).success).toBe(
      false,
    );
  }
  const legacy = {
    ...emptyGuild(),
    advisor: "sol",
    router_enabled: true,
    harness: "claude",
    verify_enabled: true,
    fast_enabled: true,
  };
  expect("advisor" in normalizeGuild(legacy)).toBe(false);
  expect("router_enabled" in normalizeGuild(legacy)).toBe(false);
  expect("harness" in normalizeGuild(legacy)).toBe(false);
  expect("verify_enabled" in normalizeGuild(legacy)).toBe(false);
  expect("fast_enabled" in normalizeGuild(legacy)).toBe(false);
  expect(
    normalizeUserOverride({
      selection: null,
      context: null,
      advisor: "sol",
    } as never),
  ).toEqual(emptyUserOverride());
});
test("subagent preset can be fixed and reset to automatic selection", () => {
  const fixed = applyPatch(
    emptyGuild(),
    guildPatchSchema.parse({
      subagent_model: { mode: "fixed", preset: "sol" },
    }),
  );
  expect(fixed.subagent_model).toEqual({ mode: "fixed", preset: "sol" });
  expect(
    applyPatch(fixed, guildPatchSchema.parse({ subagent_model: null }))
      .subagent_model,
  ).toEqual({ mode: "auto" });
  expect(
    guildPatchSchema.safeParse({
      subagent_model: { mode: "fixed", preset: "not-a-model" },
    }).success,
  ).toBe(false);
  expect(
    applyPatch(
      fixed,
      guildPatchSchema.parse({
        subagent_model: { mode: "fixed", preset: "ds-v4-flash" },
      }),
    ).subagent_model,
  ).toEqual({ mode: "fixed", preset: "ds-deepseek-flash" });
});
test("Jev settings preserve false and materialize default values", () => {
  expect(normalizeGuild({}).jev_enabled).toBe(true);
  expect(normalizeUserOverride({}).jev_enabled).toBeNull();
  for (const value of [true, false, null]) {
    const patch = { jev_enabled: value };
    expect(
      applyPatch(emptyGuild(), guildPatchSchema.parse(patch)).jev_enabled,
    ).toBe(value ?? true);
    const user = applyUserOverridePatch(
      emptyUserOverride(),
      userOverridePatchSchema.parse(patch),
    );
    // null is デフォルト: it must not be filled with the process default.
    expect(user.jev_enabled).toBe(value);
    expect(isEmptyUserOverride(user)).toBe(value == null);
  }
  expect(guildPatchSchema.safeParse({ jev_enabled: "false" }).success).toBe(
    false,
  );
  expect(
    userOverridePatchSchema.safeParse({ jev_enabled: "false" }).success,
  ).toBe(false);
});
test("clearing effort is supported and does not alter unrelated settings", () => {
  const row = applyPatch(emptyGuild(), { preset: "sol", effort: "ultra" });
  expect(row.selection?.effort).toBe("max");
  expect(row.ultra_mode).toBe(true);
  expect(
    applyPatch(row, guildPatchSchema.parse({ effort: null })).selection?.effort,
  ).toBe("max");
});

test("Ultra migrates independently from effort, including concrete model defaults and resets", () => {
  function check<T extends GuildRow | UserOverrideRow>(
    empty: () => T,
    patch: (
      row: T,
      patch: Pick<
        UserOverridePatch,
        "preset" | "effort" | "ultra_mode" | "subagent_effort"
      >,
    ) => T,
    normalize: (raw: Partial<T>) => T,
  ) {
    let row = patch(empty(), { effort: "ultra" });
    expect(row.selection?.model).toBe("gpt-6-luna");
    expect(row.effort).toBe("max");
    expect(row.ultra_mode).toBe(true);
    row = patch(row, { effort: "low" });
    expect(row.effort).toBe("low");
    expect(row.ultra_mode).toBe(true);
    row = patch(row, { preset: "sol", effort: null });
    expect(row.effort).toBe("max");
    expect(row.selection?.effort).toBe("max");
    expect(row.ultra_mode).toBe(true);
    row = patch(row, { ultra_mode: false });
    expect(row.ultra_mode).toBe(false);
    row = patch(row, { effort: "ultra" });
    expect(row.ultra_mode).toBe(true);
    const legacy = normalize({
      ...empty(),
      effort: null,
      ultra_mode: null,
      selection: {
        provider: "codex_plus",
        model: "gpt-5.6-sol",
        effort: "ultra",
      },
    });
    expect(legacy.effort).toBe("max");
    expect(legacy.ultra_mode).toBe(true);
    expect(normalize(legacy)).toEqual(legacy);
    expect(
      patch(row, { subagent_effort: { mode: "fixed", effort: "ultra" } })
        .subagent_effort,
    ).toEqual({ mode: "fixed", effort: "max" });
    expect(
      patch(row, { effort: null, ultra_mode: null, preset: "reset" })
        .ultra_mode,
    ).toBe(false);
  }
  check(emptyGuild, applyPatch, normalizeGuild);
  const personal = applyUserOverridePatch(emptyUserOverride(), {
    effort: "ultra",
  });
  expect(personal.selection).toBeNull();
  expect(personal.effort).toBe("max");
  expect(personal.ultra_mode).toBe(true);
  expect(
    applyUserOverridePatch(personal, {
      preset: "reset",
      effort: null,
      ultra_mode: null,
    }),
  ).toEqual(emptyUserOverride());
  expect(
    isEmptyUserOverride(
      applyUserOverridePatch(emptyUserOverride(), { ultra_mode: false }),
    ),
  ).toBe(false);
  expect(
    isEmptyUserOverride(
      applyUserOverridePatch(emptyUserOverride(), { effort: "low" }),
    ),
  ).toBe(false);
  for (const schema of [guildPatchSchema, userOverridePatchSchema]) {
    expect(schema.safeParse({ ultra_mode: "true" }).success).toBe(false);
    expect(schema.safeParse({ ultra_mode: null, effort: "low" }).success).toBe(
      true,
    );
  }
});

test("action-selection mode is independent and saves explicit defaults", () => {
  expect(normalizeGuild({}).jev_task_enabled).toBe(false);
  expect(normalizeUserOverride({}).jev_task_enabled).toBeNull();
  for (const value of [true, false, null]) {
    const patch = { jev_task_enabled: value };
    const guild = applyPatch(
      { ...emptyGuild(), jev_enabled: false },
      guildPatchSchema.parse(patch),
    );
    expect(guild.jev_task_enabled).toBe(value ?? false);
    expect(guild.jev_enabled).toBe(false);
    const personal = applyUserOverridePatch(
      emptyUserOverride(),
      userOverridePatchSchema.parse(patch),
    );
    expect(personal.jev_task_enabled).toBe(value);
    expect(personal.jev_enabled).toBeNull();
    expect(isEmptyUserOverride(personal)).toBe(value == null);
  }
  for (const value of ["false", 1, {}]) {
    expect(
      guildPatchSchema.safeParse({ jev_task_enabled: value }).success,
    ).toBe(false);
    expect(
      userOverridePatchSchema.safeParse({ jev_task_enabled: value }).success,
    ).toBe(false);
  }
});

test("retired account selections become concrete defaults without affecting other accounts", () => {
  for (const preset of ["sale-sol", "sale-terra"]) {
    expect(guildPatchSchema.safeParse({ preset }).success).toBe(false);
    expect(userOverridePatchSchema.safeParse({ preset }).success).toBe(false);
    expect(
      guildPatchSchema.safeParse({ subagent_model: { mode: "fixed", preset } })
        .success,
    ).toBe(false);
    const legacy = {
      ...emptyGuild(),
      selection: { provider: "codex_sale", model: "gpt-5.6-sol" },
      subagent_model: { mode: "fixed" as const, preset },
    };
    expect(normalizeGuild(legacy).selection).toEqual(emptyGuild().selection);
    expect(normalizeGuild(legacy).subagent_model).toEqual({ mode: "auto" });
    expect(normalizeUserOverride(legacy).selection).toBeNull();
    expect(normalizeUserOverride(legacy).subagent_model).toBeNull();
  }
  expect(
    normalizeGuild({
      selection: { provider: "opencode_go", model: "deepseek-v4-flash" },
    }).selection,
  ).toEqual(emptyGuild().selection);
  expect(
    normalizeUserOverride({
      selection: { provider: "opencode_go", model: "deepseek-v4-flash" },
    }).selection,
  ).toBeNull();
  for (const provider of ["codex_plus", "codex_pro", "chatgpt"]) {
    const selection = { provider, model: "gpt-5.6-sol", effort: "high" };
    const migrated = { ...selection, model: "gpt-6.1-sol" };
    expect(normalizeGuild({ selection }).selection).toEqual(migrated);
    expect(normalizeUserOverride({ selection }).selection).toEqual(migrated);
    expect(
      normalizeGuild({ selection: { ...selection, model: "gpt-5.6-luna" } })
        .selection?.model,
    ).toBe("gpt-6-luna");
    expect(
      normalizeGuild({ selection: { ...selection, model: "gpt-6-sol" } })
        .selection,
    ).toEqual(migrated);
  }
  // Custom endpoints are not this catalog, so a literal retired id stays.
  for (const provider of ["openrouter", "custom"]) {
    const selection = { provider, model: "gpt-5.6-sol", effort: "high" };
    expect(normalizeGuild({ selection }).selection).toEqual(selection);
    expect(normalizeUserOverride({ selection }).selection).toEqual(selection);
  }
  expect(
    normalizeGuild({
      selection: {
        provider: "claude_max",
        model: "claude-fable-5",
        effort: "medium",
      },
    }).selection,
  ).toEqual({
    provider: "claude_max",
    model: "claude-fable-5-1",
    effort: "medium",
  });
  expect(settingsDefaults({ LLM_MODEL: "gpt-5.6-luna" }).selection?.model).toBe(
    "gpt-6-luna",
  );
  expect(
    applyPatch(emptyGuild(), { preset: "plus-6-luna" }).selection?.model,
  ).toBe("gpt-6-luna");
  expect(
    applyPatch(emptyGuild(), { preset: "max-opus-5-5" }).selection,
  ).toMatchObject({
    provider: "claude_max",
    model: "claude-opus-5-5",
    effort: "high",
  });
});

test("legacy fixed subagent models migrate and explicit policies survive normalization", () => {
  const legacy = { selection: null, subagent_preset: "ds-v4-flash" };
  expect(normalizeGuild(legacy).subagent_model).toEqual({
    mode: "fixed",
    preset: "ds-deepseek-flash",
  });
  expect(normalizeUserOverride(legacy).subagent_model).toEqual({
    mode: "fixed",
    preset: "ds-deepseek-flash",
  });
  expect(
    normalizeGuild({ ...legacy, subagent_model: null }).subagent_model,
  ).toEqual({ mode: "auto" });
  expect("subagent_preset" in normalizeGuild(legacy)).toBe(false);
  for (const mode of ["auto", "same"] as const) {
    const row = applyUserOverridePatch(emptyUserOverride(), {
      subagent_model: { mode },
      subagent_effort: { mode },
    });
    expect(normalizeUserOverride(row)).toEqual(row);
    expect(isEmptyUserOverride(row)).toBe(false);
  }
  for (const schema of [guildPatchSchema, userOverridePatchSchema]) {
    expect(
      schema.safeParse({ subagent_model: { mode: "fixed" } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ subagent_model: { mode: "auto", preset: "sol" } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({
        subagent_effort: { mode: "fixed", effort: "invalid" },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ subagent_effort: { mode: "fixed", effort: "high" } })
        .success,
    ).toBe(true);
  }
});

test("subagent enable migrates old modes and persists independently for guild and personal settings", () => {
  expect(normalizeGuild({ ultra_mode: false }).subagent_enabled).toBe(true);
  expect(normalizeGuild({ ultra_mode: true }).subagent_enabled).toBe(true);
  expect(
    normalizeGuild({ subagent_enabled: false, ultra_mode: true })
      .subagent_enabled,
  ).toBe(false);
  // A personal Ultra flag does not invent the other switches.
  expect(
    normalizeUserOverride({ ultra_mode: false }).subagent_enabled,
  ).toBeNull();
  expect(
    normalizeUserOverride({ ultra_mode: true }).subagent_enabled,
  ).toBeNull();
  expect(
    normalizeUserOverride({ subagent_enabled: false, ultra_mode: true })
      .subagent_enabled,
  ).toBe(false);
  for (const schema of [guildPatchSchema, userOverridePatchSchema]) {
    expect(schema.safeParse({ subagent_enabled: "off" }).success).toBe(false);
  }
  const disabled = applyPatch(emptyGuild(), {
    subagent_enabled: false,
    ultra_mode: false,
  });
  expect(disabled.subagent_enabled).toBe(false);
  expect(applyPatch(disabled, { effort: "high" }).subagent_enabled).toBe(false);
  expect(
    applyPatch(disabled, { subagent_enabled: null }).subagent_enabled,
  ).toBe(true);
  const personalOff = applyUserOverridePatch(emptyUserOverride(), {
    subagent_enabled: false,
    ultra_mode: false,
  });
  expect(personalOff.subagent_enabled).toBe(false);
  expect(
    applyUserOverridePatch(personalOff, { effort: "high" }).subagent_enabled,
  ).toBe(false);
  expect(
    applyUserOverridePatch(personalOff, { subagent_enabled: null })
      .subagent_enabled,
  ).toBeNull();
  expect(settingsDefaults({ SUBAGENT_ENABLED: "false" }).subagent_enabled).toBe(
    false,
  );
});

test("Multi-Agent is an Ultra superset that older ultra-only writes can leave", () => {
  expect(normalizeUserOverride({ ultra_mode: true }).multi_agent).toBeNull();
  expect(
    normalizeUserOverride({ ultra_mode: false, multi_agent: true }).ultra_mode,
  ).toBe(true);
  for (const [normalize, patch, schema] of [
    [normalizeGuild, applyPatch, guildPatchSchema],
  ] as const) {
    // Rows saved before the field existed materialize the concrete default.
    expect(normalize({ ultra_mode: true }).multi_agent).toBe(false);
    expect(normalize({ ultra_mode: false, multi_agent: true }).ultra_mode).toBe(
      true,
    );
    expect(schema.safeParse({ multi_agent: "on" }).success).toBe(false);
    expect(schema.safeParse({ multi_agent: null }).success).toBe(true);
    for (const mode of SUBAGENT_MODES) {
      const row = patch(emptyGuild(), subagentModePatch(mode));
      expect(subagentMode(row)).toBe(mode);
    }
    const multi = patch(emptyGuild(), { multi_agent: true });
    expect([multi.ultra_mode, subagentMode(multi)]).toEqual([true, "multi"]);
    // `/switch ultra:off` and set_bot_model only know ultra_mode.
    expect(subagentMode(patch(multi as GuildRow, { ultra_mode: false }))).toBe(
      "on",
    );
    expect(subagentMode(patch(multi as GuildRow, { ultra_mode: true }))).toBe(
      "multi",
    );
    expect(subagentMode(patch(multi as GuildRow, { multi_agent: false }))).toBe(
      "ultra",
    );
    expect(
      subagentMode(
        patch(multi as GuildRow, { ultra_mode: null, preset: "reset" }),
      ),
    ).toBe("on");
    expect(
      subagentMode(
        patch(multi as GuildRow, { ultra_mode: false, multi_agent: true }),
      ),
    ).toBe("multi");
    // Disabling subagents wins without discarding the saved Multi choice.
    const off = patch(multi as GuildRow, { subagent_enabled: false });
    expect([subagentMode(off), off.multi_agent]).toEqual(["off", true]);
    expect(
      subagentMode(patch(off as GuildRow, { subagent_enabled: true })),
    ).toBe("multi");
  }
  expect(
    isEmptyUserOverride({
      ...emptyUserOverride(),
      selection: null,
      effort: null,
      service_tier: null,
      subagent_enabled: null,
      ultra_mode: null,
      multi_agent: true,
      subagent_model: null,
      subagent_effort: null,
      jev_enabled: null,
      jev_task_enabled: null,
      context: null,
    }),
  ).toBe(false);
  const seeded = settingsDefaults({ MULTI_AGENT: "true" });
  expect([seeded.multi_agent, seeded.ultra_mode, subagentMode(seeded)]).toEqual(
    [true, true, "multi"],
  );
  expect(settingsDefaults({}).multi_agent).toBe(false);
  expect(() => settingsDefaults({ MULTI_AGENT: "maybe" })).toThrow(
    "MULTI_AGENT must be a boolean",
  );
});

test("Service Tier defaults and validation are shared across guild and personal settings", () => {
  for (const schema of [guildPatchSchema, userOverridePatchSchema]) {
    expect(schema.safeParse({ service_tier: "invalid" }).success).toBe(false);
    for (const service_tier of [
      "auto",
      "default",
      "priority",
      "flex",
      "ultrafast",
      null,
    ])
      expect(schema.safeParse({ service_tier }).success).toBe(true);
  }
  expect(normalizeGuild({}).service_tier).toBe("auto");
  expect(normalizeUserOverride({}).service_tier).toBeNull();
  const guild = applyPatch(emptyGuild(), { service_tier: "priority" });
  expect(applyPatch(guild, { preset: "sol" }).service_tier).toBe("priority");
  expect(applyPatch(guild, { service_tier: null }).service_tier).toBe("auto");
  expect(
    applyUserOverridePatch(emptyUserOverride(), { service_tier: "flex" })
      .service_tier,
  ).toBe("flex");
});

test("Multi-Agent role policies default to the common policy, merge per field and drop only invalid roles", () => {
  expect(normalizeUserOverride({}).multi_agent_roles).toBeNull();
  expect(
    applyUserOverridePatch(emptyUserOverride(), { multi_agent_roles: null })
      .multi_agent_roles,
  ).toBeNull();
  for (const [normalize, patch] of [[normalizeGuild, applyPatch]] as const) {
    expect(normalize({}).multi_agent_roles).toEqual(defaultMultiAgentRoles());
    let row = patch(emptyGuild(), {
      multi_agent_roles: {
        reviewer: { model: { mode: "fixed", preset: "sol" } },
      },
    });
    row = patch(row as GuildRow, {
      multi_agent_roles: {
        reviewer: { effort: { mode: "fixed", effort: "ultra" } },
        explorer: { model: { mode: "same" } },
      },
    });
    expect(row.multi_agent_roles).toEqual({
      explorer: { model: { mode: "same" }, effort: { mode: "default" } },
      worker: { model: { mode: "default" }, effort: { mode: "default" } },
      // Legacy ultra effort keeps meaning max, like the common policy.
      reviewer: {
        model: { mode: "fixed", preset: "sol" },
        effort: { mode: "fixed", effort: "max" },
      },
    });
    expect(
      patch(row as GuildRow, { multi_agent_roles: null }).multi_agent_roles,
    ).toEqual(defaultMultiAgentRoles());
    // One stale preset id must not discard the other roles' choices.
    const stale = normalize({
      multi_agent_roles: {
        reviewer: {
          model: { mode: "fixed", preset: "retired-model" },
          effort: { mode: "same" },
        },
        worker: {
          model: { mode: "fixed", preset: "sol" },
          effort: { mode: "default" },
        },
      } as never,
    });
    expect(stale.multi_agent_roles!.reviewer).toEqual({
      model: { mode: "default" },
      effort: { mode: "same" },
    });
    expect(stale.multi_agent_roles!.worker.model).toEqual({
      mode: "fixed",
      preset: "sol",
    });
  }
  for (const schema of [guildPatchSchema, userOverridePatchSchema]) {
    expect(
      schema.safeParse({ multi_agent_roles: { planner: {} } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        multi_agent_roles: { reviewer: { model: { mode: "auto" } } },
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        multi_agent_roles: {
          reviewer: { model: { mode: "fixed", preset: "nope" } },
        },
      }).success,
    ).toBe(false);
  }
  expect(
    isEmptyUserOverride({
      ...emptyUserOverride(),
      selection: null,
      effort: null,
      service_tier: null,
      subagent_enabled: null,
      ultra_mode: null,
      multi_agent: null,
      multi_agent_roles: defaultMultiAgentRoles(),
      subagent_model: null,
      subagent_effort: null,
      jev_enabled: null,
      jev_task_enabled: null,
      context: null,
    }),
  ).toBe(false);
  expect(
    patchPresetIds({
      preset: "sol",
      subagent_model: { mode: "fixed", preset: "pro-luna" },
      multi_agent_roles: {
        reviewer: { model: { mode: "fixed", preset: "fable-5" } },
        worker: { model: { mode: "same" } },
      },
    }),
  ).toEqual(["sol", "pro-luna", "fable-5"]);
});

test("Text Generation Model is a server setting: Haiku 5.5 medium by default, Anthropic API presets only (#118)", () => {
  expect(DEFAULT_TEXT_MODEL).toEqual({
    preset: "anthropic-haiku-5-5",
    effort: "medium",
  });
  expect(emptyGuild().text_model).toEqual(DEFAULT_TEXT_MODEL);
  expect(settingsDefaults({}).text_model).toEqual(DEFAULT_TEXT_MODEL);
  expect(textModelSelection(DEFAULT_TEXT_MODEL)).toEqual({
    provider: "anthropic",
    model: "claude-haiku-5-5",
    effort: "medium",
  });

  // Anthropic API presets other than Auto; not Workspace, not other providers.
  expect(isTextModelPreset("anthropic-haiku-5-5")).toBe(true);
  expect(isTextModelPreset("anthropic-sonnet-5-5")).toBe(true);
  expect(isTextModelPreset("anthropic-opus-5-5")).toBe(true);
  expect(isTextModelPreset("anthropic-auto")).toBe(false);
  expect(isTextModelPreset("anthropic-workspace-haiku-5-5")).toBe(false);
  expect(isTextModelPreset("max-opus-5-5")).toBe(false);
  expect(isTextModelPreset("sol")).toBe(false);
  expect(isTextModelPreset("nope")).toBe(false);
  // `none` is left out: Claude 5.x cannot switch thinking off.
  expect([...TEXT_MODEL_EFFORTS]).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  const sonnet = { preset: "anthropic-sonnet-5-5", effort: "high" } as const;
  expect(guildPatchSchema.safeParse({ text_model: sonnet }).success).toBe(true);
  expect(guildPatchSchema.safeParse({ text_model: null }).success).toBe(true);
  for (const bad of [
    { preset: "anthropic-auto", effort: "medium" },
    { preset: "anthropic-workspace-haiku-5-5", effort: "medium" },
    { preset: "sol", effort: "medium" },
    { preset: "anthropic-haiku-5-5", effort: "none" },
    { preset: "anthropic-haiku-5-5" },
    { preset: "anthropic-haiku-5-5", effort: "medium", extra: 1 },
  ])
    expect(guildPatchSchema.safeParse({ text_model: bad }).success).toBe(false);
  // A personal row does not carry it: it is set per server (#118).
  expect(
    userOverridePatchSchema.safeParse({ text_model: sonnet }).success,
  ).toBe(false);

  // Writing it changes nothing else; null returns to the default.
  const base = emptyGuild();
  const written = applyPatch(base, { text_model: sonnet });
  expect(written.text_model).toEqual(sonnet);
  expect({ ...written, text_model: base.text_model }).toEqual(
    normalizeGuild(base),
  );
  expect(applyPatch(written, { text_model: null }).text_model).toEqual(
    DEFAULT_TEXT_MODEL,
  );
  expect(applyPatch(written, { thread_only: true }).text_model).toEqual(sonnet);

  // A row stored before the setting existed, or holding a preset that no
  // longer qualifies, reads as the default.
  const { text_model: _omitted, ...legacy } = emptyGuild();
  expect(normalizeGuild(legacy).text_model).toEqual(DEFAULT_TEXT_MODEL);
  expect(
    normalizeGuild({
      text_model: { preset: "anthropic-gone", effort: "high" },
    } as never).text_model,
  ).toEqual(DEFAULT_TEXT_MODEL);
  expect(normalizeGuild(written).text_model).toEqual(sonnet);

  // The plan and visibility checks of the API and the bot see the preset.
  expect(patchPresetIds({ text_model: sonnet })).toEqual([
    "anthropic-sonnet-5-5",
  ]);
  expect(patchPresetIds({ text_model: null })).toEqual([]);
});

test("the app settings pick how threads are summarized and at what size (#124, #161)", () => {
  // Defaults: the summary that reads the conversation's cache, at 30,000
  // estimated tokens of history.
  expect(emptyAppSettings().thread_compaction).toBe("cache");
  expect(emptyAppSettings().thread_compaction_tokens).toBe(30_000);
  for (const mode of ["cache", "transcript", "off", null])
    expect(
      appSettingsPatchSchema.safeParse({ thread_compaction: mode }).success,
    ).toBe(true);
  expect(
    appSettingsPatchSchema.safeParse({ thread_compaction: "fast" }).success,
  ).toBe(false);
  for (const tokens of [1000, 50_000, 1_000_000, null])
    expect(
      appSettingsPatchSchema.safeParse({ thread_compaction_tokens: tokens })
        .success,
    ).toBe(true);
  for (const tokens of [999, 1_000_001, 1500.5, "30000"])
    expect(
      appSettingsPatchSchema.safeParse({ thread_compaction_tokens: tokens })
        .success,
    ).toBe(false);

  // Writing one changes nothing else; null returns to the default.
  const base = emptyAppSettings();
  const off = applyAppSettingsPatch(
    base,
    { thread_compaction: "off", thread_compaction_tokens: 70_000 },
    base,
  );
  expect(off).toEqual({
    ...base,
    thread_compaction: "off",
    thread_compaction_tokens: 70_000,
  });
  const reset = applyAppSettingsPatch(
    off,
    { thread_compaction: null, thread_compaction_tokens: null },
    base,
  );
  expect(reset).toEqual(base);
  expect(
    applyAppSettingsPatch(off, { temperature: 1 }, base).thread_compaction,
  ).toBe("off");

  // A value that is missing or no longer valid reads as the default.
  const broken = normalizeAppSettings(
    { thread_compaction: "fast", thread_compaction_tokens: 5 },
    base,
  );
  expect(broken.thread_compaction).toBe("cache");
  expect(broken.thread_compaction_tokens).toBe(30_000);
  expect(normalizeAppSettings(null, base)).toEqual(base);

  // THREAD_COMPACTION_TOKENS seeds the defaults, as THREAD_HISTORY_MAX_AGE_SECS does.
  expect(appSettingsDefaults({})).toEqual(base);
  expect(
    appSettingsDefaults({ THREAD_COMPACTION_TOKENS: "50000" })
      .thread_compaction_tokens,
  ).toBe(50_000);
});

test("the API's environment seeds the app settings' defaults, as it seeded new server rows (#161)", () => {
  expect(
    appSettingsDefaults({
      EXA_ENABLED: "true",
      LLM_TEMPERATURE: "1.1",
      THREAD_HISTORY_MAX_AGE_SECS: "600",
    }),
  ).toMatchObject({
    exa_mode: "on",
    temperature: 1.1,
    thread_history_max_age_secs: 600,
  });
  expect(appSettingsDefaults({ EXA_ENABLED: "false" }).exa_mode).toBe("off");
  expect(() => appSettingsDefaults({ EXA_ENABLED: "maybe" })).toThrow(
    "EXA_ENABLED must be a boolean",
  );
  expect(() => appSettingsDefaults({ LLM_TEMPERATURE: "3" })).toThrow();
});

test("a server's settings no longer hold the app settings (#161)", () => {
  // Accepted and ignored for one deployment (docs/adr/0006); refused since.
  const patch = {
    temperature: 1.5,
    exa_mode: "off",
    thread_history_max_age_secs: 60,
    thread_compaction: "off",
    thread_compaction_tokens: 70_000,
    voice_mode: "s2s",
    filler_removal: false,
    mcp_url: "https://mcp.example.com/mcp",
  } as const;
  for (const key of APP_SETTING_KEYS) {
    expect(key in patch).toBe(true);
    expect(guildPatchSchema.safeParse({ [key]: patch[key] }).success, key).toBe(
      false,
    );
    expect(key in emptyGuild()).toBe(false);
  }
  // A row stored before they moved still holds them in JSONB; reading it
  // leaves them out, and keeps the server's own settings.
  const stored = { ...emptyGuild(), ...patch, thread_only: true };
  const read = normalizeGuild(stored);
  for (const key of APP_SETTING_KEYS) expect(key in read).toBe(false);
  expect(read.thread_only).toBe(true);
  expect(read.mcp_enabled).toBe(true);
});

test("the first app settings take what most servers had, and the default on a tie (#161)", () => {
  const defaults = emptyAppSettings();
  expect(initialAppSettings([], defaults)).toEqual(defaults);
  // Rows as they were stored before #161.
  const server = (fields: Record<string, unknown>) => ({
    ...emptyGuild(),
    ...fields,
  });
  const rows = [
    server({ temperature: 1, exa_mode: "on", voice_mode: "s2s" }),
    server({ temperature: 0.7, exa_mode: "on", voice_mode: "s2s" }),
    server({ temperature: 0.7, exa_mode: "auto", voice_mode: "stt" }),
    server({ temperature: 0.7, exa_mode: "on", voice_mode: "stt" }),
  ];
  const first = initialAppSettings(rows, { ...defaults, exa_mode: "off" });
  expect(first.temperature).toBe(0.7);
  expect(first.exa_mode).toBe("on");
  // Two against two: the default, not the first one seen.
  expect(initialAppSettings(rows, defaults).voice_mode).toBe("stt");
  expect(
    initialAppSettings(rows, { ...defaults, voice_mode: "s2s" }).voice_mode,
  ).toBe("s2s");
  // A server value that is not valid any more counts as the default.
  expect(
    initialAppSettings([{ thread_compaction: "fast" } as never], defaults)
      .thread_compaction,
  ).toBe("cache");
});
