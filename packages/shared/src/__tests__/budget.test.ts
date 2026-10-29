import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BUDGET_FALLBACK,
  DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD,
  budgetFallbackSelection,
  budgetLow,
  budgetSwitchGuildPatch,
  budgetSwitchTarget,
  budgetSwitchUserPatch,
  budgetThresholdSchema,
  formatThreshold,
  isBudgetFallbackPreset,
  parseBudgetFallback,
  parseBudgetThreshold,
} from "../budget";
import {
  applyPatch,
  applyUserOverridePatch,
  effectiveSubagentMode,
  emptyGuild,
  emptyUserOverride,
  guildPatchSchema,
  userOverridePatchSchema,
  type GuildPatch,
  type GuildRow,
} from "../settings";

describe("budget fallback (#89)", () => {
  test("the threshold and default of #89: below $10, Anthropic API Haiku 5.5 High", () => {
    expect(DEFAULT_BUDGET_FALLBACK_THRESHOLD_USD).toBe(10);
    expect(budgetLow(9.99, 10)).toBe(true);
    expect(budgetLow(10, 10)).toBe(false);
    expect(budgetLow(-5, 10)).toBe(true);
    expect(budgetFallbackSelection(DEFAULT_BUDGET_FALLBACK)).toEqual({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      effort: "high",
    });
  });

  test("only Anthropic API presets other than Auto may be the fallback", () => {
    expect(isBudgetFallbackPreset("anthropic-haiku-5-5")).toBe(true);
    expect(isBudgetFallbackPreset("anthropic-opus-5-5")).toBe(true);
    expect(isBudgetFallbackPreset("anthropic-auto")).toBe(false);
    expect(isBudgetFallbackPreset("anthropic-workspace-haiku-5-5")).toBe(false);
    expect(isBudgetFallbackPreset("max-opus-5-5")).toBe(false);
    expect(isBudgetFallbackPreset("sonnet-5")).toBe(false);
    expect(isBudgetFallbackPreset("nope")).toBe(false);
  });

  test("a stored value that no longer parses reads as the default", () => {
    expect(parseBudgetFallback(null)).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(parseBudgetFallback("not json")).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(
      parseBudgetFallback('{"preset":"anthropic-gone","effort":"high"}'),
    ).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(
      parseBudgetFallback({ preset: "anthropic-opus-5-5", effort: "none" }),
    ).toEqual(DEFAULT_BUDGET_FALLBACK);
    expect(
      parseBudgetFallback(
        '{"preset":"anthropic-sonnet-5-5","effort":"medium"}',
      ),
    ).toEqual({ preset: "anthropic-sonnet-5-5", effort: "medium" });
    // The default is a copy: a caller changing it does not change the next read.
    const read = parseBudgetFallback(null);
    read.effort = "low";
    expect(parseBudgetFallback(null).effort).toBe("high");
  });

  test("the threshold an Administrator stores is checked against the stored one (#95)", () => {
    expect(budgetLow(24.99, 25)).toBe(true);
    expect(budgetLow(25, 25)).toBe(false);
    // $0: only an exceeded budget switches.
    expect(budgetLow(0, 0)).toBe(false);
    expect(budgetLow(-0.01, 0)).toBe(true);
  });
});

describe("budget threshold (#95)", () => {
  const schema = budgetThresholdSchema(200);

  test("whole cents from $0 to the monthly budget", () => {
    for (const ok of [0, 0.01, 10, 12.5, 199.99, 200])
      expect(schema.parse(ok)).toBe(ok);
    // Floating point noise from a form is rounded to the cent it names.
    expect(schema.parse(0.1 + 0.2)).toBe(0.3);
    expect(schema.parse(19.99)).toBe(19.99);
    for (const bad of [
      -0.01,
      200.01,
      1.005,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "10",
      null,
      undefined,
    ])
      expect(schema.safeParse(bad).success).toBe(false);
  });

  test("a stored threshold that no longer parses reads as the default", () => {
    expect(parseBudgetThreshold(null, 200)).toBe(10);
    expect(parseBudgetThreshold("not json", 200)).toBe(10);
    expect(parseBudgetThreshold("25", 200)).toBe(25);
    expect(parseBudgetThreshold("7.5", 200)).toBe(7.5);
    expect(parseBudgetThreshold(25, 200)).toBe(25);
    // The monthly budget was lowered below the stored value.
    expect(parseBudgetThreshold("150", 100)).toBe(10);
    expect(parseBudgetThreshold("-1", 200)).toBe(10);
  });

  test("the notice writes whole dollars without cents", () => {
    expect(formatThreshold(10)).toBe("$10");
    expect(formatThreshold(7.5)).toBe("$7.50");
    expect(formatThreshold(0)).toBe("$0");
  });
});

