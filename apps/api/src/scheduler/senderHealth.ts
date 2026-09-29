/**
 * Health-aware sender rotation with a circuit breaker.
 *
 * WHY NOT ROUND-ROBIN
 * -------------------
 * Plain round-robin keeps handing work to a sender whose SMTP credentials have just
 * been revoked. Every one of those sends burns a retry budget, adds latency, and —
 * with a real provider — damages domain reputation. The failure is silent: the queue
 * drains, the dashboard shows activity, and a third of the mail never arrives.
 *
 * THE MODEL
 * ---------
 *   healthScore = remainingHourlyBudget × (1 − recentFailureRate)
 *
 * Both factors matter, and multiplying them is what makes the score meaningful:
 *   - budget alone would pick a fresh-but-broken sender over a busy-but-healthy one
 *   - reliability alone would pile every send onto one sender until it hit its limit
 *
 * A sender whose circuit is OPEN scores exactly 0 and is never selected.
 *
 * STATE MACHINE
 * -------------
 *   CLOSED ──(N consecutive failures)──▶ OPEN
 *   OPEN ──(cooldown elapsed)──▶ HALF_OPEN ──(M successes)──▶ CLOSED
 *                                     └──(any failure)──▶ OPEN (cooldown restarts)
 *
 * HALF_OPEN admits ONE probe at a time. Without that lock, the moment a cooldown
 * expires every waiting worker probes simultaneously — which is precisely the
 * hammering the breaker exists to prevent.
 *
 * All transitions happen inside Lua, so concurrent workers cannot interleave a
 * read-modify-write and lose a state change.
 */

import { CIRCUIT_STATES, senderHealthKey, type CircuitState } from '@throttle/core';
import { env } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

const log = createLogger('sender-health');

/** How long a single HALF_OPEN probe may hold its slot before being considered lost. */
const PROBE_LOCK_TTL_MS = 60_000;

/**
 * Decide whether a sender may be used right now, performing any due state transition.
 *
 * KEYS[1] health hash
 * ARGV[1] nowMs   ARGV[2] cooldownMs   ARGV[3] probeLockTtlMs
 *
 * Returns { eligible, state, consecutiveFailures, failureRatePct, isProbe }
 */
const CHECK_ELIGIBILITY_SCRIPT = `
local key = KEYS[1]
local nowMs         = tonumber(ARGV[1])
local cooldownMs    = tonumber(ARGV[2])
local probeTtlMs    = tonumber(ARGV[3])

local state    = redis.call('HGET', key, 'state') or 'CLOSED'
local openedAt = tonumber(redis.call('HGET', key, 'openedAt') or '0')
local fails    = tonumber(redis.call('HGET', key, 'consecutiveFailures') or '0')
local recent   = redis.call('HGET', key, 'recent') or ''

local failureRatePct = 0
if #recent > 0 then
  local _, failures = string.gsub(recent, '1', '1')
  failureRatePct = math.floor((failures / #recent) * 100)
end

if state == 'CLOSED' then
  return { 1, 'CLOSED', fails, failureRatePct, 0 }
end

if state == 'OPEN' then
  -- Still cooling down?
  if (nowMs - openedAt) < cooldownMs then
    return { 0, 'OPEN', fails, failureRatePct, 0 }
  end
  -- Cooldown elapsed: promote to HALF_OPEN and take the single probe slot.
  redis.call('HSET', key, 'state', 'HALF_OPEN', 'probeAt', nowMs, 'halfOpenSuccesses', 0)
  return { 1, 'HALF_OPEN', fails, failureRatePct, 1 }
end

if state == 'HALF_OPEN' then
  -- Exactly one probe in flight. A stale lock (from a worker that died mid-probe)
  -- is reclaimed after probeTtlMs so the breaker cannot wedge shut forever.
  local probeAt = tonumber(redis.call('HGET', key, 'probeAt') or '0')
  if (nowMs - probeAt) >= probeTtlMs then
    redis.call('HSET', key, 'probeAt', nowMs)
    return { 1, 'HALF_OPEN', fails, failureRatePct, 1 }
  end
  return { 0, 'HALF_OPEN', fails, failureRatePct, 0 }
end

return { 1, 'CLOSED', fails, failureRatePct, 0 }
`;

