import { useState } from "react";
import { RowMark, Trace } from "./save";
import type { PatchFn } from "./settings";
import { Icon, Section } from "./ui";

/** Old catalog without `triggers`. Same spellings as bot `BUILTIN_TRIGGERS`. */
export const FALLBACK_TRIGGERS = [
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
];
const TRIGGER_WORD_MAX = 32;
const TRIGGER_EXTRA_MAX = 32;
const ROW = "g-triggers";

function triggerNamesEqual(a: string, b: string): boolean {
  const ascii = (s: string) => [...s].every((ch) => ch.charCodeAt(0) < 128);
  return ascii(a) && ascii(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalBuiltin(
  word: string,
  builtins: string[],
): string | undefined {
  return builtins.find((b) => triggerNamesEqual(b, word));
}

function validateTriggerDraft(
  raw: string,
  builtins: string[],
  extras: string[],
  disabled: string[],
): string | null {
  const t = raw.trim();
  if (!t) return "空です";
  if ([...t].length > TRIGGER_WORD_MAX) return `${TRIGGER_WORD_MAX} 文字以内`;
  if (t.includes(",") || t.includes("\0") || t.includes("<@"))
    return "カンマ・制御文字・メンションは使えません";
  const builtin = canonicalBuiltin(t, builtins);
  if (builtin) {
    return disabled.some((d) => triggerNamesEqual(d, builtin))
      ? null
      : "既に既定の語として有効";
  }
  if (extras.some((e) => triggerNamesEqual(e, t))) return "すでに追加済み";
  if (extras.length >= TRIGGER_EXTRA_MAX)
    return `追加は ${TRIGGER_EXTRA_MAX} 個まで`;
  return null;
}

/**
 * Keyword wake words for this guild.
 *
 * Builtins stay visible even when turned off so they can be restored; extras
 * are guild-owned. Renaming a builtin disables the old spelling and stores
 * the new one as extra — that is how a default word is edited and persisted
 * without rewriting the bot binary.
 */
export function TriggerEditor({
  builtins,
  extra,
  disabled,
  patch,
}: {
  builtins: string[];
  extra: string[] | null;
  disabled: string[];
  patch: PatchFn;
}) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const extraOwned = extra !== null;
  const extras = extra ?? [];
  const err = validateTriggerDraft(draft, builtins, extras, disabled);

  function isDisabled(word: string): boolean {
    return disabled.some((d) => triggerNamesEqual(d, word));
  }

  function toggleBuiltin(word: string) {
    const canon = canonicalBuiltin(word, builtins) ?? word;
    patch(
      {
        disabled_triggers: isDisabled(canon)
          ? disabled.filter((d) => !triggerNamesEqual(d, canon))
          : [...disabled, canon],
      },
      ROW,
    );
  }

  function removeExtra(word: string) {
    patch({ extra_triggers: extras.filter((e) => !triggerNamesEqual(e, word)) }, ROW);
  }

  function addWord() {
    const t = draft.trim();
    if (!t || err) return;
    const builtin = canonicalBuiltin(t, builtins);
    if (builtin) {
      patch(
        { disabled_triggers: disabled.filter((d) => !triggerNamesEqual(d, builtin)) },
        ROW,
      );
    } else {
      patch({ extra_triggers: [...extras, t] }, ROW);
    }
    setDraft("");
  }

  function applyRename(from: string) {
    const t = editValue.trim();
    if (triggerNamesEqual(from, t)) {
      setEditing(null);
      return;
    }
    if (
      validateTriggerDraft(
        t,
        builtins,
        extras.filter((e) => !triggerNamesEqual(e, from)),
        disabled,
      )
    )
      return;
    setEditing(null);
    const fromBuiltin = canonicalBuiltin(from, builtins);
    const toBuiltin = canonicalBuiltin(t, builtins);
    let nextDisabled = [...disabled];
    let nextExtra = [...extras];
    let extraTouched = extraOwned;

    if (fromBuiltin) {
      if (!nextDisabled.some((d) => triggerNamesEqual(d, fromBuiltin)))
        nextDisabled.push(fromBuiltin);
    } else {
      nextExtra = nextExtra.filter((e) => !triggerNamesEqual(e, from));
      extraTouched = true;
    }

    if (toBuiltin) {
      nextDisabled = nextDisabled.filter(
        (d) => !triggerNamesEqual(d, toBuiltin),
      );
    } else if (!nextExtra.some((e) => triggerNamesEqual(e, t))) {
      if (nextExtra.length >= TRIGGER_EXTRA_MAX) return;
      nextExtra.push(t);
      extraTouched = true;
    }

    const body: Record<string, unknown> = { disabled_triggers: nextDisabled };
    if (extraTouched) body.extra_triggers = nextExtra;
    patch(body, ROW);
  }

  const dirty = extraOwned || disabled.length > 0;

  /** 改名中は語の代わりに入力欄を出す。フォーカスを外すと確定、Esc でやめる。 */
  const word = (text: string, key: string) =>
    editing === key ? (
      <input
        className="chip-input"
        value={editValue}
        autoFocus
        maxLength={TRIGGER_WORD_MAX}
        aria-label={`${text} を編集`}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={() => applyRename(text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(null);
        }}
      />
    ) : (
      <span className="chip-text">{text}</span>
    );
  const renameButton = (text: string, key: string) => (
    <button
      type="button"
      className="icon-btn"
      aria-label={`${text} を改名`}
      title="改名"
      onClick={() => {
        setEditing(key);
        setEditValue(text);
      }}
    >
      <Icon.pencil size={14} />
    </button>
  );

  return (
    <Section
      id="triggers"
      title="トリガーワード"
      desc="メンションなしで bot が反応する語です。既定の語は無効にでき、改名すると追加の語になります。"
    >
      <div data-row={ROW}>
        <Trace k={ROW}>
          <div className="trig-group">
            <h3 className="eyebrow">既定</h3>
            <ul className="chips">
              {builtins.map((b) => {
                const off = isDisabled(b);
                return (
                  <li key={b} className={`chip${off ? " is-off" : ""}`}>
                    {word(b, b)}
                    {renameButton(b, b)}
                    <button
                      type="button"
                      className="switch"
                      role="switch"
                      aria-checked={!off}
                      aria-label={off ? `${b} を有効` : `${b} を無効`}
                      title={off ? "有効にする" : "無効にする"}
                      onClick={() => toggleBuiltin(b)}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="trig-group">
            <h3 className="eyebrow">追加</h3>
            {extras.length === 0 ? (
              <p className="muted">
                {extraOwned
                  ? "追加キーワードはありません。"
                  : "サーバー固有の追加はありません。"}
              </p>
            ) : (
              <ul className="chips">
                {extras.map((x) => (
                  <li key={x} className="chip">
                    {word(x, `extra:${x}`)}
                    {renameButton(x, `extra:${x}`)}
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`${x} を外す`}
                      title="外す"
                      onClick={() => removeExtra(x)}
                    >
                      <Icon.close size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Trace>
      </div>

      <form
        className="trig-form"
        onSubmit={(e) => {
          e.preventDefault();
          addWord();
        }}
      >
        <input
          className="input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={TRIGGER_WORD_MAX}
          placeholder="キーワードを追加"
          aria-label="トリガーワードを追加"
          autoComplete="off"
        />
        <button type="submit" className="btn" disabled={!!err || !draft.trim()}>
          <Icon.plus size={14} />
          追加
        </button>
        {dirty && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => patch({ extra_triggers: null, disabled_triggers: [] }, ROW)}
          >
            既定に戻す
          </button>
        )}
        <RowMark k={ROW} />
      </form>
      {draft.trim() && err && (
        <p className="field-error">
          <Icon.alert size={13} />
          <span>{err}</span>
        </p>
      )}
      {editing !== null && (
        <p className="field-hint" role="status">
          {validateTriggerDraft(
            editValue,
            builtins,
            extras.filter((e) => `extra:${e}` !== editing),
            disabled,
          )}
        </p>
      )}
    </Section>
  );
}
