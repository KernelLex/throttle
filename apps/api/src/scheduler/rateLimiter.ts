/**
 * Distributed rate limiting.
 *
 * THE PROBLEM
 * -----------
 * N worker processes, each with M concurrent jobs, all want to send from the same
 * sender at the same instant. Every one of them reads "sent 199 of 200 this hour",
 * every one concludes it has room, and 5 emails go out over the limit.
 *
 * That is a read-modify-write race, and no amount of application-level care fixes it.
 * In-memory counters are worse still: two API instances each happily allow 200/hour
 * and the real rate is 400/hour.
 *
 * THE FIX
 * -------
 * Every check-and-increment is a single Lua script. Redis executes Lua atomically —
 * nothing interleaves between the read and the write. Correctness therefore holds for
 * any number of workers, processes or machines, which is exactly what the brief asks
 * for ("safe across multiple workers / instances", "do not rely only on in-memory
 * counts").
 *
 * WHAT IS CHECKED, IN ORDER
 * -------------------------
 *   1. Tenant-wide hourly ceiling (when MAX_EMAILS_PER_HOUR_GLOBAL > 0)
 *   2. Per-sender hourly ceiling
 *   3. Minimum gap since this sender's last send
 *
 * Cheapest and most-likely-to-deny checks are NOT first — ordering is by blast radius,
 * so that a global stop is reported as a global stop rather than being masked by a
 * per-sender gap message. The reason code drives what the user is told and whether
 * Slack fires.
 *
 * WINDOW ALIGNMENT
 * ----------------
 * The counter key embeds `hourWindowKey()` from @throttle/core — the same function
 * `planSchedule()` buckets by. That shared import is what keeps the Delivery Planner's
 * forecast and the limiter's enforcement describing the same reality.
 */

import {
  RATE_LIMIT_TTL_SECONDS,
  SENDER_GAP_TTL_SECONDS,
  hourWindowEnd,
  hourWindowKey,
  rateLimitKey,
  senderGapKey,
} from '@throttle/core';
import { env } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

const log = createLogger('rate-limiter');

export type DenyReason = 'HOURLY_LIMIT' | 'GLOBAL_LIMIT' | 'MIN_GAP';

export interface SlotGranted {
  allowed: true;
  /** Count for this sender in this window, AFTER this send is counted. */
  countThisWindow: number;
  remainingThisWindow: number;
  windowEndsAt: number;
}

export interface SlotDenied {
  allowed: false;
  reason: DenyReason;
  /** Exact milliseconds until this job could succeed. */
  retryAfterMs: number;
  countThisWindow: number;
  remainingThisWindow: number;
  windowEndsAt: number;
}

export type SlotDecision = SlotGranted | SlotDenied;

/**
 * The atomic check-and-consume.
 *
 * KEYS[1] per-sender hourly counter
 * KEYS[2] per-sender last-send timestamp
 * KEYS[3] tenant-wide hourly counter
 *
 * ARGV[1] hourlyLimit      ARGV[2] minGapMs        ARGV[3] nowMs
 * ARGV[4] counterTtlSec    ARGV[5] gapTtlSec       ARGV[6] globalLimit (0 = off)
 * ARGV[7] windowEndMs
 *
 * Returns: { allowed, reason, retryAfterMs, count, remaining }
 *
 * Note that the counters are only incremented on the SUCCESS path. A denied job must
 * not consume the budget it was denied for — otherwise a backlog of blocked jobs
 * would burn the next window's quota just by being checked.
 */