/**
 * Record a send outcome and run the resulting state transition.
 *
 * KEYS[1] health hash
 * ARGV[1] success(1/0)  ARGV[2] nowMs            ARGV[3] failureThreshold
 * ARGV[4] successThreshold  ARGV[5] rollingWindow  ARGV[6] cooldownMs
 *
 * Returns { state, consecutiveFailures, failureRatePct, stateChanged, previousState }
 *
 * `stateChanged` is what drives the Slack alert — it fires exactly once per real
 * transition rather than once per failed job.
 */
const RECORD_RESULT_SCRIPT = `
local key = KEYS[1]
local success          = tonumber(ARGV[1])
local nowMs            = tonumber(ARGV[2])
local failureThreshold = tonumber(ARGV[3])
local successThreshold = tonumber(ARGV[4])
local rollingWindow    = tonumber(ARGV[5])
local cooldownMs       = tonumber(ARGV[6])

local state    = redis.call('HGET', key, 'state') or 'CLOSED'
local fails    = tonumber(redis.call('HGET', key, 'consecutiveFailures') or '0')
local halfOk   = tonumber(redis.call('HGET', key, 'halfOpenSuccesses') or '0')
local recent   = redis.call('HGET', key, 'recent') or ''

local previousState = state

-- Rolling outcome ring, newest on the right: '0' = success, '1' = failure.
recent = recent .. (success == 1 and '0' or '1')
if #recent > rollingWindow then
  recent = string.sub(recent, #recent - rollingWindow + 1)
end

if success == 1 then
  fails = 0
  redis.call('HINCRBY', key, 'sent', 1)
  redis.call('HSET', key, 'lastSuccessAt', nowMs)

  if state == 'HALF_OPEN' then
    halfOk = halfOk + 1
    if halfOk >= successThreshold then
      -- Recovered. Clear the probe lock so normal traffic resumes.
      state = 'CLOSED'
      halfOk = 0
      redis.call('HSET', key, 'openedAt', 0, 'probeAt', 0)
    end
  end
else
  fails = fails + 1
  halfOk = 0
  redis.call('HINCRBY', key, 'failed', 1)
  redis.call('HSET', key, 'lastFailureAt', nowMs)

  if state == 'HALF_OPEN' then
    -- The probe failed: the sender is still broken. Reopen and restart the cooldown.
    state = 'OPEN'
    redis.call('HSET', key, 'openedAt', nowMs, 'probeAt', 0)
  elseif state == 'CLOSED' and fails >= failureThreshold then
    state = 'OPEN'
    redis.call('HSET', key, 'openedAt', nowMs, 'probeAt', 0)
  end
end

redis.call('HSET', key, 'state', state, 'consecutiveFailures', fails,
           'halfOpenSuccesses', halfOk, 'recent', recent)

local failureRatePct = 0
if #recent > 0 then
  local _, failures = string.gsub(recent, '1', '1')
  failureRatePct = math.floor((failures / #recent) * 100)
end

local changed = 0
if state ~= previousState then changed = 1 end

return { state, fails, failureRatePct, changed, previousState }
`;

let scriptsRegistered = false;

export function registerHealthScripts(): void {
  if (scriptsRegistered) return;
  redis.defineCommand('checkSenderEligibility', { numberOfKeys: 1, lua: CHECK_ELIGIBILITY_SCRIPT });
  redis.defineCommand('recordSendResult', { numberOfKeys: 1, lua: RECORD_RESULT_SCRIPT });
  scriptsRegistered = true;
  log.debug('Circuit-breaker Lua scripts registered');
}

interface RedisWithHealthScripts {
  checkSenderEligibility(
    key: string,
    nowMs: string,
    cooldownMs: string,
    probeTtlMs: string,
  ): Promise<[number, string, number, number, number]>;

