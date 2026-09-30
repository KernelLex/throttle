/**
 * Notification debouncing.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * When a sender hits its hourly limit with 1,000 jobs queued behind it, every one of
 * those jobs independently discovers the limit. A naive implementation sends 1,000
 * Slack messages in a few seconds — which gets the app rate-limited by Slack, gets
 * the channel muted by the customer, and buries the one message that mattered.
 *
 * The brief requires a live Slack message "the moment a sender's hourly limit is
 * reached". The right reading of that is ONE message per sender per hour window: the
 * moment is a single event, even though a thousand jobs observe it.
 *
 * WHY SETNX
 * ---------
 * `SET key value NX EX ttl` is atomic. Exactly one of the N concurrent workers gets
 * `OK`; every other gets null. Checking `EXISTS` and then `SET` would let several
 * workers pass the check simultaneously — the same read-modify-write race the rate
 * limiter exists to avoid, reintroduced in the alerting path.
 *
 * The key embeds the hour window, so the alert naturally re-arms next hour without
 * any cleanup: the old key simply expires.
 */

import {
  REDIS_PREFIX,
  SLACK_DEBOUNCE_TTL_SECONDS,
  hourWindowKey,
  slackCircuitDebounceKey,
  slackDebounceKey,
} from '@throttle/core';
import { createLogger } from '../lib/logger.js';
import { redis } from '../lib/redis.js';

const log = createLogger('notification-guard');

/**
 * True for exactly one caller per (tenant, sender, hour window).
 *
 * Fails OPEN on a Redis error — a missed alert is worse than a duplicate one, and an
 * alerting path must never be the thing that breaks sending.
 */
export async function shouldNotifyRateLimit(
  tenantId: string,
  senderId: string,
  now = Date.now(),
): Promise<boolean> {
  const key = slackDebounceKey(tenantId, senderId, hourWindowKey(now));

  try {
    const result = await redis.set(key, '1', 'EX', SLACK_DEBOUNCE_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch (err) {
    log.warn({ err, senderId }, 'Rate-limit debounce check failed — allowing notification');
    return true;
  }
}

/**
 * Debounce circuit-breaker alerts.
 *
 * A much shorter TTL than the rate-limit guard, because an open→closed→open flap is
 * genuinely worth knowing about, whereas a rate limit being hit repeatedly within one
 * window is the same fact restated.
 */
const CIRCUIT_DEBOUNCE_TTL_SECONDS = 60;

export async function shouldNotifyCircuitChange(
  tenantId: string,
  senderId: string,
): Promise<boolean> {
  const key = slackCircuitDebounceKey(tenantId, senderId);

  try {
    const result = await redis.set(key, '1', 'EX', CIRCUIT_DEBOUNCE_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch (err) {
    log.warn({ err, senderId }, 'Circuit debounce check failed — allowing notification');
    return true;
  }
}

/**
 * True for exactly one caller per (tenant, hour window) when NO sender can send.
 *
 * Keyed by tenant rather than by sender: the condition is "nothing can go out at
 * all", which is one fact about the workspace, not one per sender. Alerting per
 * sender would send four messages describing the same outage.
 */
export async function shouldNotifySendersExhausted(
  tenantId: string,
  now = Date.now(),
): Promise<boolean> {
  const key = `${REDIS_PREFIX}:slack:exhausted:${tenantId}:${hourWindowKey(now)}`;
  try {
    const result = await redis.set(key, '1', 'EX', SLACK_DEBOUNCE_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch (err) {
    log.warn({ err, tenantId }, 'Exhausted-senders debounce failed — allowing notification');
    return true;
  }
}

/** Clear debounce keys for a sender. Used when reconnecting Slack, so the next event
 *  notifies immediately rather than being suppressed by a key set before connection. */
export async function clearNotificationGuards(
  tenantId: string,
  senderId: string,
  now = Date.now(),
): Promise<void> {
  await redis.del(
    slackDebounceKey(tenantId, senderId, hourWindowKey(now)),
    slackCircuitDebounceKey(tenantId, senderId),
  );
}
