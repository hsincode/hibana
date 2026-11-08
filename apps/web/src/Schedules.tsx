import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  DEFAULT_SCHEDULE_TIME_ZONE,
  SCHEDULE_ACTIONS_MAX,
  SCHEDULE_ASSET_DIR,
  SCHEDULE_NAME_MAX,
  SCHEDULE_TEXT_MAX,
  SCHEDULES_MAX,
  isTimeZone,
  type Schedule,
  type ScheduleAction,
  type ScheduleAsset,
} from "@hibana/shared/schedules";
import { api } from "./api";
import { Select } from "./controls";
import { Alert, BoolSeg, Icon, Loading, Section, type Toast } from "./ui";

/* ============================================================
   定時アクション
   毎日決まった時刻に、チャンネルへの投稿と、通話中なら音声の再生をする。
   一覧ごと保存する（自動保存しない）。docs/schedules.md
   ============================================================ */

type Channel = { id: string; name: string; category: string | null };

type Loaded = {
  schedules: Schedule[];
  assets: ScheduleAsset[];
  assets_reported_at: number | null;
  can_edit: boolean;
};

const ZONES = [
  "Asia/Tokyo",
  "UTC",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
];

const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const newPost = (channels: Channel[]): ScheduleAction => ({
  type: "post",
  channel_id: channels[0]?.id ?? "",
  text: "",
  file: null,
});

/** 保存前に、画面で分かる誤りを先に出す。最終的な検証は API が行う。 */
function problems(list: Schedule[]): string[] {
  const out: string[] = [];
  list.forEach((s, i) => {
    const label = s.name.trim() || `${i + 1} 件目`;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time))
      out.push(`${label}: 時刻を HH:MM で入れてください`);
    if (!isTimeZone(s.time_zone))
      out.push(`${label}: タイムゾーン「${s.time_zone}」が見つかりません`);
    if (!s.actions.length) out.push(`${label}: アクションがありません`);
    for (const a of s.actions) {
      if (a.type === "post" && !a.channel_id)
        out.push(`${label}: 投稿先のチャンネルを選んでください`);
      if (a.type === "post" && !a.text.trim() && !a.file)
        out.push(`${label}: 投稿には本文か添付が要ります`);
      if (a.type === "voice_clip" && !a.audio)
        out.push(`${label}: 鳴らす音声を選んでください`);
    }
  });
  return out;
}

