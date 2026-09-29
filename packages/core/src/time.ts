/**
 * Hour-window arithmetic.
 *
 * CRITICAL INVARIANT
 * ------------------
 * The planner (which forecasts) and the Redis rate limiter (which enforces) MUST agree
 * on what "an hour window" is, or the Delivery Planner forecast drifts from reality and
 * the whole feature becomes decorative.
 *
 * They agree because both import `hourWindowStart()` / `hourWindowKey()` from this file.
 * The Redis counter key is literally derived from the same number the planner buckets by.
 *
 * Windows are aligned to **wall-clock UTC hours**, not to the campaign start time.
 * That means a campaign starting at 10:45 gets only 15 minutes of the 10:00–11:00 window,
 * and the planner accounts for that (see `planner.ts`). Aligning to startAt instead would
 * be simpler but would desynchronise from the Redis buckets, which are inherently
 * wall-clock based because they are keyed by `floor(epochMs / HOUR_MS)`.
 */

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

/** Start of the wall-clock UTC hour containing `epochMs`. */
export function hourWindowStart(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

/** Exclusive end of the wall-clock UTC hour containing `epochMs`. */
export function hourWindowEnd(epochMs: number): number {
  return hourWindowStart(epochMs) + HOUR_MS;
}

/**
 * Integer index of the hour window — this is the value embedded in the Redis
 * rate-limit key, e.g. `rl:{tenant}:{sender}:{hourWindowKey}`.
 */
export function hourWindowKey(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS);
}

/** Milliseconds remaining in the window containing `epochMs`. */
export function msRemainingInWindow(epochMs: number): number {
  return hourWindowEnd(epochMs) - epochMs;
}

/**
 * How many sends spaced `gapMs` apart fit between `fromMs` and the end of its window,
 * counting the send at `fromMs` itself.
 *
 * A gap of 0 means "unbounded by spacing" — capacity is then limited only by the
 * hourly quota, so we return Infinity rather than dividing by zero.
 */
export function slotsRemainingInWindow(fromMs: number, gapMs: number): number {
  const remaining = msRemainingInWindow(fromMs);
  if (remaining <= 0) return 0;
  if (gapMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor((remaining - 1) / gapMs) + 1;
}

/** Upper bound on sends per hour imposed purely by the minimum gap. */
export function gapImposedHourlyCap(gapMs: number): number {
  if (gapMs <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(HOUR_MS / gapMs);
}

/** Human-readable duration, e.g. "2h 15m" or "45s". Used in planner summaries. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.round(ms / SECOND_MS);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
