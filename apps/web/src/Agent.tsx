import {
  defaultMultiAgentRoles,
  MULTI_AGENT_ROLES,
  SERVICE_TIERS,
  subagentMode,
  subagentModePatch,
  type MultiAgentRole,
  type MultiAgentRoles,
  type RoleEffort,
  type RoleModel,
  type SubagentMode,
} from "@hibana/shared/settings";
import {
  AUTO_ROUTE_FALLBACK,
  REASONING_EFFORTS,
  isAutoRoute,
  subagentsUnsupported,
} from "@hibana/shared/catalog";
import { useState } from "react";
import type { Catalog } from "./api";
import { Select } from "./controls";
import {
  FixedModelButton,
  ModelDialog,
  matchesSelection,
  roleAllows,
} from "./ModelPicker";
import { Row, RowMark, Trace } from "./save";
import type { OverlaySettings, PatchFn } from "./settings";
import {
  BoolSeg,
  Icon,
  ProviderTile,
  Section,
  providerMeta,
  type EffectiveItem,
} from "./ui";

/* ============================================================
   エージェント: モデル・サブエージェント・Jev
   互いの値で動きが変わる設定なので、同じページに置く。
   ============================================================ */

const onOff = (v: boolean | null | undefined) => (v === true ? "ON" : "OFF");

/** 保存した設定のうち、互いの値で動きが変わるものを読み解く（bot の resolve と同じ決め方）。 */
function interplay(s: OverlaySettings) {
  const selection = s.selection;
  const auto =
    !!selection?.provider &&
    !!selection.model &&
    isAutoRoute({ provider: selection.provider, model: selection.model });
  // Anthropic のターンはサブエージェントなしで動く。保存値は残り、他のプロバイダで使われる。
  const noSubagents = subagentsUnsupported(selection?.provider);
  const mode = subagentMode(s);
  return {
    auto,
    noSubagents,
    mode,
    ultraActive: mode === "ultra" && !noSubagents,
    multiActive: mode === "multi" && !noSubagents,
  };
}

/**
 * サーバー設定の「実際の動作」。保存値ではなく、設定の組み合わせから決まる値を出す。
 * 根拠: docs/jev.md（Anthropic の auto routing）、docs/ultracode.md、apps/bot の resolve。
 * bot の環境変数や接続の状態までは分からないので、見出しの説明でそう断る。
 */
export function guildEffective(s: OverlaySettings): EffectiveItem[] {
  const { auto, noSubagents, mode, ultraActive, multiActive } = interplay(s);
  const selection = s.selection;
  const savedEffort = s.effort ?? selection?.effort ?? "max";
  const jev = s.jev_enabled === true;
  const items: EffectiveItem[] = [];

  if (auto && jev) {
    // どのモデルが候補かは routing の表（docs/jev.md）で決まり、表はよく変わるので、ここには書かない。
    items.push({
      label: "モデル",
      value: "Jev が会話ごとに選ぶ",
      note: "依頼の難易度と、依頼でのモデルの指定で決まります。",
    });
  } else if (auto) {
    items.push({
      label: "モデル",
      value: AUTO_ROUTE_FALLBACK.model,
      note: "Jev 判定が OFF のため、Auto は毎回このモデルで応答します。",
      warn: true,
    });
  } else if (selection?.model) {
    items.push({
      label: "モデル",
      value: selection.model,
      note: providerMeta(selection.provider).label,
    });
  } else {
    items.push({ label: "モデル", value: "env 既定", note: "bot の環境変数の既定" });
  }

  if (auto) {
    items.push({
      label: "effort",
      value: jev ? "Jev が決める" : AUTO_ROUTE_FALLBACK.effort,
      note: jev
        ? `保存値 ${savedEffort} は使われません。`
        : `Jev 判定が OFF の間の固定値です。保存値 ${savedEffort} は使われません。`,
      unused: true,
    });
  } else if (ultraActive) {
    items.push({
      label: "effort",
      value: "xhigh",
      note: `ultra の間。保存値 ${savedEffort} は ultra を外すと使われます。`,
      unused: true,
    });
  } else {
    items.push({ label: "effort", value: savedEffort });
  }

  if (noSubagents) {
    items.push({
      label: "サブエージェント",
      value: "off",
      note:
        mode === "off"
          ? "Anthropic のモデルでは常に off。"
          : `Anthropic のモデルでは常に off。保存値 ${mode} は他のモデルに切り替えると使われます。`,
      unused: mode !== "off",
    });
  } else {
    items.push({
      label: "サブエージェント",
      value: mode,
      note: mode === "multi" ? "統括役が調査・作成・検証に分担" : undefined,
    });
  }

  items.push({ label: "Jev 判定", value: onOff(s.jev_enabled) });
  if (multiActive && s.jev_task_enabled === true) {
    items.push({
      label: "Jev 行動選択",
      value: "使わない",
      note: "multi では並列の分担を優先します。保存値は ON。",
      unused: true,
    });
  } else {
    items.push({ label: "Jev 行動選択", value: onOff(s.jev_task_enabled) });
  }
  return items;
}

