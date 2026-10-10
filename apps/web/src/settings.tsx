import type { SubagentModel, SubagentEffort, ServiceTier } from "@hibana/shared/settings";
import { modelEffort, type MultiAgentRoles } from "@hibana/shared/settings";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Preset } from "./api";
import { Row, type Mark, type Pulse, type SaveMarks, type SaveState } from "./save";
import { BoolSeg, Icon, Section } from "./ui";

/* ============================================================
   サーバー設定とマイ設定で共用するもの
   - 保存: 往復を待たずに画面を更新し、失敗したら巻き戻す
   - コンテキストの節（エージェントの節は Agent.tsx）
   ============================================================ */

export type OverlaySettings = {
  selection?: {
    provider?: string;
    model?: string;
    effort?: string | null;
  } | null;
  effort?: string | null;
  service_tier?: ServiceTier | null;
  subagent_enabled?: boolean | null;
  ultra_mode?: boolean | null;
  multi_agent?: boolean | null;
  multi_agent_roles?: MultiAgentRoles | null;
  subagent_model?: SubagentModel | null;
  subagent_effort?: SubagentEffort | null;
  jev_enabled?: boolean | null;
  jev_task_enabled?: boolean | null;
  context?: { text: string; persona_override: boolean } | null;
};

/** PATCH の本文と、変えた設定行のキー（保存の印を出す行）。 */
export type PatchFn = (body: Record<string, unknown>, row: string) => void;

/** PATCH body → 画面用 settings。サーバーの applyPatch と同じ形にして、往復前に画面が変わるようにする。 */
function applyLocalPatch<T extends OverlaySettings>(
  current: T,
  body: Record<string, unknown>,
  presets: Preset[],
  blankReset = false,
): T {
  const next: Record<string, unknown> = { ...current };

  if (body.preset === "reset") {
    // マイ設定のデフォルトは「未設定」なので、押した瞬間に選択を外す。
    // サーバー設定のリセットは環境の具体値で、応答が来るまで今の表示を残す。
    if (blankReset) {
      next.selection = null;
      next.effort = null;
    }
  } else if (typeof body.preset === "string") {
    const p = presets.find((x) => x.id === body.preset);
    if (p) {
      next.selection = {
        provider: p.provider,
        model: p.model ?? p.label.split("/").pop()?.trim(),
        effort:
          body.effort !== undefined
            ? (body.effort as string | null)
            : modelEffort(p.model ?? p.label),
      };
      next.effort = (next.selection as { effort: string }).effort;
    }
  } else if (body.effort !== undefined && current.selection) {
    next.selection = {
      ...current.selection,
      effort: body.effort as string | null,
    };
  }

  if (body.effort !== undefined) next.effort = body.effort;

  if (body.context_clear) {
    next.context = { text: "", persona_override: false };
  } else if (
    body.context_text !== undefined ||
    body.persona_override !== undefined
  ) {
    const prev = current.context ?? { text: "", persona_override: false };
    next.context = {
      text:
        body.context_text === undefined
          ? prev.text
          : ((body.context_text as string | null) ?? ""),
      persona_override:
        body.persona_override === undefined
          ? prev.persona_override
          : Boolean(body.persona_override),
    };
  }

  // selection/context の組み立てと effort の同期は上で処理済み。
  const mapped = new Set([
    "preset",
    "effort",
    "context_text",
    "persona_override",
    "context_clear",
  ]);
  for (const [k, v] of Object.entries(body)) {
    if (!mapped.has(k)) next[k] = v;
  }
  return next as T;
}

/** 「保存済み」の印を出しておく時間。 */
const SAVED_MARK_MS = 3200;

/**
 * PATCH の往復を待たずに画面を更新する。
 * 保存完了まで選択が動かないと体感が遅れるため。失敗時は最後にサーバーが
 * 受け付けた値へ戻す。結果は行の印（marks）と保存状態（save）で返し、
 * 失敗の理由だけ onError に渡す。
 *
 * 連打はキューに積んで in-flight 中の分をまとめる。guild PATCH は行全体の
 * 読み書きなので、同時に 2 本飛ばすと先に返った古い選択で上書きされる。
 */
