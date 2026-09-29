/**
 * Domain constants shared across the monorepo.
 *
 * NOTE ON CONFIGURABILITY
 * -----------------------
 * The brief requires that rate limits be configurable, not hardcoded. Nothing here is
 * a rate limit — these are *structural bounds* (how big a request may be, what a
 * reasonable input range is). Actual limits come from env → `apps/api/src/config.ts`
 * → per-sender DB overrides. See `04-SECURITY.md` for why the bounds below exist.
 */

/** Hard cap on recipients in one campaign. Bounds memory during planning and the
 *  size of a single bulk insert. Raising this is safe up to ~100k with the pump. */
export const MAX_LEADS_PER_CAMPAIGN = 50_000;

/** Above this many recipients the API materialises jobs window-by-window via the
 *  campaign pump instead of enqueuing everything up front. Keeps Redis small. */
export const PUMP_THRESHOLD_RECIPIENTS = 5_000;

/** How far ahead the pump materialises jobs. */
export const PUMP_HORIZON_HOURS = 2;

/** Chunk size for bulk DB inserts and BullMQ `addBulk` calls. */
export const BULK_CHUNK_SIZE = 1_000;

// ── Input bounds (validation, not policy) ─────────────────────────────────────

export const MIN_GAP_MS = 0;
export const MAX_GAP_MS = 60 * 60 * 1000; // 1 hour between sends is already absurd
export const MIN_HOURLY_LIMIT = 1;
export const MAX_HOURLY_LIMIT = 100_000;

export const MAX_SUBJECT_LENGTH = 500;
export const MAX_BODY_LENGTH = 200_000;
export const MAX_CAMPAIGN_NAME_LENGTH = 200;

/** Reject start times further out than this — almost always a timezone bug. */
export const MAX_SCHEDULE_HORIZON_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** A start time this far in the past is accepted and fires immediately; further back
 *  is rejected as a probable client clock problem. */
export const MAX_START_BACKDATE_MS = 5 * 60 * 1000; // 5 minutes

// ── Queue names ───────────────────────────────────────────────────────────────

export const QUEUE_EMAIL_SEND = 'email-send';
export const QUEUE_CAMPAIGN_PUMP = 'campaign-pump';
export const QUEUE_SEARCH_INDEX = 'search-index';
export const QUEUE_NOTIFICATIONS = 'notifications';

export const ALL_QUEUES = [
  QUEUE_EMAIL_SEND,
  QUEUE_CAMPAIGN_PUMP,
  QUEUE_SEARCH_INDEX,
  QUEUE_NOTIFICATIONS,
] as const;

// ── Redis key builders ────────────────────────────────────────────────────────
// Centralised so the worker, the limiter and any debugging script cannot disagree
// about key shape. Every key is prefixed `throttle:` so the Redis instance can be
// shared with other tooling without collision.

export const REDIS_PREFIX = 'throttle';

/** Hourly send counter. `windowKey` comes from `hourWindowKey()` in `time.ts`. */
export const rateLimitKey = (tenantId: string, senderId: string, windowKey: number): string =>
  `${REDIS_PREFIX}:rl:${tenantId}:${senderId}:${windowKey}`;

/** Timestamp of this sender's last send, for min-gap enforcement. */
export const senderGapKey = (senderId: string): string => `${REDIS_PREFIX}:gap:${senderId}`;

/** Circuit-breaker + health hash for a sender. */
export const senderHealthKey = (senderId: string): string => `${REDIS_PREFIX}:health:${senderId}`;

/** Slack notification debounce — one alert per sender per window, not one per job. */
export const slackDebounceKey = (
  tenantId: string,
  senderId: string,
  windowKey: number,
): string => `${REDIS_PREFIX}:slack:rl:${tenantId}:${senderId}:${windowKey}`;

/** Debounce for circuit-breaker state-change alerts. */
export const slackCircuitDebounceKey = (tenantId: string, senderId: string): string =>
  `${REDIS_PREFIX}:slack:cb:${tenantId}:${senderId}`;

/** Single-use OAuth `state` value, held only for the length of the handshake. */
export const oauthStateKey = (state: string): string => `${REDIS_PREFIX}:oauth:${state}`;

// ── TTLs ──────────────────────────────────────────────────────────────────────

/** Rate-limit counters outlive their window by an hour so late-arriving jobs from a
 *  paused worker still see the correct count rather than a fresh zero. */
export const RATE_LIMIT_TTL_SECONDS = 2 * 60 * 60;
export const SENDER_GAP_TTL_SECONDS = 60 * 60;
export const SLACK_DEBOUNCE_TTL_SECONDS = 60 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;