const SUBAGENT_MODES: { mode: SubagentMode; body: string }[] = [
  { mode: "off", body: "サブエージェントを使わず、親だけで処理します。" },
  { mode: "on", body: "ユーザーや指示で求められたときだけ委譲します。「ultracode」と書いた依頼はその回だけワークフローで実行します。" },
  { mode: "ultra", body: "Claude Code の Ultracode です。推論を xhigh にし、実質的な依頼ごとにワークフロー（複数エージェントを編成するスクリプト）を実行します。" },
  { mode: "multi", body: "統括役が調査・作成・検証に分担し、納品前に検証します。" },
];

const ROLE_META: Record<MultiAgentRole, { label: string; body: string }> = {
  explorer: { label: "調査", body: "検索・Web・ファイルを読むだけで根拠を集めます。" },
  worker: { label: "作成", body: "ファイル・コードなどの成果物を作ります。送信や公開はしません。" },
  reviewer: { label: "検証", body: "回答案や成果物を独立に確認します。納品前のレビューも担当します。" },
};

const ANTHROPIC_NO_SUBAGENTS =
  "Anthropic のモデル（Auto を含む）ではサブエージェントは常に off で動き、この設定は他のモデルに切り替えると使われます。";
const EFFORT_UNDER_ULTRA =
  "サブエージェントが ultra（Ultracode）の間は xhigh で動き、この値は ultra を外すと使われます。";
const EFFORT_UNDER_AUTO =
  "Anthropic / Auto では Jev の判定でモデルと effort（max は使いません）が決まり、この値は使われません。";
const JEV_TASK_UNDER_MULTI =
  "サブエージェントが multi のときは並列の分担を優先するため使用しません。";
const SERVER_DEFAULT = "デフォルト（サーバー設定）";

type FixedEffort = Extract<RoleEffort, { mode: "fixed" }>["effort"];

/** Mirrors the bot's explorer cap (roleEffort) for the effective-value hint. */
function capEffort(effort: string, cap: string): string {
  const order: readonly string[] = REASONING_EFFORTS;
  if (!order.includes(effort)) return effort;
  return order[Math.min(order.indexOf(effort), order.indexOf(cap))]!;
}

/**
 * モデル・サブエージェント・Jev の 3 節。互いの値で動きが変わるので同じ面に置く。
 * `scope="me"` はマイ設定: null は「サーバー設定に従う」デフォルトで、変えた項目だけ上書きになる。
 */