const ACQUIRE_SLOT_SCRIPT = `
local senderCountKey = KEYS[1]
local senderGapKey   = KEYS[2]
local globalCountKey = KEYS[3]

local hourlyLimit   = tonumber(ARGV[1])
local minGapMs      = tonumber(ARGV[2])
local nowMs         = tonumber(ARGV[3])
local counterTtlSec = tonumber(ARGV[4])
local gapTtlSec     = tonumber(ARGV[5])
local globalLimit   = tonumber(ARGV[6])
local windowEndMs   = tonumber(ARGV[7])

local senderCount = tonumber(redis.call('GET', senderCountKey) or '0')
local remaining   = hourlyLimit - senderCount
if remaining < 0 then remaining = 0 end

-- 1. Tenant-wide ceiling. Checked first so that a global stop is reported as such.
if globalLimit > 0 then
  local globalCount = tonumber(redis.call('GET', globalCountKey) or '0')
  if globalCount >= globalLimit then
    return { 0, 'GLOBAL_LIMIT', windowEndMs - nowMs, senderCount, remaining }
  end
end

-- 2. Per-sender hourly ceiling. Retry lands at the top of the next window, where
--    the counter key is different and therefore starts at zero.
if senderCount >= hourlyLimit then
  return { 0, 'HOURLY_LIMIT', windowEndMs - nowMs, senderCount, 0 }
end

-- 3. Minimum gap since this sender's previous send.
if minGapMs > 0 then
  local lastSendMs = tonumber(redis.call('GET', senderGapKey) or '0')
  if lastSendMs > 0 then
    local elapsed = nowMs - lastSendMs
    if elapsed < minGapMs then
      return { 0, 'MIN_GAP', minGapMs - elapsed, senderCount, remaining }
    end
  end
end

-- All checks passed: consume the slot. Every write below happens in the same
-- atomic execution as the reads above, which is the entire point.
local newCount = redis.call('INCR', senderCountKey)
redis.call('EXPIRE', senderCountKey, counterTtlSec)

if globalLimit > 0 then
  redis.call('INCR', globalCountKey)
  redis.call('EXPIRE', globalCountKey, counterTtlSec)
end

if minGapMs > 0 then
  redis.call('SET', senderGapKey, nowMs, 'EX', gapTtlSec)
end

local newRemaining = hourlyLimit - newCount
if newRemaining < 0 then newRemaining = 0 end

return { 1, 'OK', 0, newCount, newRemaining }
`;

/** Returns a slot to the pool — used when a send is abandoned before SMTP is touched. */
const RELEASE_SLOT_SCRIPT = `
local senderCountKey = KEYS[1]
local globalCountKey = KEYS[2]
local globalLimit    = tonumber(ARGV[1])

local current = tonumber(redis.call('GET', senderCountKey) or '0')
if current > 0 then
  redis.call('DECR', senderCountKey)
end

if globalLimit > 0 then
  local g = tonumber(redis.call('GET', globalCountKey) or '0')
  if g > 0 then
    redis.call('DECR', globalCountKey)
  end
end

return 1
`;

/** Tenant-wide counter key. Kept local because only the limiter needs its shape. */
const globalRateLimitKey = (tenantId: string, windowKey: number): string =>
  `throttle:rl:global:${tenantId}:${windowKey}`;

let scriptsRegistered = false;

/**
 * Register the Lua scripts as ioredis commands.
 *
 * ioredis uses EVALSHA with an automatic EVAL fallback, so the script body crosses
 * the wire once rather than on every send.
 */
export function registerRateLimitScripts(): void {
  if (scriptsRegistered) return;

  redis.defineCommand('acquireSendSlot', { numberOfKeys: 3, lua: ACQUIRE_SLOT_SCRIPT });
  redis.defineCommand('releaseSendSlot', { numberOfKeys: 2, lua: RELEASE_SLOT_SCRIPT });

  scriptsRegistered = true;
  log.debug('Rate-limit Lua scripts registered');
}

interface RedisWithScripts {
  acquireSendSlot(
    senderCountKey: string,
    senderGapKey: string,
    globalCountKey: string,
    hourlyLimit: string,
    minGapMs: string,
    nowMs: string,
    counterTtlSec: string,
    gapTtlSec: string,
    globalLimit: string,
    windowEndMs: string,
  ): Promise<[number, string, number, number, number]>;

  releaseSendSlot(
    senderCountKey: string,
    globalCountKey: string,
    globalLimit: string,
  ): Promise<number>;
}

export interface AcquireSlotParams {
  tenantId: string;
  senderId: string;
  /** Per-sender override; falls back to the env default when not supplied. */
  hourlyLimit?: number;
  minGapMs?: number;
  /** Injected so tests can be deterministic. */
  now?: number;
}

/**
 * Try to consume one send slot.
 *
 * This is called immediately before SMTP, on the worker's hot path. It is one Redis
 * round-trip and is safe to call from any number of processes concurrently.
 */
