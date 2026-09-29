import { describe, expect, test } from "bun:test";
import { ProviderError } from "../llm-errors";
import { classifyFailure, httpStatusOf } from "../failure";

describe("failure telemetry", () => {
  test("groups provider authentication, rate limit, HTTP, and response failures", () => {
    expect(classifyFailure(new Error("Missing API key for deepseek"), "agent")).toBe(
      "provider_auth",
    );
    expect(classifyFailure(new Error("LLM deepseek: HTTP 429"), "agent")).toBe(
      "provider_rate_limit",
    );
    expect(classifyFailure(new Error("LLM deepseek: HTTP 503"), "agent")).toBe(
      "provider_http",
    );
    expect(
      classifyFailure(new Error("Provider returned no assistant message"), "agent"),
    ).toBe("provider_response");
  });

  test("keeps phase-specific I/O failures separate from model failures", () => {
    expect(classifyFailure(new Error("EACCES"), "prompt_assembly")).toBe(
      "prompt_io",
    );
    expect(classifyFailure(new Error("ENOSPC"), "checkpoint_save")).toBe(
      "checkpoint_io",
    );
    expect(classifyFailure(new Error("Discord API rejected message"), "discord_send")).toBe(
      "discord",
    );
    expect(classifyFailure(new Error("fetch failed"), "history_compaction")).toBe(
      "provider_network",
    );
    expect(classifyFailure(new Error("HTTP 403"), "discord_send")).toBe(
      "discord",
    );
    expect(classifyFailure(new Error("HTTP 429"), "prompt_assembly")).toBe(
      "prompt_io",
    );
  });

  test("extracts only bounded HTTP status values", () => {
    expect(httpStatusOf(new Error("LLM deepseek: HTTP 503"))).toBe(503);
    expect(httpStatusOf(new Error("HTTP 700"))).toBeNull();
    expect(httpStatusOf(new Error("network timeout"))).toBeNull();
  });
});

test("typed recovery errors retain their failure telemetry categories", () => {
  for (const [error, expected] of [
    [new ProviderError("authentication", false), "provider_auth"],
    [new ProviderError("quota", false), "provider_rate_limit"],
    [new ProviderError("transient", true, 429), "provider_rate_limit"],
    [new ProviderError("transient", true, 503), "provider_http"],
    [new ProviderError("transient", true), "provider_network"],
    [new ProviderError("protocol", false), "provider_response"],
  ] as const) {
    expect(classifyFailure(error, "agent")).toBe(expected);
    expect(classifyFailure(error, "history_compaction")).toBe(expected);
    expect(classifyFailure(error, "discord_send")).toBe("discord");
  }
});
