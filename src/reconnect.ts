import {
  REPLAY_LOOKBACK_CAP_MS,
  REPLAY_OVERLAP_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_DELAY_CAP_MS,
} from "./constants";

export function computeRetryDelayMs(
  retryIndex: number,
  random: () => number,
): number {
  const ceiling = Math.min(
    RETRY_DELAY_CAP_MS,
    RETRY_BASE_DELAY_MS * 2 ** retryIndex,
  );

  return random() * ceiling;
} // end function computeRetryDelayMs

export function computeReplayLookbackMs(elapsedOutageMs: number): number {
  return Math.min(
    Math.ceil(elapsedOutageMs) + REPLAY_OVERLAP_MS,
    REPLAY_LOOKBACK_CAP_MS,
  );
} // end function computeReplayLookbackMs

export function monotonicNow(): number {
  const timer = globalThis.performance;
  if (timer && typeof timer.now === "function") return timer.now();

  return Date.now();
} // end function monotonicNow
