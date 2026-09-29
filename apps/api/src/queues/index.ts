/**
 * BullMQ queue definitions.
 *
 * FOUR QUEUES, NOT ONE
 * --------------------
 * Separating them means a slow Slack API or a wedged Elasticsearch cluster cannot
 * consume the worker slots that email sending needs. With a single queue, one
 * unreachable third party stalls delivery — the classic head-of-line blocking that
 * makes an outage look like a scheduler bug.
 *
 *   email-send     the real work; the only queue with a strict rate limit
 *   campaign-pump  incremental materialisation for very large campaigns
 *   search-index   Elasticsearch writes, entirely off the SMTP hot path
 *   notifications  Slack delivery, so a 5-second Slack timeout never delays a send
 *
 * NO CRON — ANYWHERE
 * ------------------
 * BullMQ's `repeat:` option is backed by cron expressions and is therefore NOT used
 * here, deliberately, to honour the brief's hard constraint. Recurring work (the
 * reconciler, the reaper, the pump) is implemented as a SELF-CHAINING DELAYED JOB:
 * each run finishes by enqueuing its own successor with a delay. That is a plain
 * delayed job, has no cron expression anywhere in its implementation, and survives
 * restarts because the successor is already persisted in Redis before the current
 * run completes.
 */

import { Queue, type JobsOptions } from 'bullmq';
import {
  QUEUE_CAMPAIGN_PUMP,
  QUEUE_EMAIL_SEND,
  QUEUE_NOTIFICATIONS,
  QUEUE_SEARCH_INDEX,
  REDIS_PREFIX,
} from '@throttle/core';
import { env } from '../config.js';
import { bullConnection } from '../lib/redis.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('queues');

/** Namespacing every BullMQ key lets this Redis instance be shared safely. */
const prefix = `${REDIS_PREFIX}:bull`;

// ── Job payload types ─────────────────────────────────────────────────────────

export interface SendEmailJobData {
  emailJobId: string;
  tenantId: string;
  campaignId: string;
  /** Who the planner chose. The worker may override this if the circuit is open. */
  plannedSenderId: string;
  /** Carried for ordering and for deterministic stagger on a rate-limit bounce. */
  sequenceNo: number;
}

export interface CampaignPumpJobData {
  campaignId: string;
  tenantId: string;
  /** Materialise jobs scheduled before this epoch ms. */
  horizonMs: number;
}

export type MaintenanceKind = 'reconcile' | 'reap';

export interface MaintenanceJobData {
  kind: MaintenanceKind;
  /** Incremented each chain link — useful for spotting a runaway chain in logs. */
  iteration: number;
}

export interface SearchIndexJobData {
  emailJobId: string;
  tenantId: string;
  operation: 'upsert' | 'delete';
}

export type NotificationKind =
  | 'RATE_LIMIT_HIT'
  | 'CIRCUIT_OPENED'
  | 'CIRCUIT_RECOVERED'
  | 'CAMPAIGN_COMPLETED';

export interface NotificationJobData {
  kind: NotificationKind;
  tenantId: string;
  payload: Record<string, unknown>;
}

// ── Shared job options ────────────────────────────────────────────────────────

/**
 * Completed jobs are kept (capped) rather than removed, because the Bull Board
 * dashboard the brief asks for is worthless if it shows an empty queue seconds after
 * a send. Failed jobs are kept far longer — they are the ones worth investigating.
 */
const defaultJobOptions: JobsOptions = {
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
};

// ── Queue instances ───────────────────────────────────────────────────────────

export const emailSendQueue = new Queue<SendEmailJobData>(QUEUE_EMAIL_SEND, {
  connection: bullConnection,
  prefix,
  defaultJobOptions: {
    ...defaultJobOptions,
    // Retries here cover TRANSIENT SMTP failures only. Rate-limit bounces use
    // moveToDelayed(), which deliberately does not consume an attempt — being
    // throttled is not a failure and must never exhaust a job's retry budget.
    attempts: env.MAX_SEND_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.RETRY_BACKOFF_MS },
  },
});