export function GuildSchedules({
  guildId,
  push,
}: {
  guildId: string;
  push: (kind: Toast["kind"], text: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Schedule[]>([]);
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [channelError, setChannelError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const r = await api<Loaded>(`/api/guilds/${guildId}/schedules`);
      setLoaded(r);
      setDraft(r.schedules);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [guildId]);

  useEffect(() => {
    setLoaded(null);
    setChannels(null);
    void load();
    api<{ channels: Channel[] }>(`/api/guilds/${guildId}/channels`)
      .then((r) => setChannels(r.channels))
      .catch((e) => {
        setChannels([]);
        setChannelError((e as Error).message);
      });
  }, [guildId, load]);

  const dirty = useMemo(
    () =>
      loaded !== null &&
      JSON.stringify(draft) !== JSON.stringify(loaded.schedules),
    [draft, loaded],
  );
  const issues = useMemo(() => problems(draft), [draft]);
  const editable = loaded?.can_edit ?? false;

  const update = (index: number, next: Schedule) =>
    setDraft((list) => list.map((s, i) => (i === index ? next : s)));

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ schedules: Schedule[] }>(
        `/api/guilds/${guildId}/schedules`,
        { method: "PUT", body: JSON.stringify({ schedules: draft }) },
      );
      setLoaded((l) => (l ? { ...l, schedules: r.schedules } : l));
      setDraft(r.schedules);
      push("ok", "保存しました。bot には 30 秒ほどで届きます。");
    } catch (e) {
      push("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="schedules"
      title="定時アクション"
      desc={
        <>
          毎日決まった時刻に、チャンネルへの投稿と音声の再生をします。音声は、bot
          がこのサーバーの通話（<span className="mono">/join</span>・
          <span className="mono">/recording</span>
          ）にいるときだけ、流れている音声の後に鳴らします。bot
          が止まっていて時刻から 2 分を過ぎた日は、その日の分を送りません。
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      {loaded && !editable && (
        <Alert>
          編集できるのは、Discord
          でこのサーバーの「サーバー管理」権限を持つ人だけです。
        </Alert>
      )}
      {!loaded && !error && <Loading />}
      {loaded && (
        <>
          <div className="toolbar">
            <button
              type="button"
              className="btn"
              disabled={!editable || draft.length >= SCHEDULES_MAX}
              onClick={() =>
                setDraft((list) => [
                  ...list,
                  {
                    id: newId(),
                    name: "",
                    enabled: true,
                    time: "02:00",
                    time_zone: DEFAULT_SCHEDULE_TIME_ZONE,
                    actions: [newPost(channels ?? [])],
                  },
                ])
              }
            >
              <Icon.plus size={14} />
              追加
            </button>
            <span className="grow" />
            {dirty && (
              <span className="muted sched-dirty" role="status">
                未保存の変更があります
              </span>
            )}
            <button
              type="button"
              className="btn"
              disabled={!dirty || busy}
              onClick={() => setDraft(loaded.schedules)}
            >
              元に戻す
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!editable || !dirty || busy || issues.length > 0}
              onClick={() => void save()}
            >
              保存
            </button>
          </div>
          {dirty && issues.length > 0 && (
            <Alert>
              {issues.slice(0, 3).join(" / ")}
              {issues.length > 3 && ` ほか ${issues.length - 3} 件`}
            </Alert>
          )}
          {channelError && (
            <Alert>チャンネルの一覧を取れませんでした: {channelError}</Alert>
          )}
          {!draft.length ? (
            <p className="muted">定時アクションはありません。</p>
          ) : (
            <ul className="sched-list">
              {draft.map((s, i) => (
                <ScheduleCard
                  key={s.id}
                  schedule={s}
                  index={i}
                  channels={channels}
                  assets={loaded.assets}
                  disabled={!editable || busy}
                  onChange={(next) => update(i, next)}
                  onRemove={() =>
                    setDraft((list) => list.filter((_, j) => j !== i))
                  }
                />
              ))}
            </ul>
          )}
          <p className="field-hint sched-assets">
            画像・動画・音声は、Discord で{" "}
            <span className="mono">/schedule-asset add</span>{" "}
            にファイルを添付して上げると、ここで選べるようになります（サーバーを管理できる人だけ。一覧は{" "}
            <span className="mono">/schedule-asset list</span>
            、削除は <span className="mono">/schedule-asset remove</span>
            ）。bot を動かすマシンの{" "}
            <span className="mono">
              HIBANA_DATA_DIR/{SCHEDULE_ASSET_DIR}/{guildId}/
            </span>{" "}
            に置いても使えます。投稿に添付できるのは 10 MB まで、音声は 20 MB・5
            分まで、1 つのサーバーで合計 200 MB までです。
            {loaded.assets_reported_at
              ? ` 最後に確かめた時刻: ${new Date(loaded.assets_reported_at).toLocaleString("ja-JP")}`
              : " bot からの一覧はまだ届いていません。"}
          </p>
        </>
      )}
    </Section>
  );
}

function ScheduleCard({
  schedule: s,
  index,
  channels,
  assets,
  disabled,
  onChange,
  onRemove,
}: {
  schedule: Schedule;
  index: number;
  channels: Channel[] | null;
  assets: ScheduleAsset[];
  disabled: boolean;
  onChange: (next: Schedule) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const zones = useMemo(() => {
    const all =
      (
        Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
      ).supportedValuesOf?.("timeZone") ?? [];
    return [...new Set([...ZONES, ...all])];
  }, []);
  const setAction = (i: number, next: ScheduleAction) =>
    onChange({
      ...s,
      actions: s.actions.map((a, j) => (j === i ? next : a)),
    });
  const title = s.name.trim() || `定時アクション ${index + 1}`;
  return (
    <li className="sched" aria-label={title}>
      <div className="sched-head">
        <div className="field sched-name">
          <label htmlFor={`${id}-name`}>名前</label>
          <input
            id={`${id}-name`}
            className="input"
            value={s.name}
            maxLength={SCHEDULE_NAME_MAX}
            placeholder={`定時アクション ${index + 1}`}
            disabled={disabled}
            onChange={(e) => onChange({ ...s, name: e.target.value })}
          />
        </div>
        <div className="field">
          <span className="field-name" id={`${id}-enabled`}>
            有効
          </span>
          <BoolSeg
            labelledBy={`${id}-enabled`}
            value={s.enabled}
            onChange={(enabled) => !disabled && onChange({ ...s, enabled })}
          />
        </div>
        <button
          type="button"
          className="icon-btn sched-remove"
          title="削除"
          aria-label={`${title} を削除`}
          disabled={disabled}
          onClick={onRemove}
        >
          <Icon.trash />
        </button>
      </div>
      <div className="sched-when">
        <div className="field">
          <label htmlFor={`${id}-time`}>毎日</label>
          <input
            id={`${id}-time`}
            className="input sched-time"
            type="time"
            value={s.time}
            disabled={disabled}
            onChange={(e) => onChange({ ...s, time: e.target.value })}
          />
        </div>
        <div className="field sched-zone">
          <label htmlFor={`${id}-zone`}>タイムゾーン</label>
          <input
            id={`${id}-zone`}
            className="input mono"
            list={`${id}-zones`}
            value={s.time_zone}
            disabled={disabled}
            onChange={(e) => onChange({ ...s, time_zone: e.target.value })}
          />
          <datalist id={`${id}-zones`}>
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
      </div>
      <ol className="sched-actions">
        {s.actions.map((a, i) => (
          <li key={i} className="sched-action">
            <div className="sched-action-head">
              <span className="sched-action-kind">
                {a.type === "post" ? (
                  <>
                    <Icon.doc size={14} /> 投稿
                  </>
                ) : (
                  <>
                    <Icon.sound size={14} /> 通話中なら音声
                  </>
                )}
              </span>
              <button
                type="button"
                className="icon-btn"
                title="このアクションを外す"
                aria-label={`${i + 1} 番目のアクションを外す`}
                disabled={disabled || s.actions.length <= 1}
                onClick={() =>
                  onChange({
                    ...s,
                    actions: s.actions.filter((_, j) => j !== i),
                  })
                }
              >
                <Icon.close />
              </button>
            </div>
            {a.type === "post" ? (
              <PostFields
                id={`${id}-a${i}`}
                action={a}
                channels={channels}
                assets={assets}
                disabled={disabled}
                onChange={(next) => setAction(i, next)}
              />
            ) : (
              <div className="field">
                <label htmlFor={`${id}-a${i}-audio`}>音声</label>
                <AssetSelect
                  id={`${id}-a${i}-audio`}
                  value={a.audio}
                  assets={assets.filter((x) => x.kind === "audio")}
                  none="選んでください"
                  disabled={disabled}
                  onChange={(audio) => setAction(i, { ...a, audio })}
                />
              </div>
            )}
          </li>
        ))}
      </ol>
      <div className="sched-add">
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled || s.actions.length >= SCHEDULE_ACTIONS_MAX}
          onClick={() =>
            onChange({ ...s, actions: [...s.actions, newPost(channels ?? [])] })
          }
        >
          <Icon.plus size={14} />
          投稿
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={disabled || s.actions.length >= SCHEDULE_ACTIONS_MAX}
          onClick={() =>
            onChange({
              ...s,
              actions: [
                ...s.actions,
                {
                  type: "voice_clip",
                  audio: assets.find((x) => x.kind === "audio")?.name ?? "",
                },
              ],
            })
          }
        >
          <Icon.plus size={14} />
          通話中なら音声
        </button>
      </div>
    </li>
  );
}

function PostFields({
  id,
  action: a,
  channels,
  assets,
  disabled,
  onChange,
}: {
  id: string;
  action: Extract<ScheduleAction, { type: "post" }>;
  channels: Channel[] | null;
  assets: ScheduleAsset[];
  disabled: boolean;
  onChange: (next: Extract<ScheduleAction, { type: "post" }>) => void;
}) {
  const known = channels?.some((c) => c.id === a.channel_id);
  return (
    <div className="sched-post">
      <div className="field">
        <label htmlFor={`${id}-channel`}>チャンネル</label>
        <Select
          id={`${id}-channel`}
          value={a.channel_id}
          disabled={disabled || channels === null}
          onValueChange={(channel_id) => onChange({ ...a, channel_id })}
        >
          <option value="">
            {channels === null ? "読み込み中…" : "選んでください"}
          </option>
          {a.channel_id && channels !== null && !known && (
            <option value={a.channel_id}>
              見つからないチャンネル（{a.channel_id}）
            </option>
          )}
          {(channels ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.category ? `${c.category} / #${c.name}` : `#${c.name}`}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-file`}>添付（画像・動画）</label>
        <AssetSelect
          id={`${id}-file`}
          value={a.file ?? ""}
          assets={assets.filter((x) => x.kind !== "audio")}
          none="なし"
          disabled={disabled}
          onChange={(file) => onChange({ ...a, file: file || null })}
        />
      </div>
      <div className="field sched-text">
        <label htmlFor={`${id}-text`}>本文</label>
        <textarea
          id={`${id}-text`}
          className="textarea"
          rows={2}
          maxLength={SCHEDULE_TEXT_MAX}
          value={a.text}
          disabled={disabled}
          placeholder="空なら添付だけを送ります。メンションは通知されません。"
          onChange={(e) => onChange({ ...a, text: e.target.value })}
        />
      </div>
    </div>
  );
}

const KIND_LABEL = { image: "画像", video: "動画", audio: "音声" } as const;

function AssetSelect({
  id,
  value,
  assets,
  none,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  assets: ScheduleAsset[];
  none: string;
  disabled: boolean;
  onChange: (name: string) => void;
}) {
  const known = assets.some((x) => x.name === value);
  return (
    <Select id={id} value={value} disabled={disabled} onValueChange={onChange}>
      <option value="">{none}</option>
      {value && !known && (
        <option value={value}>{value}（bot の一覧にありません）</option>
      )}
      {assets.map((x) => (
        <option key={x.name} value={x.name}>
          {x.name}（{KIND_LABEL[x.kind]}・{formatSize(x.size)}）
        </option>
      ))}
    </Select>
  );
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
