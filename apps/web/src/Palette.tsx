import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import type { GuildSummary, Me } from "./api";
import { GUILD_PAGES, GUILD_SETTINGS, guildPath } from "./nav";
import { GUILD_PAGE_ICON, Icon } from "./ui";

type Item = {
  group: string;
  icon: ReactNode;
  label: string;
  where: string;
  to: string;
  /** 設定項目のとき、移った先で目印を付ける行。 */
  row?: string;
};

/** ページへ移ったあと、本文へフォーカスを送る合図（Shell が受け取る）。 */
export type PaletteNavState = { row?: string; focusMain?: boolean };

/**
 * コマンドパレット。サーバー・ページ・設定項目を 1 つの入力欄から探して移る。
 * 候補はすべて、すでに読み込んである一覧から作る（新しい通信はしない）。
 */
export function Palette({
  open,
  onClose,
  guilds,
  currentId,
  me,
}: {
  open: boolean;
  onClose: () => void;
  guilds: GuildSummary[];
  /** いま見ている（最後に見ていた）サーバー。 */
  currentId: string | undefined;
  me: Me;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const navigate = useNavigate();
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  // 閉じたら、開く前にフォーカスがあった所へ戻す。候補を選んで閉じたときだけは戻さない（移った先へ送る）。
  const returnFocus = useRef<HTMLElement | null>(null);
  const picked = useRef(false);

  useEffect(() => {
    if (!open) return;
    picked.current = false;
    setQuery("");
    setIndex(0);
  }, [open]);

  const all = useMemo(() => {
    const items: Item[] = [];
    const current = guilds.find((g) => g.id === currentId);
    for (const g of guilds) {
      items.push({
        group: "サーバー",
        icon: <Icon.server />,
        label: g.name,
        where: g.id === currentId ? "今のサーバー" : `ID ${g.id}`,
        to: guildPath(g.id),
      });
    }
    if (current) {
      for (const p of GUILD_PAGES)
        items.push({ group: "ページ", icon: GUILD_PAGE_ICON[p.path], label: p.label, where: current.name, to: guildPath(current.id, p.path) });
    }
    items.push({ group: "ページ", icon: <Icon.grid />, label: "サーバー一覧", where: "全体", to: "/" });
    items.push({ group: "ページ", icon: <Icon.user />, label: "マイ設定", where: "全体", to: "/me" });
    items.push({ group: "ページ", icon: <Icon.box />, label: "すべての成果物", where: "全体", to: "/artifacts" });
    if (me.can_manage_users) {
      items.push({ group: "ページ", icon: <Icon.users />, label: "ユーザー", where: "管理", to: "/users" });
      items.push({ group: "ページ", icon: <Icon.cpu />, label: "モデル", where: "管理", to: "/models" });
    }
    if (me.can_view_analytics)
      items.push({ group: "ページ", icon: <Icon.gauge />, label: "利用料", where: "管理", to: "/analytics" });
    if (current) {
      for (const s of GUILD_SETTINGS) {
        const page = GUILD_PAGES.find((p) => p.path === s.page);
        items.push({
          group: "設定項目",
          icon: <Icon.sliders />,
          label: s.label,
          where: `${current.name} › ${page?.label ?? ""}`,
          to: guildPath(current.id, s.page),
          row: s.row,
        });
      }
    }
    return items;
  }, [guilds, currentId, me]);

  const needle = query.trim().toLowerCase();
  const items = needle
    ? all.filter((it) => `${it.label} ${it.where}`.toLowerCase().includes(needle))
    : all;
  const active = Math.min(index, Math.max(items.length - 1, 0));

  useEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, needle]);

  function run(item: Item | undefined) {
    if (!item) return;
    picked.current = true;
    onClose();
    const state: PaletteNavState = item.row ? { row: item.row } : { focusMain: true };
    navigate(item.to, { state });
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay is-top">
          <Dialog.Content
            className="palette"
            aria-describedby={undefined}
            onOpenAutoFocus={() => {
              returnFocus.current = document.activeElement as HTMLElement;
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (!picked.current) returnFocus.current?.focus();
            }}
          >
            <Dialog.Title className="sr">コマンドパレット</Dialog.Title>
            <div className="palette-input">
              <Icon.search size={18} />
              <input
                type="text"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={items.length ? `${listId}-${active}` : undefined}
                aria-label="サーバー・ページ・設定項目を検索"
                placeholder="サーバー・ページ・設定項目を検索"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    if (items.length)
                      setIndex((active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
                  } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    // 日本語の変換を確定する Enter では開かない。
                    e.preventDefault();
                    run(items[active]);
                  }
                }}
              />
            </div>
            <div className="palette-list" id={listId} ref={list} role="listbox" aria-label="候補">
              {items.map((it, i) => (
                <div key={`${it.group}:${it.to}:${it.row ?? ""}`} role="presentation">
                  {it.group !== items[i - 1]?.group && (
                    <div className="palette-group" role="presentation">
                      {it.group}
                    </div>
                  )}
                  <button
                    type="button"
                    className="palette-item"
                    role="option"
                    id={`${listId}-${i}`}
                    aria-selected={i === active}
                    tabIndex={-1}
                    onClick={() => run(it)}
                  >
                    {it.icon}
                    <span className="grow">{it.label}</span>
                    <span className="where">{it.where}</span>
                  </button>
                </div>
              ))}
              {items.length === 0 && (
                <p className="palette-empty">一致するものがありません。</p>
              )}
            </div>
            <div className="palette-foot">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> 移動
              </span>
              <span>
                <kbd>Enter</kbd> 開く
              </span>
              <span>
                <kbd>Esc</kbd> 閉じる
              </span>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