export function AgentSections({
  scope,
  catalog: c,
  settings: s,
  role,
  patch,
}: {
  scope: "guild" | "me";
  catalog: Catalog;
  settings: OverlaySettings;
  role?: string;
  patch: PatchFn;
}) {
  const inherit = scope === "me";
  const px = inherit ? "me" : "g";
  const [picking, setPicking] = useState(false);

  // Admin catalog includes unpublished SKUs for /models. Guild / マイ設定
  // pickers must not list them — leftover guilds already on one still show
  // as selected via provider+model, they just cannot newly pick it.
  const pickable = c.presets.filter((p) => p.published !== false);
  const current = c.presets.find((p) => matchesSelection(p, s.selection)) ?? null;
  const { auto, noSubagents, ultraActive, multiActive } = interplay(s);

  // All three switches null is デフォルト. subagentMode() would otherwise
  // read that as "on", because a missing Ultra flag is not Ultra.
  const modeDefault =
    inherit && s.subagent_enabled == null && s.ultra_mode == null && s.multi_agent == null;
  const mode: SubagentMode | "default" = modeDefault ? "default" : subagentMode(s);
  const modeChoices: { mode: SubagentMode | "default"; body: string }[] = inherit
    ? [{ mode: "default", body: "サーバー設定に従います。ここを変えると、このモードだけ上書きします。" }, ...SUBAGENT_MODES]
    : SUBAGENT_MODES;

  const efforts = c.efforts.filter((e) => e !== "ultra");
  const firstPreset = () =>
    pickable.find((p) => roleAllows(role, p.min_role, c.roles) &&
      (!c.available_presets || c.available_presets.includes(p.id)))?.id;
  const roles = s.multi_agent_roles ?? defaultMultiAgentRoles();
  const rolesRow = `${px}-roles`;
  // Send the whole role map so the optimistic overlay never shows a partial one.
  const patchRole = (r: MultiAgentRole, change: Partial<MultiAgentRoles[MultiAgentRole]>) =>
    patch({ multi_agent_roles: { ...roles, [r]: { ...roles[r], ...change } } }, rolesRow);
  const presetName = (id: string) => {
    const p = c.presets.find((x) => x.id === id);
    return p?.model ?? p?.label ?? id;
  };
  const parentModel = s.selection?.model ?? (inherit ? "サーバー設定" : "既定のモデル");
  const parentEffort = s.effort ?? s.selection?.effort ?? (inherit ? "サーバー設定" : "既定");
  const common = {
    model: s.subagent_model ?? (inherit ? null : { mode: "auto" as const }),
    effort: s.subagent_effort ?? (inherit ? null : { mode: "auto" as const }),
  };
  // What the bot will actually use, so "only the reviewer on Sol" is visible
  // without mentally combining the common policy and the role override.
  const effectiveModel = (p: RoleModel) => {
    const policy = p.mode === "default" ? common.model : p;
    if (!policy || !("mode" in policy)) return "サーバー設定";
    if (policy.mode === "fixed") return presetName(policy.preset);
    if (policy.mode === "same") return parentModel;
    return `${parentModel}（任意）`;
  };
  const effectiveEffort = (r: MultiAgentRole, p: RoleEffort) => {
    const policy = p.mode === "default" ? common.effort : p;
    if (!policy || !("mode" in policy)) return "サーバー設定";
    if (policy.mode === "fixed") return policy.effort;
    if (policy.mode === "same") return parentEffort;
    return `${r === "explorer" ? capEffort(String(parentEffort), "medium") : parentEffort}（任意）`;
  };

  // サーバー設定は、使われない値をその行に印で示す。マイ設定は、サーバー側の値が
  // 分からないと言い切れないので、今までどおり説明文に書き添える。
  const effortUnused = inherit ? undefined : auto ? EFFORT_UNDER_AUTO : ultraActive ? EFFORT_UNDER_ULTRA : undefined;
  const effortHint = inherit
    ? `デフォルトはサーバーの effort です。モデルを変えるとそのモデルの推奨値になります。${mode === "ultra" ? ` ${EFFORT_UNDER_ULTRA}` : ""}${auto ? ` ${EFFORT_UNDER_AUTO}` : ""}`
    : "推論の深さ。モデルを変えるとそのモデルの推奨値になります。";
  const jevMulti = s.multi_agent === true || (!inherit && subagentMode(s) === "multi");
  const serverDefault = inherit ? " デフォルトはサーバー設定です。" : "";

  return (
    <>
      <Section
        id="model"
        title="/switch モデル"
        desc="親エージェントのモデルです。サブエージェントが multi のときは統括役が使います。"
      >
        <div className="rows">
          <Row k={`${px}-preset`} name="モデル" block overridden={inherit && !!s.selection}>
            <div className="model-card frame">
              {s.selection?.model ? (
                <>
                  <ProviderTile provider={s.selection.provider} large />
                  <div className="model-meta">
                    <div className="model-id">{s.selection.model}</div>
                    <div className="model-sub">
                      {providerMeta(s.selection.provider).label}
                      {current && (
                        <>
                          {" · "}
                          <span className="mono">{current.id}</span>
                        </>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <span className="mono-tile lg" aria-hidden="true">
                    —
                  </span>
                  <div className="model-meta">
                    <div className="model-id is-text">{inherit ? "デフォルト" : "env 既定"}</div>
                    <div className="model-sub">
                      {inherit ? "サーバー設定に従います" : "bot の環境変数の既定"}
                    </div>
                  </div>
                </>
              )}
              <div className="model-actions">
                <button
                  type="button"
                  className="btn"
                  aria-label="モデルを変更"
                  aria-haspopup="dialog"
                  aria-expanded={picking}
                  onClick={() => setPicking(true)}
                >
                  変更
                </button>
                {inherit && s.selection && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => patch({ preset: "reset" }, `${px}-preset`)}
                  >
                    デフォルトに戻す
                  </button>
                )}
              </div>
            </div>
            <ModelDialog
              open={picking}
              onClose={() => setPicking(false)}
              title="モデルを選ぶ"
              presets={pickable}
              available={c.available_presets}
              isSelected={(p) => matchesSelection(p, s.selection)}
              role={role}
              roles={c.roles}
              special={inherit ? {
                label: "デフォルト",
                sub: "サーバー設定に従う",
                active: !s.selection,
                onSelect: () => {
                  patch({ preset: "reset" }, `${px}-preset`);
                  setPicking(false);
                },
              } : undefined}
              onPick={(id) => {
                patch({ preset: id }, `${px}-preset`);
                setPicking(false);
              }}
            />
          </Row>

          <Row
            k={`${px}-effort`}
            name="effort"
            mono
            htmlFor={`${px}-effort-sel`}
            hint={effortHint}
            unused={effortUnused}
            overridden={inherit && s.effort != null}
          >
            <Select
              id={`${px}-effort-sel`}
              value={inherit ? (s.effort ?? "") : (s.effort ?? s.selection?.effort ?? "max")}
              onValueChange={(e) => patch({ effort: e || null }, `${px}-effort`)}
            >
              {inherit && <option value="">{SERVER_DEFAULT}</option>}
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          </Row>

          <Row
            k={`${px}-tier`}
            name="Service Tier"
            mono
            htmlFor={`${px}-tier-sel`}
            hint="OpenAI / Codex / ChatGPT に適用し、サブエージェントにも引き継ぎます。利用可否・料金・速度は接続先によります。"
            overridden={inherit && s.service_tier != null}
          >
            <Select
              id={`${px}-tier-sel`}
              aria-label="Service Tier"
              value={inherit ? (s.service_tier ?? "") : (s.service_tier ?? "auto")}
              onValueChange={(tier) => patch({ service_tier: tier || null }, `${px}-tier`)}
            >
              {inherit && <option value="">{SERVER_DEFAULT}</option>}
              {SERVICE_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </Select>
          </Row>
        </div>
        {!inherit && (
          <div className="sec-foot">
            <span>
              現在: <span className="mono">{s.selection?.model ?? "env 既定"}</span>
            </span>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => patch({ preset: "reset" }, `${px}-preset`)}
            >
              <Icon.reset size={14} />
              デフォルトに戻す
            </button>
          </div>
        )}
      </Section>

      <Section
        id="agents"
        title="サブエージェント"
        desc={`変更は次のメッセージから反映され、処理中の応答には適用されません。${inherit && noSubagents ? ` ${ANTHROPIC_NO_SUBAGENTS}` : ""}`}
      >
        <div className="rows">
          <Row
            k={`${px}-mode`}
            name="モード"
            block
            unused={!inherit && noSubagents && mode !== "off" ? ANTHROPIC_NO_SUBAGENTS : undefined}
            overridden={inherit && !modeDefault}
          >
            <div className={`modes${inherit ? " has-default" : ""}`} role="radiogroup" aria-label="サブエージェント">
              {modeChoices.map((o) => (
                <button
                  key={o.mode}
                  type="button"
                  role="radio"
                  aria-checked={mode === o.mode}
                  className="mode"
                  onClick={() => {
                    if (mode === o.mode) return;
                    patch(o.mode === "default"
                      ? { subagent_enabled: null, ultra_mode: null, multi_agent: null }
                      : subagentModePatch(o.mode), `${px}-mode`);
                  }}
                >
                  <span className={`mode-name${o.mode === "default" ? " is-text" : ""}`}>
                    {o.mode === "default" ? "デフォルト" : o.mode}
                  </span>
                  <span className="mode-body">{o.body}</span>
                </button>
              ))}
            </div>
          </Row>
        </div>

        {mode !== "off" && (
          <>
            <div className="subhead">
              <h3>共通のモデルと effort</h3>
              <p>{mode === "multi" ? "役割ごとの設定が「共通設定に従う」のときに使います。" : "すべてのサブエージェントに適用します。"}</p>
            </div>
            <div className="rows">
              <Row
                k={`${px}-sub-model`}
                name="モデル"
                overridden={inherit && s.subagent_model != null}
                after={s.subagent_model?.mode === "fixed" && (
                  <FixedModelButton
                    label="固定モデル" title="サブエージェントの固定モデル"
                    presets={pickable} available={c.available_presets}
                    value={s.subagent_model.preset} role={role} roles={c.roles}
                    onChange={(preset) => patch({ subagent_model: { mode: "fixed", preset } }, `${px}-sub-model`)}
                  />
                )}
              >
                <Select
                  aria-label="サブエージェントのモデル選択方式"
                  value={common.model?.mode ?? ""}
                  onValueChange={(next) => {
                    if (!next) {
                      patch({ subagent_model: null }, `${px}-sub-model`);
                      return;
                    }
                    const preset = firstPreset();
                    if (next === "fixed" && !preset) return;
                    patch({ subagent_model: next === "fixed"
                      ? { mode: next, preset: s.subagent_model?.mode === "fixed" ? s.subagent_model.preset : preset }
                      : { mode: next } }, `${px}-sub-model`);
                  }}
                >
                  {inherit && <option value="">{SERVER_DEFAULT}</option>}
                  <option value="auto">任意（エージェントが選択）</option>
                  <option value="same">同一（親エージェントと同じ）</option>
                  <option value="fixed">固定（指定したモデル）</option>
                </Select>
              </Row>
              <Row
                k={`${px}-sub-effort`}
                name="effort"
                mono
                overridden={inherit && s.subagent_effort != null}
                after={s.subagent_effort?.mode === "fixed" && (
                  <Select
                    aria-label="サブエージェントの固定 effort"
                    value={s.subagent_effort.effort}
                    onValueChange={(effort) => patch({ subagent_effort: { mode: "fixed", effort } }, `${px}-sub-effort`)}
                  >
                    {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
                  </Select>
                )}
              >
                <Select
                  aria-label="サブエージェントの effort 選択方式"
                  value={common.effort?.mode ?? ""}
                  onValueChange={(next) => {
                    if (!next) {
                      patch({ subagent_effort: null }, `${px}-sub-effort`);
                      return;
                    }
                    patch({ subagent_effort: next === "fixed"
                      ? { mode: next, effort: s.subagent_effort?.mode === "fixed" ? s.subagent_effort.effort : "max" }
                      : { mode: next } }, `${px}-sub-effort`);
                  }}
                >
                  {inherit && <option value="">{SERVER_DEFAULT}</option>}
                  <option value="auto">任意（エージェントが選択）</option>
                  <option value="same">同一（親エージェントと同じ）</option>
                  <option value="fixed">固定（指定した effort）</option>
                </Select>
              </Row>
            </div>
            <p className="note pad">
              任意ではエージェントがモデルや effort を指定でき、省略すると親を引き継ぎます。別モデルに変えた場合の effort はそのモデルの推奨値です。役割ごとの表示の「（任意）」は、エージェントが変更できる値です。
            </p>
          </>
        )}

        {mode === "multi" && inherit && !s.multi_agent_roles && (
          <div className="sec-foot">
            <span>役割ごとの設定はサーバーに従っています。</span>
            <span className="cell-actions">
              <button type="button" className="btn btn-sm"
                onClick={() => patch({ multi_agent_roles: defaultMultiAgentRoles() }, rolesRow)}>
                役割を個別に設定
              </button>
              <RowMark k={rolesRow} />
            </span>
          </div>
        )}
        {mode === "multi" && (!inherit || s.multi_agent_roles) && (
          <>
            <div className="subhead">
              <h3>役割ごとの設定</h3>
              <p>{inherit ? "変えた役割だけを保存します。デフォルトに戻すとサーバーの役割設定に従います。" : "役割ごとにモデルと effort を上書きできます。"}</p>
              <RowMark k={rolesRow} />
            </div>
            <div data-row={rolesRow}>
              <Trace k={rolesRow}>
                <div className="table-wrap">
                  <table className="roles stack">
                    <thead>
                      <tr>
                        <th>役割</th>
                        <th>モデル</th>
                        <th>effort</th>
                        <th>実際の設定</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td className="full">
                          <div className="role-name">統括役 <span className="mono muted">root</span></div>
                          <div className="role-body">分担・統合・納品を担当します。</div>
                        </td>
                        <td className="full muted" colSpan={2}>
                          モデルと effort は「/switch モデル」で変更します。
                        </td>
                        <td data-label="実際の設定">
                          <div className="eff" aria-label="統括役の実際の設定">
                            <span>{parentModel}</span>
                            <span>{parentEffort}</span>
                          </div>
                        </td>
                      </tr>
                      {MULTI_AGENT_ROLES.map((r) => {
                        const meta = ROLE_META[r];
                        const policy = roles[r];
                        return (
                          <tr key={r}>
                            <td className="full">
                              <div className="role-name">{meta.label} <span className="mono muted">{r}</span></div>
                              <div className="role-body">{meta.body}</div>
                            </td>
                            <td data-label="モデル">
                              <div className="stack-fields">
                                <Select aria-label={`${meta.label}のモデル`}
                                  value={policy.model.mode}
                                  onValueChange={(next) => {
                                    if (next === "fixed") {
                                      const preset = policy.model.mode === "fixed" ? policy.model.preset : firstPreset();
                                      if (preset) patchRole(r, { model: { mode: "fixed", preset } });
                                    } else patchRole(r, { model: { mode: next as "default" | "same" } });
                                  }}>
                                  <option value="default">共通設定に従う</option>
                                  <option value="same">親と同じ</option>
                                  <option value="fixed">固定</option>
                                </Select>
                                {policy.model.mode === "fixed" && (
                                  <FixedModelButton
                                    label={`${meta.label}の固定モデル`} title={`${meta.label}の固定モデル`}
                                    presets={pickable} available={c.available_presets}
                                    value={policy.model.preset} role={role} roles={c.roles}
                                    onChange={(preset) => patchRole(r, { model: { mode: "fixed", preset } })}
                                  />
                                )}
                              </div>
                            </td>
                            <td data-label="effort">
                              <div className="stack-fields">
                                <Select aria-label={`${meta.label}の effort`}
                                  value={policy.effort.mode}
                                  onValueChange={(next) => patchRole(r, { effort: next === "fixed"
                                    ? { mode: "fixed", effort: policy.effort.mode === "fixed" ? policy.effort.effort : "high" }
                                    : { mode: next as "default" | "same" } })}>
                                  <option value="default">共通設定に従う</option>
                                  <option value="same">親と同じ</option>
                                  <option value="fixed">固定</option>
                                </Select>
                                {policy.effort.mode === "fixed" && (
                                  <Select aria-label={`${meta.label}の固定 effort`}
                                    value={policy.effort.effort}
                                    onValueChange={(effort) => patchRole(r, { effort: { mode: "fixed", effort: effort as FixedEffort } })}>
                                    {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
                                  </Select>
                                )}
                              </div>
                            </td>
                            <td data-label="実際の設定">
                              <div className="eff" aria-label={`${meta.label}の実際の設定`}>
                                <span>{effectiveModel(policy.model)}</span>
                                <span>{effectiveEffort(r, policy.effort)}</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Trace>
            </div>
            {inherit && (
              <div className="sec-foot">
                <span />
                <button type="button" className="btn btn-ghost btn-sm"
                  onClick={() => patch({ multi_agent_roles: null }, rolesRow)}>
                  <Icon.reset size={14} />
                  デフォルトに戻す
                </button>
              </div>
            )}
          </>
        )}
      </Section>

      <Section
        id="jev"
        title="Jev"
        desc="分類専用の評価モデルです。回答の生成や親のモデルは変えません。"
      >
        <div className="rows">
          <Row
            k={`${px}-jev`}
            name="Jev 判定"
            inline
            hint={`根拠の照合・分類に使います。${jevMulti ? "multi では依頼の開始時に分担も判定し、調査が必要なら調査役を先に起動します。" : ""}${serverDefault}`}
            overridden={inherit && s.jev_enabled != null}
            after={!inherit && auto && s.jev_enabled !== true && (
              <p className="row-unused">
                <Icon.alert size={13} />
                <span>
                  <strong>Anthropic / Auto を選択中です。</strong>
                  Jev 判定が OFF の間は、毎回 {AUTO_ROUTE_FALLBACK.model} / {AUTO_ROUTE_FALLBACK.effort} で応答します。
                </span>
              </p>
            )}
          >
            {(nameId) => (
              <BoolSeg
                labelledBy={nameId}
                value={s.jev_enabled}
                onChange={(v) => patch({ jev_enabled: v }, `${px}-jev`)}
                onDefault={inherit ? () => patch({ jev_enabled: null }, `${px}-jev`) : undefined}
              />
            )}
          </Row>
          <Row
            k={`${px}-jev-task`}
            name="Jev 行動選択モード"
            inline
            hint={`親が操作候補を用意し、Jev が各操作を選んで実行します。Jev 判定とは独立しています。${jevMulti ? JEV_TASK_UNDER_MULTI : "既定は OFF です。"}${serverDefault}`}
            unused={!inherit && multiActive && s.jev_task_enabled === true ? "multi の間は、保存した値を保ったまま実行しません。" : undefined}
            overridden={inherit && s.jev_task_enabled != null}
          >
            {(nameId) => (
              <BoolSeg
                labelledBy={nameId}
                value={s.jev_task_enabled}
                onChange={(v) => patch({ jev_task_enabled: v }, `${px}-jev-task`)}
                onDefault={inherit ? () => patch({ jev_task_enabled: null }, `${px}-jev-task`) : undefined}
              />
            )}
          </Row>
        </div>
      </Section>
    </>
  );
}