describe("budget switch of the stored settings (#121)", () => {
  const target = budgetSwitchTarget(DEFAULT_BUDGET_FALLBACK, []);
  const guild = (patch: GuildPatch) => applyPatch(emptyGuild(), patch);
  const switched = (row: GuildRow) => {
    const patch = budgetSwitchGuildPatch(row, target);
    // What the API writes must be a PATCH it would accept.
    if (patch) expect(guildPatchSchema.safeParse(patch).success).toBe(true);
    return patch ? applyPatch(row, guildPatchSchema.parse(patch)) : row;
  };

  test("the target is the fallback, and the Workspace preset of its model", () => {
    expect(target).toEqual({
      preset: "anthropic-haiku-5-5",
      effort: "high",
      workspacePreset: "anthropic-workspace-haiku-5-5",
    });
    // Unpublished Workspace preset: Workspace choices take the fallback.
    expect(
      budgetSwitchTarget(DEFAULT_BUDGET_FALLBACK, [
        "anthropic-workspace-haiku-5-5",
      ]).workspacePreset,
    ).toBeNull();
    // A fallback hidden since it was stored runs the default (as the bot does).
    expect(
      budgetSwitchTarget({ preset: "anthropic-opus-5-6", effort: "low" }, [
        "anthropic-opus-5-6",
      ]),
    ).toEqual(target);
    expect(
      budgetSwitchTarget(
        { preset: "anthropic-sonnet-5-5", effort: "medium" },
        [],
      ).workspacePreset,
    ).toBe("anthropic-workspace-sonnet-5-5");
  });

  test("an Anthropic API server, Auto included, moves to the fallback", () => {
    for (const preset of ["anthropic-opus-5-5", "anthropic-auto"]) {
      const row = switched(guild({ preset, effort: "max" }));
      expect(row.selection).toEqual({
        provider: "anthropic",
        model: "claude-haiku-5-5",
        effort: "high",
      });
      expect(row.effort).toBe("high");
    }
    // The fallback's model at another effort is switched too: Xhigh is
    // what a person may pick afterwards, not what the switch keeps.
    expect(
      switched(guild({ preset: "anthropic-haiku-5-5", effort: "xhigh" }))
        .effort,
    ).toBe("high");
  });

  test("a Workspace server moves to the fallback's Workspace model, with Ultra off", () => {
    const row = switched(
      guild({
        preset: "anthropic-workspace-opus-5-5",
        effort: "max",
        ultra_mode: true,
        multi_agent: true,
      }),
    );
    expect(row.selection).toEqual({
      provider: "anthropic_workspace",
      model: "claude-haiku-5-5",
      effort: "high",
    });
    expect(row.ultra_mode).toBe(false);
    expect(row.multi_agent).toBe(false);
    expect(effectiveSubagentMode(row, row.selection)).toBe("off");
    // The Workspace preset unpublished: the fallback on Anthropic API.
    const hidden = budgetSwitchTarget(DEFAULT_BUDGET_FALLBACK, [
      "anthropic-workspace-haiku-5-5",
    ]);
    const api = applyPatch(
      guild({ preset: "anthropic-workspace-opus-5-5" }),
      guildPatchSchema.parse(
        budgetSwitchGuildPatch(
          guild({ preset: "anthropic-workspace-opus-5-5" }),
          hidden,
        ),
      ),
    );
    expect(api.selection?.provider).toBe("anthropic");
    expect(api.selection?.model).toBe("claude-haiku-5-5");
  });

  test("a server already on the target keeps its row, Haiku Ultra included", () => {
    const summary = { preset: "anthropic-haiku-5-5", effort: "high" } as const;
    const onTarget = guild({
      preset: "anthropic-haiku-5-5",
      effort: "high",
      text_model: summary,
    });
    expect(budgetSwitchGuildPatch(onTarget, target)).toBeNull();
    const haikuUltra = guild({
      preset: "anthropic-workspace-haiku-5-5",
      effort: "high",
      ultra_mode: true,
      text_model: summary,
    });
    expect(budgetSwitchGuildPatch(haikuUltra, target)).toBeNull();
  });

  test("other providers keep their model; their Anthropic API children are switched", () => {
    const row = guild({
      preset: "opus-5-5",
      effort: "max",
      subagent_model: { mode: "fixed", preset: "anthropic-opus-5-5" },
      subagent_effort: { mode: "same" },
      multi_agent_roles: {
        reviewer: {
          model: { mode: "fixed", preset: "anthropic-sonnet-5-5" },
          effort: { mode: "fixed", effort: "max" },
        },
        worker: {
          model: { mode: "fixed", preset: "opus-5-5" },
          effort: { mode: "default" },
        },
      },
    });
    const next = switched(row);
    expect(next.selection).toEqual(row.selection);
    expect(next.effort).toBe("max");
    expect(next.subagent_model).toEqual({
      mode: "fixed",
      preset: "anthropic-haiku-5-5",
    });
    expect(next.subagent_effort).toEqual({ mode: "fixed", effort: "high" });
    expect(next.multi_agent_roles?.reviewer).toEqual({
      model: { mode: "fixed", preset: "anthropic-haiku-5-5" },
      effort: { mode: "fixed", effort: "high" },
    });
    // Not an Anthropic API preset: left as stored.
    expect(next.multi_agent_roles?.worker).toEqual(
      row.multi_agent_roles!.worker,
    );
    expect(next.multi_agent_roles?.explorer).toEqual(
      row.multi_agent_roles!.explorer,
    );
  });

  test("auto and same children are not stored models and stay", () => {
    const row = guild({
      preset: "opus-5-5",
      subagent_model: { mode: "auto" },
      subagent_effort: { mode: "auto" },
      text_model: { preset: "anthropic-haiku-5-5", effort: "high" },
    });
    expect(budgetSwitchGuildPatch(row, target)).toBeNull();
  });

  test("the Text Generation Model takes the fallback too", () => {
    // The default (Haiku 5.5 medium) differs in effort from the default fallback.
    expect(switched(guild({ preset: "opus-5-5" })).text_model).toEqual({
      preset: "anthropic-haiku-5-5",
      effort: "high",
    });
    expect(
      switched(
        guild({
          preset: "opus-5-5",
          text_model: { preset: "anthropic-opus-5-5", effort: "max" },
        }),
      ).text_model,
    ).toEqual({ preset: "anthropic-haiku-5-5", effort: "high" });
  });

  test("a person's own choices are switched; what follows the server is not", () => {
    const own = applyUserOverridePatch(emptyUserOverride(), {
      preset: "anthropic-workspace-sonnet-5-5",
      effort: "max",
      subagent_model: { mode: "fixed", preset: "anthropic-opus-5-5" },
    });
    const patch = budgetSwitchUserPatch(own, target);
    expect(userOverridePatchSchema.safeParse(patch).success).toBe(true);
    const next = applyUserOverridePatch(
      own,
      userOverridePatchSchema.parse(patch),
    );
    expect(next.selection).toEqual({
      provider: "anthropic_workspace",
      model: "claude-haiku-5-5",
      effort: "high",
    });
    expect(next.effort).toBe("high");
    expect(next.ultra_mode).toBe(false);
    expect(next.multi_agent).toBe(false);
    expect(next.subagent_model).toEqual({
      mode: "fixed",
      preset: "anthropic-haiku-5-5",
    });
    expect(next.subagent_effort).toEqual({ mode: "fixed", effort: "high" });
    // デフォルト everywhere: nothing of their own to switch.
    expect(budgetSwitchUserPatch(emptyUserOverride(), target)).toBeNull();
    // Another provider of their own is kept.
    expect(
      budgetSwitchUserPatch(
        applyUserOverridePatch(emptyUserOverride(), { preset: "opus-5-5" }),
        target,
      ),
    ).toBeNull();
  });
});