export async function acquireSendSlot(params: AcquireSlotParams): Promise<SlotDecision> {
  registerRateLimitScripts();

  const now = params.now ?? Date.now();
  const windowKey = hourWindowKey(now);
  const windowEndsAt = hourWindowEnd(now);

  const hourlyLimit = params.hourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER;
  const minGapMs = params.minGapMs ?? env.MIN_DELAY_BETWEEN_EMAILS_MS;
  const globalLimit = env.MAX_EMAILS_PER_HOUR_GLOBAL;

  const client = redis as unknown as RedisWithScripts;

  const [allowed, reason, retryAfterMs, count, remaining] = await client.acquireSendSlot(
    rateLimitKey(params.tenantId, params.senderId, windowKey),
    senderGapKey(params.senderId),
    globalRateLimitKey(params.tenantId, windowKey),
    String(hourlyLimit),
    String(minGapMs),
    String(now),
    String(RATE_LIMIT_TTL_SECONDS),
    String(SENDER_GAP_TTL_SECONDS),
    String(globalLimit),
    String(windowEndsAt),
  );

  if (allowed === 1) {
    return {
      allowed: true,
      countThisWindow: count,
      remainingThisWindow: remaining,
      windowEndsAt,
    };
  }

  return {
    allowed: false,
    reason: reason as DenyReason,
    // Never return a non-positive delay: a zero delay would spin the job straight
    // back into the worker and burn CPU in a tight loop.
    retryAfterMs: Math.max(1, retryAfterMs),
    countThisWindow: count,
    remainingThisWindow: remaining,
    windowEndsAt,
  };
}

/**
 * Give a consumed slot back.
 *
 * Only called when a slot was taken but SMTP was never attempted — for example when
 * the DB claim fails immediately afterwards. It is deliberately NOT called on send
 * failure: a failed send still opened a connection and still counts against a real
 * provider's budget, so counting it is the conservative and realistic choice.
 */
export async function releaseSendSlot(
  tenantId: string,
  senderId: string,
  now = Date.now(),
): Promise<void> {
  registerRateLimitScripts();
  const windowKey = hourWindowKey(now);

  try {
    await (redis as unknown as RedisWithScripts).releaseSendSlot(
      rateLimitKey(tenantId, senderId, windowKey),
      globalRateLimitKey(tenantId, windowKey),
      String(env.MAX_EMAILS_PER_HOUR_GLOBAL),
    );
  } catch (err) {
    // A leaked slot costs one email of throughput this hour and self-heals when the
    // key expires. Not worth failing the request over.
    log.warn({ err, senderId }, 'Failed to release send slot');
  }
}

export interface SenderUsage {
  senderId: string;
  windowStart: number;
  windowEndsAt: number;
  used: number;
  limit: number;
  remaining: number;
}

/** Read-only usage snapshot, for the dashboard and the health score. Never mutates. */
export async function getSenderUsage(
  tenantId: string,
  senderId: string,
  hourlyLimit: number,
  now = Date.now(),
): Promise<SenderUsage> {
  const windowKey = hourWindowKey(now);
  const raw = await redis.get(rateLimitKey(tenantId, senderId, windowKey));
  const used = Number.parseInt(raw ?? '0', 10);

  return {
    senderId,
    windowStart: windowKey * 3_600_000,
    windowEndsAt: hourWindowEnd(now),
    used,
    limit: hourlyLimit,
    remaining: Math.max(0, hourlyLimit - used),
  };
}

/** Batched usage read for the sender-health endpoint — one pipeline, not N round-trips. */
export async function getUsageForSenders(
  tenantId: string,
  senders: { id: string; hourlyLimit: number }[],
  now = Date.now(),
): Promise<Map<string, SenderUsage>> {
  const result = new Map<string, SenderUsage>();
  if (senders.length === 0) return result;

  const windowKey = hourWindowKey(now);
  const pipeline = redis.pipeline();
  for (const sender of senders) {
    pipeline.get(rateLimitKey(tenantId, sender.id, windowKey));
  }
  const responses = await pipeline.exec();

  senders.forEach((sender, index) => {
    const entry = responses?.[index];
    const used = Number.parseInt((entry?.[1] as string | null) ?? '0', 10) || 0;
    result.set(sender.id, {
      senderId: sender.id,
      windowStart: windowKey * 3_600_000,
      windowEndsAt: hourWindowEnd(now),
      used,
      limit: sender.hourlyLimit,
      remaining: Math.max(0, sender.hourlyLimit - used),
    });
  });

  return result;
}
