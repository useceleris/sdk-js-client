export const maximumRetries = 10;
export const retryBudgetResetMs = 60_000;
export const closeBudgetMs = 5_000;

const retryBaseDelayMs = 500;
const retryDelayCapMs = 30_000;
const replayLookbackCapMs = 4_294_967_295;
const replayOverlapMs = 5_000;

export function computeRetryDelayMs(
  retryIndex: number,
  random: () => number,
): number {
  const ceiling = Math.min(retryDelayCapMs, retryBaseDelayMs * 2 ** retryIndex);

  return random() * ceiling;
} // end function computeRetryDelayMs

export function computeReplayLookbackMs(elapsedOutageMs: number): number {
  return Math.min(
    Math.ceil(elapsedOutageMs) + replayOverlapMs,
    replayLookbackCapMs,
  );
} // end function computeReplayLookbackMs

export function monotonicNow(): number {
  const timer = globalThis.performance;
  if (timer && typeof timer.now === "function") return timer.now();

  return Date.now();
} // end function monotonicNow
