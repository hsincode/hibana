import { PermissionFlagsBits, type PermissionsBitField } from "discord.js";

/** The refusal when someone who may only look changes a server's settings (#166). */
export const MANAGE_SERVER_REQUIRED =
  "サーバーの設定を変えられるのは、Discord の「サーバー管理」か「管理者」の権限を持つ人、サーバーのオーナー、Moderator と Administrator だけです。";

/**
 * Whether someone may change a server's settings (decision record #166): a
 * hibana Administrator or Moderator, the server's owner, or a member with
 * Discord's Manage Server or Administrator there. The dashboard's API applies
 * the same rule (`apps/api/src/create-app.ts`, `guildAccess`).
 */
export function canManageServerSettings(who: {
  role: string;
  owner: boolean;
  permissions: Readonly<PermissionsBitField> | null | undefined;
}): boolean {
  return (
    who.role === "administrator" ||
    who.role === "moderator" ||
    who.owner ||
    // `has` counts Discord's Administrator as every permission.
    Boolean(who.permissions?.has(PermissionFlagsBits.ManageGuild))
  );
}