export function useOptimisticPatch<T extends OverlaySettings>(opts: {
  settings: T | null;
  setSettings: (next: T) => void;
  presets: Preset[];
  send: (body: Record<string, unknown>) => Promise<{ settings: T }>;
  onError: (message: string) => void;
  scope?: string;
  /** マイ設定の「デフォルト」は null。サーバー設定のリセットとは表示を分ける。 */
  blankReset?: boolean;
}): { patch: PatchFn; save: SaveState; marks: SaveMarks } {
  const [save, setSave] = useState<SaveState>("idle");
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [pulses, setPulses] = useState<Record<string, Pulse>>({});
  const markTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pulseSeq = useRef(0);
  const settingsRef = useRef(opts.settings);
  settingsRef.current = opts.settings;
  const confirmedRef = useRef<T | null>(null);
  const pendingRef = useRef<{ body: Record<string, unknown>; row: string }[]>(
    [],
  );
  const sendingRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const lastScope = useRef(opts.scope);
  const scopeChanged = lastScope.current !== opts.scope;
  if (scopeChanged) {
    lastScope.current = opts.scope;
    confirmedRef.current = null;
    pendingRef.current = [];
    sendingRef.current = false;
  }
  // サーバー切替の同じ描画では前ギルドの settings が残っているので、種まきしない。
  if (!scopeChanged && confirmedRef.current == null && opts.settings) {
    confirmedRef.current = opts.settings;
  }

  const clearMarkTimers = () => {
    for (const timer of Object.values(markTimers.current)) clearTimeout(timer);
    markTimers.current = {};
  };
  useEffect(() => {
    setSave("idle");
    setMarks({});
    setPulses({});
    clearMarkTimers();
  }, [opts.scope]);
  useEffect(() => clearMarkTimers, []);

  const setMark = useCallback((rows: string[], mark: Mark) => {
    if (rows.length === 0) return;
    setMarks((m) => ({ ...m, ...Object.fromEntries(rows.map((r) => [r, mark])) }));
    for (const row of rows) {
      clearTimeout(markTimers.current[row]);
      if (mark !== "saved") continue;
      markTimers.current[row] = setTimeout(() => {
        setMarks((m) => {
          if (m[row] !== "saved") return m;
          const { [row]: _done, ...rest } = m;
          return rest;
        });
      }, SAVED_MARK_MS);
    }
  }, []);
  const pulse = useCallback((rows: string[], failed: boolean) => {
    setPulses((p) => ({
      ...p,
      ...Object.fromEntries(rows.map((r) => [r, { n: ++pulseSeq.current, failed }])),
    }));
  }, []);

  const flush = useCallback(() => {
    if (sendingRef.current) return;
    const batch = pendingRef.current;
    if (batch.length === 0) return;
    pendingRef.current = [];
    sendingRef.current = true;
    const merged = Object.assign({}, ...batch.map((x) => x.body)) as Record<
      string,
      unknown
    >;
    const rows = [...new Set(batch.map((x) => x.row))];
    const scope = lastScope.current;
    setSave("saving");

    void (async () => {
      const { send, setSettings, onError, presets, blankReset } = optsRef.current;
      try {
        const r = await send(merged);
        // 応答を待つ間に別のサーバーへ移っていたら、前のサーバーの結果は捨てる。
        if (scope !== lastScope.current) return;
        confirmedRef.current = r.settings;
        if (pendingRef.current.length === 0) {
          setSettings(r.settings);
          settingsRef.current = r.settings;
          setSave("saved");
        } else {
          // 後続クリックを消さない: サーバー行の上にまだ送っていない PATCH を載せる。
          let next = r.settings;
          for (const p of pendingRef.current)
            next = applyLocalPatch(next, p.body, presets, blankReset);
          setSettings(next);
          settingsRef.current = next;
        }
        // 同じ行にまだ送っていない変更があれば、その行は「保存中」のままにする。
        const queued = new Set(pendingRef.current.map((x) => x.row));
        setMark(rows.filter((row) => !queued.has(row)), "saved");
      } catch (e) {
        if (scope !== lastScope.current) return;
        if (pendingRef.current.length === 0) {
          const rollback = confirmedRef.current;
          if (rollback) {
            setSettings(rollback);
            settingsRef.current = rollback;
          }
          setSave("failed");
        }
        setMark(rows, "failed");
        pulse(rows, true);
        onError(String((e as Error).message ?? e));
      } finally {
        if (scope === lastScope.current) {
          sendingRef.current = false;
          flush();
        }
      }
    })();
  }, [pulse, setMark]);

  const patch = useCallback<PatchFn>(
    (body, row) => {
      const current = settingsRef.current;
      if (!current) return;
      const next = applyLocalPatch(current, body, optsRef.current.presets, optsRef.current.blankReset);
      optsRef.current.setSettings(next);
      settingsRef.current = next;
      pendingRef.current.push({ body, row });
      setSave("saving");
      setMark([row], "saving");
      pulse([row], false);
      flush();
    },
    [flush, pulse, setMark],
  );

  return { patch, save, marks: { marks, pulses } };
}

