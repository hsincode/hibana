import { join } from "node:path";
import { MODEL_PRESETS, deprecatedProvider } from "@hibana/shared/catalog";
import { newlyDeprecatedPresetIds, normalizeUserOverride } from "@hibana/shared/settings";
import { atomicJson, readJson, Serial } from "./io";
import type { Runtime } from "./runtime";

/*
 * Every provider except `anthropic` is deprecated (decision record: #67,
 * docs/adr/0010). Those providers keep running as they do today. What this
 * file adds is the two things users see: a new choice of one is refused, and
 * whoever is on one by their own choice is told once.
 *
 * `anthropic_workspace` is Anthropic's own API as well and is not deprecated
 * (#76). `deprecatedProvider` in the shared catalog draws that line; nothing
 * in this file names a provider.
 */

type Chosen = { provider: string; model: string };

const label = (selection: Chosen) =>
  MODEL_PRESETS.find((p) => p.provider === selection.provider && p.model === selection.model)?.label ??
  `${selection.provider} / ${selection.model}`;

/** The presets this user can move to, as Discord inline code. Empty for a
 *  user without the plan, or while the bot has no Anthropic key. Once the
 *  Anthropic Workspace presets are published and keyed, they are listed too. */
const offered = (runtime: Runtime, userId: string) =>
  runtime.selectablePresets(userId).map((p) => `\`${p.id}\``).join(", ");

/**
 * `/switch` and `set_bot_model` call this before `Runtime.patch`. It throws
 * when `preset` would be a new choice of a deprecated provider.
 *
 * Naming the preset the server is already on passes, so `/switch preset:sol
 * effort:high` keeps working for a server on `sol`; `reset` passes too.
 * Anything else about the preset (unknown id, plan, publication, missing key)
 * is still `Runtime.patch`'s to refuse.
 */
export function refuseDeprecatedPreset(runtime: Runtime, guildId: string, userId: string, preset: unknown) {
  if (typeof preset !== "string") return;
  const [id] = newlyDeprecatedPresetIds(runtime.guild(guildId), { preset });
  if (!id) return;
  const presets = offered(runtime, userId);
  throw new Error(
    `\`${id}\` は非推奨のプロバイダのプリセットのため、新しく選べません。` +
      (presets ? `選べるプリセット: ${presets}。` : "このアカウントで選べる Anthropic のプリセットはありません。") +
      "現在の設定はそのまま使えます。",
  );
}

/** The line `/info` adds. Unlike the one-time notice, everyone on a
 *  deprecated provider gets it, the default included. */
export function deprecationLine(selection: { provider: string }): string | undefined {
  return deprecatedProvider(selection.provider)
    ? `現在のモデルのプロバイダ（${selection.provider}）は非推奨です。当面はこのまま使えます。`
    : undefined;
}

type NoticeFile = { version: 1; shown: Record<string, string> };

/**
 * The one-time Discord notice for a server or a user who is on a deprecated
 * provider by their own choice.
 *
 * A turn owes the notice when all of these hold:
 * - its selection is on a deprecated provider;
 * - that selection is not the default. A server that never chose a model, a
 *   DM without a personal model, and a user whose plan lapsed all run on the
 *   default, and those users are left alone for now (#67);
 * - the user can move: at least one preset is `selectable` for them;
 * - the target has not been told. The target is the user when the selection
 *   comes from their own settings, otherwise the server.
 *
 * The notice is its own Discord message. It is never added to the history
 * sent to the model, so requests to the deprecated providers stay as they
 * are. Delivered targets are kept in a JSON file in the data directory, so a
 * restart does not repeat them.
 */
export class DeprecationNotices {
  /** Target (`guild:<id>` or `user:<id>`) → when its notice was posted. */
  private shown: Record<string, string> = {};
  /** Claimed by a turn whose notice is still being sent. Memory only. */
  private sending = new Set<string>();
  private serial = new Serial();
  private queued = false;
  private loading?: Promise<boolean>;
  private path: string;
  constructor(
    private runtime: Runtime,
    private onError: (error: unknown) => void = () => {},
    path?: string,
    private now: () => Date = () => new Date(),
  ) {
    this.path = path ?? join(runtime.config.dataDir, "deprecation_notices.json");
  }
  /** Reads the file on first use. `false` when it exists but cannot be read:
   *  the bot then says nothing rather than tell everyone a second time, and
   *  the file is left untouched for inspection. */
  private load() {
    return (this.loading ??= readJson<NoticeFile>(this.path, { version: 1, shown: {} }).then(
      (stored) => {
        this.shown = { ...stored.shown };
        return true;
      },
      (error) => {
        this.onError(error);
        return false;
      },
    ));
  }
  private isDefault(selection: Chosen) {
    const same = (other: Chosen | null) =>
      other?.provider === selection.provider && other.model === selection.model;
    // The bot's own environment default, and the default row the settings
    // API seeds new servers with; the two differ only if their envs do.
    return same(this.runtime.config.selection) || same(this.runtime.guild().selection);
  }
  /** The notice this turn owes, or nothing. Reads state only. */
  due(guildId: string | undefined, userId: string): { target: string; text: string } | undefined {
    const selection = this.runtime.resolve(guildId, userId).selection;
    if (!deprecatedProvider(selection.provider) || this.isDefault(selection)) return;
    // resolve() already replaced a personal model the user lost the plan for
    // with the default, so a personal selection that got here is the one in use.
    const personal = normalizeUserOverride(this.runtime.snapshot.user_overrides[userId]).selection;
    const target = personal ? `user:${userId}` : guildId ? `guild:${guildId}` : undefined;
    if (!target || this.shown[target] || this.sending.has(target)) return;
    const presets = offered(this.runtime, userId);
    if (!presets) return;
    const [whose, where] = personal
      ? [`<@${userId}> さんのマイ設定で選択中のモデル`, "ダッシュボードのマイ設定"]
      : ["このサーバーで選択中のモデル", "`/switch` またはダッシュボードのサーバー設定"];
    return {
      target,
      text:
        `お知らせ: ${whose}（${label(selection)}）は非推奨のプロバイダです。当面はこのまま使えます。` +
        `${where}で Anthropic のプリセット（${presets}）に切り替えられます。このお知らせは 1 回だけ表示します。`,
    };
  }
  /**
   * Posts the notice with `send` when this turn owes one, and records it.
   * Resolves to whether a notice was posted. Never rejects: a notice that
   * cannot be decided or sent is reported to `onError` and must not fail the
   * turn; one that was not sent is tried again on a later turn.
   */
  async announce(
    guildId: string | undefined,
    userId: string,
    send: (text: string) => Promise<unknown>,
  ): Promise<boolean> {
    let claimed: string | undefined;
    try {
      if (!(await this.load())) return false;
      const notice = this.due(guildId, userId);
      if (!notice) return false;
      // Claimed with no await since due(), so two turns that start together
      // in one server post a single notice between them.
      this.sending.add((claimed = notice.target));
      await send(notice.text);
      this.shown[claimed] = this.now().toISOString();
      this.save();
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    } finally {
      if (claimed) this.sending.delete(claimed);
    }
  }
  /** Settles once the latest record is on disk. */
  flush() {
    return this.serial.run(async () => {});
  }
  private save() {
    // Coalesce notices posted close together into one write of the latest state.
    if (this.queued) return;
    this.queued = true;
    void this.serial
      .run(async () => {
        this.queued = false;
        await atomicJson(this.path, { version: 1, shown: this.shown } satisfies NoticeFile);
      })
      .catch(this.onError);
  }
}