export const campaignPumpQueue = new Queue<CampaignPumpJobData | MaintenanceJobData>(
  QUEUE_CAMPAIGN_PUMP,
  {
    connection: bullConnection,
    prefix,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    },
  },
);

export const searchIndexQueue = new Queue<SearchIndexJobData>(QUEUE_SEARCH_INDEX, {
  connection: bullConnection,
  prefix,
  defaultJobOptions: {
    ...defaultJobOptions,
    // Indexing is best-effort: Postgres remains the source of truth and the reindex
    // script can rebuild the whole index, so a few lost index jobs are recoverable.
    attempts: 5,
    backoff: { type: 'exponential', delay: 2_000 },
  },
});

export const notificationsQueue = new Queue<NotificationJobData>(QUEUE_NOTIFICATIONS, {
  connection: bullConnection,
  prefix,
  defaultJobOptions: {
    ...defaultJobOptions,
    attempts: 3,
    backoff: { type: 'exponential', delay: 3_000 },
  },
});

export const allQueues = [
  emailSendQueue,
  campaignPumpQueue,
  searchIndexQueue,
  notificationsQueue,
];

// ── Enqueue helpers ───────────────────────────────────────────────────────────

/**
 * Enqueue one email send.
 *
 * `jobId` is the EmailJob's primary key. This is IDEMPOTENCY LAYER 1: BullMQ refuses
 * to add a job whose id already exists, so calling this twice for the same recipient
 * — from a retried API call, from the reconciler, from the pump — cannot produce two
 * sends. It is a silent no-op rather than an error, which is exactly what we want.
 */
export async function enqueueSend(
  data: SendEmailJobData,
  scheduledAt: number,
  now = Date.now(),
): Promise<void> {
  // A negative delay would be rejected; a past-due job should simply run now. This is
  // the normal case after a restart, where jobs became due while the process was down.
  const delay = Math.max(0, scheduledAt - now);

  await emailSendQueue.add('send', data, {
    jobId: data.emailJobId,
    delay,
  });
}

/** Bulk enqueue for campaign creation. Chunking is the caller's responsibility. */
export async function enqueueSendBulk(
  items: { data: SendEmailJobData; scheduledAt: number }[],
  now = Date.now(),
): Promise<void> {
  if (items.length === 0) return;

  await emailSendQueue.addBulk(
    items.map(({ data, scheduledAt }) => ({
      name: 'send',
      data,
      opts: { jobId: data.emailJobId, delay: Math.max(0, scheduledAt - now) },
    })),
  );
}

export async function enqueueSearchIndex(data: SearchIndexJobData): Promise<void> {
  await searchIndexQueue.add('index', data, {
    // Collapses repeated updates for the same email into one pending job.
    jobId: `idx:${data.emailJobId}:${data.operation}`,
  });
}

export async function enqueueNotification(data: NotificationJobData): Promise<void> {
  await notificationsQueue.add('notify', data);
}

/**
 * Schedule the next link in a maintenance chain.
 *
 * THIS IS THE NO-CRON MECHANISM. Each maintenance run ends by calling this, which
 * adds a single delayed job. There is no cron expression, no `repeat:` option and no
 * scheduling library — just an ordinary BullMQ delayed job that happens to enqueue
 * its own successor.
 *
 * The fixed `jobId` per iteration makes the chain self-healing: if two processes both
 * try to schedule iteration 42, BullMQ keeps one. That prevents the chain from
 * doubling every time a second worker instance starts.
 */
export async function scheduleMaintenance(
  kind: MaintenanceKind,
  iteration: number,
  delayMs: number = env.RECONCILE_INTERVAL_MS,
): Promise<void> {
  await campaignPumpQueue.add(
    kind,
    { kind, iteration } satisfies MaintenanceJobData,
    {
      jobId: `maint:${kind}:${iteration}`,
      delay: delayMs,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  );
}

export async function enqueueCampaignPump(
  data: CampaignPumpJobData,
  delayMs: number,
): Promise<void> {
  await campaignPumpQueue.add('pump', data, {
    jobId: `pump:${data.campaignId}:${data.horizonMs}`,
    delay: Math.max(0, delayMs),
  });
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled(allQueues.map((queue) => queue.close()));
  log.info('Queues closed');
}