/* ============================================================
   コンテキスト
   ============================================================ */
/** context はうっかり消えると痛いので、明示的な保存ボタンにする（他は即時保存）。 */
export function ContextSection({
  scope,
  value,
  personaOverride,
  draft,
  onDraft,
  patch,
}: {
  scope: "guild" | "me";
  value: string;
  personaOverride: boolean;
  /** 書きかけの文章。ページを行き来しても残せるよう、持ち主は呼び出し側。 */
  draft: string | null;
  onDraft: (text: string | null) => void;
  patch: PatchFn;
}) {
  const inherit = scope === "me";
  const px = inherit ? "me" : "g";
  const text = draft ?? value;
  const dirty = text !== value;
  // 保存や巻き戻しで保存値が書きかけと同じになったら、書きかけを手放す。
  useEffect(() => {
    if (draft !== null && draft === value) onDraft(null);
  }, [draft, value, onDraft]);

  return (
    <Section
      id="context"
      title={inherit ? "ユーザーコンテキスト" : "サーバーコンテキスト"}
      desc={inherit
        ? "空のままならサーバーのコンテキストに従います。文章を保存したときだけ、あなたへの応答に追加します。"
        : "このサーバーでの応答に常に添える前提テキスト。"}
    >
      <div className="rows">
        <Row
          k={`${px}-context`}
          name="テキスト"
          htmlFor="ctx-text"
          block
          overridden={inherit && !!value}
          after={
            <div className="sec-foot">
              <span>
                <span className="mono">{text.length.toLocaleString()}</span> 文字
                {dirty && (
                  <>
                    {" · "}
                    <strong>未保存の変更あり</strong>
                  </>
                )}
              </span>
              <span className="cell-actions">
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    onDraft(null);
                    patch({ context_clear: true }, `${px}-context`);
                  }}
                >
                  <Icon.trash size={14} />
                  クリア
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!dirty}
                  onClick={() => patch({ context_text: text || null }, `${px}-context`)}
                >
                  保存
                </button>
              </span>
            </div>
          }
        >
          <textarea
            className="textarea"
            id="ctx-text"
            value={text}
            onChange={(e) => onDraft(e.target.value)}
            placeholder={inherit ? "例: タメ口で話して。敬語は禁止。" : "例: このサーバーは…"}
          />
        </Row>
        <Row
          k={`${px}-persona`}
          name="persona override"
          mono
          inline
          hint="ON にすると既定ペルソナをこのテキストで置き換えます。"
        >
          {(nameId) => (
            <BoolSeg
              labelledBy={nameId}
              value={personaOverride}
              onChange={(v) => patch({ persona_override: v }, `${px}-persona`)}
            />
          )}
        </Row>
      </div>
    </Section>
  );
}

/** マイ設定の要約に出す、コンテキストの状態。 */
export function personalContextLabel(
  ctx: { text: string; persona_override: boolean } | null | undefined,
): string {
  if (!ctx || (!ctx.text.trim() && !ctx.persona_override)) return "デフォルト";
  if (!ctx.text.trim()) return "人格上書きのみ";
  return `${ctx.text.length.toLocaleString()} 文字`;
}
