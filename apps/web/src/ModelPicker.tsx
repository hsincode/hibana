import { useEffect, useMemo, useState } from "react";
import type { Preset } from "./api";
import { Badge, Icon, Modal, ProviderTile, providerMeta } from "./ui";

/** catalog.roles は強い順。未指定 minRole = 誰でも。未知の role は free 扱い。 */
export function roleAllows(
  userRole: string | undefined,
  minRole: string | undefined,
  roles: string[] | undefined,
): boolean {
  if (!minRole) return true;
  const order =
    roles && roles.length > 0
      ? roles
      : ["administrator", "moderator", "premium", "standard", "free"];
  const u = order.indexOf((userRole ?? "free").toLowerCase());
  const m = order.indexOf(minRole.toLowerCase());
  if (m < 0) return true;
  if (u < 0) return false;
  return u <= m;
}

export const presetModel = (p: Preset): string =>
  p.model ?? p.label.split("/").slice(1).join("/").trim() ?? p.id;

/** /switch の保存値は provider + model なので、それで選択中のプリセットを探す。 */
export function matchesSelection(
  p: Preset,
  selection: { provider?: string; model?: string } | null | undefined,
): boolean {
  return (
    !!selection?.model &&
    selection.model === (p.model ?? p.label.split("/").pop()?.trim()) &&
    (!selection.provider || !p.provider || selection.provider === p.provider)
  );
}

/**
 * モデルを選ぶダイアログ。
 * preset は十数件あり provider がバラバラなので、文字とプロバイダで絞り込める一覧にしている。
 */
export function ModelDialog({
  open,
  onClose,
  title,
  presets,
  available,
  isSelected,
  special,
  role,
  roles,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  presets: Preset[];
  /** ボットが今使える preset id。未定義なら全部使える扱い。 */
  available?: string[];
  isSelected: (p: Preset) => boolean;
  /** モデル以外の選択肢（マイ設定の「デフォルト」）。 */
  special?: { label: string; sub: string; active: boolean; onSelect: () => void };
  role?: string;
  roles?: string[];
  onPick: (presetId: string) => void;
}) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  // 開くたびに、絞り込みの無い一覧から始める。
  useEffect(() => {
    if (open) {
      setFilter("all");
      setQuery("");
    }
  }, [open]);

  const keyOf = (p: Preset) => p.provider ?? providerMeta(undefined, p.label).label;
  // 出現順を保ったままプロバイダを集計する（カタログの並び = 推奨順）
  const providers = useMemo(() => {
    const acc: { key: string; count: number; label: string }[] = [];
    for (const p of presets) {
      const key = keyOf(p);
      const hit = acc.find((x) => x.key === key);
      if (hit) hit.count += 1;
      else acc.push({ key, count: 1, label: providerMeta(p.provider, p.label).label });
    }
    return acc;
  }, [presets]);

  const needle = query.trim().toLowerCase();
  const shown = presets.filter((p) => {
    if (filter !== "all" && keyOf(p) !== filter) return false;
    if (!needle) return true;
    const meta = providerMeta(p.provider, p.label);
    return `${presetModel(p)} ${p.id} ${meta.label} ${p.label}`
      .toLowerCase()
      .includes(needle);
  });

  return (
    <Modal open={open} onClose={onClose} title={title} size="wide">
      <div className="picker-tools">
        <label className="search">
          <span className="sr">モデルを絞り込む</span>
          <Icon.search />
          <input
            className="input"
            type="search"
            value={query}
            placeholder="モデル名 / プロバイダ / preset で絞り込み"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="chips-filter" role="group" aria-label="プロバイダで絞り込み">
          <button
            type="button"
            className="chip-f"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            すべて <span className="mono">{presets.length}</span>
          </button>
          {providers.map((pv) => (
            <button
              key={pv.key}
              type="button"
              className="chip-f"
              aria-pressed={filter === pv.key}
              onClick={() => setFilter(pv.key)}
            >
              {pv.label} <span className="mono">{pv.count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="picker-list">
        {special && (
          <button
            type="button"
            className="picker-row"
            aria-pressed={special.active}
            onClick={special.onSelect}
          >
            <span className="mono-tile" aria-hidden="true">
              —
            </span>
            <span className="p-model is-text">{special.label}</span>
            <span className="p-prov">{special.sub}</span>
            <span className="p-id" />
            <span className="p-tags">{special.active && <Icon.check />}</span>
          </button>
        )}
        {shown.map((p) => {
          const meta = providerMeta(p.provider, p.label);
          const selected = isSelected(p);
          const offline = Array.isArray(available) && !available.includes(p.id);
          const locked = !roleAllows(role, p.min_role, roles);
          const title = locked
            ? `${p.label}（${p.min_role} 以上）`
            : offline
              ? `${p.label}（ボット側で未接続と報告されています）`
              : p.label;
          return (
            <button
              key={p.id}
              type="button"
              className="picker-row"
              aria-pressed={selected}
              disabled={locked}
              title={title}
              onClick={() => {
                if (!locked) onPick(p.id);
              }}
            >
              <ProviderTile provider={p.provider} label={p.label} />
              <span className="p-model">{presetModel(p)}</span>
              <span className="p-prov">{meta.label}</span>
              <span className="p-id">{p.id}</span>
              <span className="p-tags">
                {locked && <Badge tone="warn">Premium</Badge>}
                {!locked && offline && <Badge tone="warn">未接続</Badge>}
                {selected && <Icon.check />}
              </span>
            </button>
          );
        })}
        {shown.length === 0 && (
          <p className="palette-empty">一致するモデルがありません。</p>
        )}
      </div>
      <p className="note">
        「Premium」は、あなたのプランでは選べないプリセットです。「未接続」は、ボット側で未接続と報告されているプロバイダです。
      </p>
    </Modal>
  );
}

/**
 * 固定モデルの現在値。行の中にカードを並べると縦に伸びるので、
 * 現在値だけボタンで見せて、ダイアログの中で /switch と同じ一覧から選ぶ。
 */
export function FixedModelButton({
  label,
  title,
  presets,
  available,
  value,
  role,
  roles,
  onChange,
}: {
  label: string;
  title: string;
  presets: Preset[];
  available?: string[];
  /** preset id。 */
  value: string;
  role?: string;
  roles?: string[];
  onChange: (presetId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = presets.find((p) => p.id === value) ?? null;
  const name = current?.model ?? current?.id ?? value;
  return (
    <>
      <button
        type="button"
        className="btn fixed-btn"
        aria-label={`${label}: ${name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span>
          {label}: <span className="mono">{name}</span>
        </span>
        <Icon.chevronRight size={14} />
      </button>
      <ModelDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        presets={presets}
        available={available}
        isSelected={(p) => p.id === value}
        role={role}
        roles={roles}
        onPick={(id) => {
          onChange(id);
          setOpen(false);
        }}
      />
    </>
  );
}
