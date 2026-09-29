import { describe, expect, test } from "bun:test";
import {
  canAssignRole,
  canManageUsers,
  canSelectPreset,
  DEFAULT_ROLE,
  rolesAssignableBy,
} from "./roles";

describe("role hierarchy", () => {
  test("new users default to free", () => {
    expect(DEFAULT_ROLE).toBe("free");
  });

  test("only admin and mod manage users", () => {
    expect(canManageUsers("administrator")).toBe(true);
    expect(canManageUsers("moderator")).toBe(true);
    expect(canManageUsers("premium")).toBe(false);
    expect(canManageUsers("free")).toBe(false);
  });

  test("admin can grant mod and below, not admin", () => {
    expect(canAssignRole("administrator", "free", "premium")).toBe(true);
    expect(canAssignRole("administrator", "free", "moderator")).toBe(true);
    expect(canAssignRole("administrator", "free", "administrator")).toBe(false);
    expect(canAssignRole("administrator", "administrator", "free")).toBe(false);
  });

  test("mod cannot touch admin or another mod", () => {
    expect(canAssignRole("moderator", "administrator", "free")).toBe(false);
    expect(canAssignRole("moderator", "moderator", "free")).toBe(false);
    expect(canAssignRole("moderator", "free", "moderator")).toBe(false);
    expect(canAssignRole("moderator", "free", "premium")).toBe(true);
  });

  test("assignable list is strictly below actor", () => {
    expect(rolesAssignableBy("administrator")).toEqual([
      "moderator",
      "premium",
      "standard",
      "free",
    ]);
    expect(rolesAssignableBy("moderator")).toEqual([
      "premium",
      "standard",
      "free",
    ]);
    expect(rolesAssignableBy("free")).toEqual([]);
  });

  test("premium floor is premium / moderator / administrator", () => {
    expect(canSelectPreset("administrator", "premium")).toBe(true);
    expect(canSelectPreset("moderator", "premium")).toBe(true);
    expect(canSelectPreset("premium", "premium")).toBe(true);
    expect(canSelectPreset("standard", "premium")).toBe(false);
    expect(canSelectPreset("free", "premium")).toBe(false);
    expect(canSelectPreset("free", null)).toBe(true);
  });
});
