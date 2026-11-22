import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { apiUrl } from "./api";

/* ============================================================
   bot への設定反映の追跡（#185）
   設定保存 API が返した `snapshot_version` を受け取ったら、
   GET /api/sync-status を短時間ポーリングして、bot が実際に適用した
   ことを検知する。常時接続は使わず、未反映がある間だけ動く。
   ============================================================ */

/** 未反映の版がある間の確認間隔。 */
export const BOT_SYNC_POLL_MS = 3_000;
/** bot が停止中・旧版に切り戻し中などのときにポーリングを打ち切る上限。 */
export const BOT_SYNC_TIMEOUT_MS = 60_000;
/** 自動保存のないページで「bot に反映済み」を上部バーに残す時間。 */
export const BOT_SYNC_STANDALONE_MS = 8_000;

export type SyncStatusResponse = {
  snapshot_version: number;
  applied_version: number | null;
  applied_at: number | null;
};

export type BotSyncState =
  | { status: "idle" }
  | { status: "pending"; targetVersion: number }
  | {
      status: "synced";
      targetVersion: number;
      appliedAt: number | null;
      /** 反映のたびに増える連番。火花アニメーション（.spark）を毎回 1 回発火させる。 */
      seq: number;
      /** 自動保存のないページでも上部バーに表示する間 true。 */
      standalone: boolean;
    }
  | {
      status: "timeout";
      targetVersion: number;
      appliedAt: number | null;
    };

export const IDLE_BOT_SYNC: BotSyncState = { status: "idle" };

export const BotSyncTrackContext = createContext<
  (version: number | null | undefined) => void
>(() => {});

/** 保存完了レスポンスの `snapshot_version` を渡して、bot 反映の追跡を始める。 */
export function useTrackBotSync(): (
  version: number | null | undefined,
) => void {
  return useContext(BotSyncTrackContext);
}

function isValidVersion(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}

/**
 * シェル全体で最新の `snapshot_version` の反映を追跡する。
 * 連続で設定を変更したときは最新の版 1 件に集約し、その版が反映された
 * ときにだけ `onSynced` を 1 回呼ぶ。
 */
export function useBotSync(onSynced: () => void): {
  state: BotSyncState;
  track: (version: number | null | undefined) => void;
} {
  const [state, setState] = useState<BotSyncState>(IDLE_BOT_SYNC);
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  const mountedRef = useRef(true);
  const targetRef = useRef<number | null>(null);
  const deadlineRef = useRef(0);
  const appliedVersionRef = useRef<number | null>(null);
  const appliedAtRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const standaloneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearStandalone = useCallback(() => {
    if (standaloneTimerRef.current !== null) {
      clearTimeout(standaloneTimerRef.current);
      standaloneTimerRef.current = null;
    }
  }, []);

  const markSynced = useCallback(
    (targetVersion: number, appliedAt: number | null) => {
      clearPoll();
      clearStandalone();
      const seq = ++seqRef.current;
      setState({
        status: "synced",
        targetVersion,
        appliedAt,
        seq,
        standalone: true,
      });
      onSyncedRef.current();
      standaloneTimerRef.current = setTimeout(() => {
        standaloneTimerRef.current = null;
        if (!mountedRef.current) return;
        setState((prev) =>
          prev.status === "synced" && prev.seq === seq
            ? { ...prev, standalone: false }
            : prev,
        );
      }, BOT_SYNC_STANDALONE_MS);
    },
    [clearPoll, clearStandalone],
  );

  const schedulePoll = useCallback(() => {
    clearPoll();
    if (!mountedRef.current || targetRef.current === null) return;
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      void pollOnce();
    }, BOT_SYNC_POLL_MS);
  }, [clearPoll]);

  const pollOnce = useCallback(async () => {
    if (
      !mountedRef.current ||
      targetRef.current === null ||
      inFlightRef.current
    )
      return;
    inFlightRef.current = true;
    try {
      const res = await fetch(apiUrl("/api/sync-status"), {
        credentials: "include",
        cache: "no-store",
      });
      if (!mountedRef.current || targetRef.current === null) return;
      if (res.status === 401) {
        targetRef.current = null;
        setState(IDLE_BOT_SYNC);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as Partial<SyncStatusResponse>;
        if (
          typeof data.applied_version === "number" &&
          Number.isSafeInteger(data.applied_version)
        ) {
          appliedVersionRef.current = Math.max(
            appliedVersionRef.current ?? -1,
            data.applied_version,
          );
        }
        if (typeof data.applied_at === "number") {
          appliedAtRef.current = data.applied_at;
        }
        const target = targetRef.current;
        if (
          target !== null &&
          appliedVersionRef.current !== null &&
          appliedVersionRef.current >= target
        ) {
          targetRef.current = null;
          markSynced(target, appliedAtRef.current);
          return;
        }
      }
    } catch {
      /* 一時的な通信エラーは上限時間まで次の周期で再試行する */
    } finally {
      inFlightRef.current = false;
    }

    if (!mountedRef.current || targetRef.current === null) return;
    if (Date.now() >= deadlineRef.current) {
      const target = targetRef.current;
      targetRef.current = null;
      clearPoll();
      setState({
        status: "timeout",
        targetVersion: target,
        appliedAt: appliedAtRef.current,
      });
      return;
    }
    schedulePoll();
  }, [clearPoll, markSynced, schedulePoll]);

  const track = useCallback(
    (version: number | null | undefined) => {
      if (!isValidVersion(version)) return;
      if (
        appliedVersionRef.current !== null &&
        appliedVersionRef.current >= version
      ) {
        if (targetRef.current !== null && targetRef.current > version) return;
        targetRef.current = null;
        markSynced(version, appliedAtRef.current);
        return;
      }
      const nextTarget = Math.max(targetRef.current ?? 0, version);
      targetRef.current = nextTarget;
      deadlineRef.current = Date.now() + BOT_SYNC_TIMEOUT_MS;
      clearStandalone();
      setState({ status: "pending", targetVersion: nextTarget });
      if (pollTimerRef.current === null && !inFlightRef.current) {
        schedulePoll();
      }
    },
    [clearStandalone, markSynced, schedulePoll],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPoll();
      clearStandalone();
    };
  }, [clearPoll, clearStandalone]);

  return { state, track };
}