  recordSendResult(
    key: string,
    success: string,
    nowMs: string,
    failureThreshold: string,
    successThreshold: string,
    rollingWindow: string,
    cooldownMs: string,
  ): Promise<[string, number, number, number, string]>;
}

export interface EligibilityResult {
  eligible: boolean;
  state: CircuitState;
  consecutiveFailures: number;
  /** 0–1. */
  failureRate: number;
  /** True when this send is the single HALF_OPEN probe. */
  isProbe: boolean;
}

export async function checkSenderEligibility(
  senderId: string,
  now = Date.now(),
): Promise<EligibilityResult> {
  registerHealthScripts();

  const [eligible, state, fails, failureRatePct, isProbe] = await (
    redis as unknown as RedisWithHealthScripts
  ).checkSenderEligibility(
    senderHealthKey(senderId),
    String(now),
    String(env.CIRCUIT_COOLDOWN_MS),
    String(PROBE_LOCK_TTL_MS),
  );

  return {
    eligible: eligible === 1,
    state: normaliseState(state),
    consecutiveFailures: fails,
    failureRate: failureRatePct / 100,
    isProbe: isProbe === 1,
  };
}

export interface RecordResultOutcome {
  state: CircuitState;
  previousState: CircuitState;
  consecutiveFailures: number;
  failureRate: number;
  /** True only on a real transition — use this to gate alerts. */
  stateChanged: boolean;
}

export async function recordSendResult(
  senderId: string,
  success: boolean,
  now = Date.now(),
): Promise<RecordResultOutcome> {
  registerHealthScripts();

  const [state, fails, failureRatePct, changed, previousState] = await (
    redis as unknown as RedisWithHealthScripts
  ).recordSendResult(
    senderHealthKey(senderId),
    success ? '1' : '0',
    String(now),
    String(env.CIRCUIT_FAILURE_THRESHOLD),
    String(env.CIRCUIT_SUCCESS_THRESHOLD),
    String(env.CIRCUIT_ROLLING_WINDOW),
    String(env.CIRCUIT_COOLDOWN_MS),
  );

  return {
    state: normaliseState(state),
    previousState: normaliseState(previousState),
    consecutiveFailures: fails,
    failureRate: failureRatePct / 100,
    stateChanged: changed === 1,
  };
}

export interface SenderHealthSnapshot {
  senderId: string;
  state: CircuitState;
  consecutiveFailures: number;
  failureRate: number;
  sent: number;
  failed: number;
  openedAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** When a HALF_OPEN probe becomes possible. Null unless OPEN. */
  retryAt: number | null;
}

/** Read-only snapshot for the dashboard. Never transitions state. */
export async function getSenderHealth(
  senderId: string,
  now = Date.now(),
): Promise<SenderHealthSnapshot> {
  const raw = await redis.hgetall(senderHealthKey(senderId));
  return parseHealthHash(senderId, raw, now);
}

/** Batched health read — one pipeline for the whole sender list. */
export async function getHealthForSenders(
  senderIds: string[],
  now = Date.now(),
): Promise<Map<string, SenderHealthSnapshot>> {
  const result = new Map<string, SenderHealthSnapshot>();
  if (senderIds.length === 0) return result;

  const pipeline = redis.pipeline();
  for (const id of senderIds) pipeline.hgetall(senderHealthKey(id));
  const responses = await pipeline.exec();

  senderIds.forEach((id, index) => {
    const raw = (responses?.[index]?.[1] as Record<string, string> | null) ?? {};
    result.set(id, parseHealthHash(id, raw, now));
  });

  return result;
}

