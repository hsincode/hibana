/** Global plan roles. Lower index is stronger. */
export const ROLES = [
  "administrator",
  "moderator",
  "premium",
  "standard",
  "free",
] as const;

export type Role = (typeof ROLES)[number];

/** New dashboard logins start here. Administrator is only `WEB_ADMIN_IDS`. */
export const DEFAULT_ROLE: Role = "free";

const RANK: Record<Role, number> = {
  administrator: 0,
  moderator: 1,
  premium: 2,
  standard: 3,
  free: 4,
};

export function isRole(raw: string): raw is Role {
  return (ROLES as readonly string[]).includes(raw);
}

export function parseRole(raw: string): Role | null {
  const s = raw.trim().toLowerCase();
  return isRole(s) ? s : null;
}

export function rank(role: Role): number {
  return RANK[role];
}

/** Actor may manage users (list + assign). */
export function canManageUsers(role: Role): boolean {
  return role === "administrator" || role === "moderator";
}

/**
 * Actor may pick a preset whose floor is `minRole`.
 * Missing minRole = everyone. Rank is lower-index-stronger, so premium (2)
 * may pick a premium-floor preset; standard (3) may not.
 */
export function canSelectPreset(
  role: Role,
  minRole: Role | null | undefined,
): boolean {
  if (!minRole) return true;
  return rank(role) <= rank(minRole);
}

/**
 * Administrator / Moderator may grant a **strictly weaker** role to a
 * **strictly weaker** user. Same rank, self, and promotions to own rank are refused.
 */
export function canAssignRole(actor: Role, target: Role, next: Role): boolean {
  return rank(actor) < rank(target) && rank(actor) < rank(next);
}

export function rolesAssignableBy(actor: Role): Role[] {
  return ROLES.filter((r) => rank(actor) < rank(r));
}

/**
 * Actor may see **every** guild the bot is in, not just the ones they share.
 * Administrator / Moderator moderate servers they were never invited to, so
 * the OAuth guild intersection would hide exactly the servers they need.
 */
export function canViewAllGuilds(role: Role): boolean {
  return role === "administrator" || role === "moderator";
}

/**
 * Actor may read the conversation audit log (includes DM turns) and flip the
 * kill switches (guild disable / user block). Same bar as user management:
 * both are moderation powers, and splitting them would let a moderator ban a
 * user without being able to see why.
 */
export function canModerate(role: Role): boolean {
  return role === "administrator" || role === "moderator";
}