function parseHealthHash(
  senderId: string,
  raw: Record<string, string>,
  now: number,
): SenderHealthSnapshot {
  const state = normaliseState(raw['state'] ?? 'CLOSED');
  const recent = raw['recent'] ?? '';
  const failures = recent.split('').filter((c) => c === '1').length;
  const openedAt = toNumberOrNull(raw['openedAt']);

  return {
    senderId,
    state,
    consecutiveFailures: Number.parseInt(raw['consecutiveFailures'] ?? '0', 10) || 0,
    failureRate: recent.length > 0 ? failures / recent.length : 0,
    sent: Number.parseInt(raw['sent'] ?? '0', 10) || 0,
    failed: Number.parseInt(raw['failed'] ?? '0', 10) || 0,
    openedAt,
    lastSuccessAt: toNumberOrNull(raw['lastSuccessAt']),
    lastFailureAt: toNumberOrNull(raw['lastFailureAt']),
    retryAt:
      state === 'OPEN' && openedAt !== null
        ? Math.max(now, openedAt + env.CIRCUIT_COOLDOWN_MS)
        : null,
  };
}

function toNumberOrNull(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normaliseState(value: string): CircuitState {
  return (CIRCUIT_STATES as readonly string[]).includes(value)
    ? (value as CircuitState)
    : 'CLOSED';
}

// ── Scoring and selection ─────────────────────────────────────────────────────

export interface ScoredSender {
  senderId: string;
  label: string;
  score: number;
  eligible: boolean;
  state: CircuitState;
  remainingBudget: number;
  failureRate: number;
}

/**
 * Score one sender. Exported because the dashboard shows the same number the
 * selector uses — a score the UI computed differently would be worse than no score.
 */
export function computeHealthScore(params: {
  remainingBudget: number;
  failureRate: number;
  eligible: boolean;
}): number {
  if (!params.eligible || params.remainingBudget <= 0) return 0;
  return params.remainingBudget * (1 - params.failureRate);
}

/**
 * Pick the best sender for a send.
 *
 * Called at PICKUP time, not at plan time. The planner assigns a preferred sender
 * hours in advance; by the time a job actually runs that sender may be out of budget
 * or circuit-open. Re-deciding here — rather than rewriting thousands of queued jobs
 * in Redis — keeps the decision atomic and always based on current truth.
 *
 * Returns null when no sender is usable, which the worker treats as "reschedule",
 * never as "fail".
 */
export async function selectHealthiestSender(
  candidates: { id: string; label: string; hourlyLimit: number }[],
  usage: Map<string, { remaining: number }>,
  now = Date.now(),
): Promise<ScoredSender | null> {
  if (candidates.length === 0) return null;

  const health = await getHealthForSenders(
    candidates.map((c) => c.id),
    now,
  );

  const scored: ScoredSender[] = candidates.map((candidate) => {
    const snapshot = health.get(candidate.id);
    const state = snapshot?.state ?? 'CLOSED';
    const failureRate = snapshot?.failureRate ?? 0;
    const remainingBudget = usage.get(candidate.id)?.remaining ?? candidate.hourlyLimit;

    // Note: this reads state rather than calling checkSenderEligibility, because that
    // function MUTATES (it promotes OPEN→HALF_OPEN and claims the probe slot). Scoring
    // must stay side-effect free; the winner is confirmed with a real eligibility
    // check below, so exactly one probe slot is ever claimed.
    const eligible = state !== 'OPEN' && remainingBudget > 0;

    return {
      senderId: candidate.id,
      label: candidate.label,
      score: computeHealthScore({ remainingBudget, failureRate, eligible }),
      eligible,
      state,
      remainingBudget,
      failureRate,
    };
  });

  const ranked = scored
    .filter((s) => s.eligible && s.score > 0)
    .sort((a, b) => b.score - a.score || a.senderId.localeCompare(b.senderId));

  if (ranked.length === 0) return null;

  // Confirm the winner with the mutating check, so an OPEN circuit whose cooldown
  // just elapsed properly claims its single probe slot.
  for (const candidate of ranked) {
    const eligibility = await checkSenderEligibility(candidate.senderId, now);
    if (eligibility.eligible) {
      return { ...candidate, state: eligibility.state };
    }
  }

  return null;
}

/** Clear a sender's health state. Used by the seed script and by a manual reset. */
export async function resetSenderHealth(senderId: string): Promise<void> {
  await redis.del(senderHealthKey(senderId));
  log.info({ senderId }, 'Sender health reset');
}
