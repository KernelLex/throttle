/**
 * Restart survival: reconciliation, reaping and campaign pumping.
 *
 * WHAT ACTUALLY GOES WRONG ON A RESTART
 * -------------------------------------
 * Three distinct failure modes, each needing a different fix:
 *
 *   A. Process killed between claiming a job and finishing the send.
 *      → Row is stuck in SENDING with a `lockedAt` that never clears.
 *      → Fixed by the REAPER.
 *
 *   B. Redis lost data (flush, eviction, a volume that was not persisted).
 *      → Postgres still has SCHEDULED rows but Redis has no delayed jobs for them.
 *         The emails would simply never send, silently.
 *      → Fixed by the RECONCILER.
 *
 *   C. Process was simply down while jobs came due.
 *      → BullMQ handles this natively: delayed jobs persist in Redis and fire on
 *         reconnect. Nothing to do — but the herd of now-overdue jobs needs spacing,
 *         which the reconciler also handles.
 *
 * WHY NO CRON
 * -----------
 * These run on a SELF-CHAINING DELAYED JOB: each run ends by enqueuing its own
 * successor with a delay. No cron expression, no `repeat:` option, no scheduling
 * library. The chain survives restarts because the successor is already persisted in
 * Redis before the current run finishes — and if it is somehow lost, `startMaintenanceChain()`
 * re-seeds it at boot.
 */

import { BULK_CHUNK_SIZE, hourWindowStart } from '@throttle/core';
import { env } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import {
  enqueueSendBulk,
  scheduleMaintenance,
  type SendEmailJobData,
} from '../queues/index.js';
import { pruneExpiredTokens } from '../auth/tokens.js';

const log = createLogger('maintenance');

/** Statuses that mean "still owed to the user" and must have a queued job. */
const PENDING_STATUSES = ['SCHEDULED', 'QUEUED', 'RESCHEDULED'] as const;

/**
 * Return abandoned claims to the pool.
 *
 * A row sitting in SENDING with a `lockedAt` older than the lock TTL belongs to a
 * worker that died. It is reset to SCHEDULED so it can be claimed again.
 *
 * The `attempts` counter is deliberately NOT decremented: a crash mid-send might
 * have happened *after* SMTP accepted the message, and treating it as a free retry
 * risks a duplicate send. Counting it is the conservative choice — worst case, an
 * email gets one fewer retry than configured.
 */
export async function reapStalledJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - env.JOB_LOCK_TTL_MS);

  const { count } = await prisma.emailJob.updateMany({
    where: { status: 'SENDING', lockedAt: { lt: cutoff } },
    data: { status: 'SCHEDULED', lockedAt: null, lockedBy: null },
  });

  if (count > 0) {
    log.warn({ count, cutoff }, 'Reaped stalled jobs from dead workers');
  }
  return count;
}

/**
 * Re-enqueue pending jobs that have no delayed job in Redis.
 *
 * IMPLEMENTATION NOTE: rather than checking each job's existence (one Redis
 * round-trip per job — unusable at 50k jobs), we blindly re-add them. BullMQ ignores
 * an `add()` whose `jobId` already exists, so re-adding is a cheap no-op for the
 * common case and a repair for the rare one. That is idempotency layer 1 earning its
 * keep: the safe operation and the fast operation are the same operation.
 *
 * Overdue jobs are RE-SPACED rather than all firing at once. After an hour of
 * downtime, hundreds of jobs are due simultaneously; releasing them together would
 * have them all hit the rate limiter and bounce in lockstep. Spacing them by the
 * campaign's own gap means they flow at the intended rate immediately.
 */
export async function reconcileScheduledJobs(): Promise<{ checked: number; requeued: number }> {
  const now = Date.now();

  // Only look at jobs due within the horizon. Anything further out is already safely
  // in Redis and re-adding it every minute would be pure waste.
  const horizon = new Date(now + 2 * 60 * 60 * 1000);

  const pending = await prisma.emailJob.findMany({
    where: {
      status: { in: [...PENDING_STATUSES] },
      scheduledAt: { lte: horizon },
      campaign: { status: { in: ['SCHEDULED', 'RUNNING'] } },
    },
    select: {
      id: true,
      tenantId: true,
      campaignId: true,
      plannedSenderId: true,
      sequenceNo: true,
      scheduledAt: true,
      campaign: { select: { minGapMs: true } },
    },
    orderBy: [{ scheduledAt: 'asc' }, { sequenceNo: 'asc' }],
    take: 10_000,
  });

  if (pending.length === 0) return { checked: 0, requeued: 0 };

  // Re-space anything already overdue, so a backlog drains at the intended rate
  // rather than as one burst.
  let overdueIndex = 0;
  const items = pending.map((job) => {
    const scheduledMs = job.scheduledAt.getTime();

    if (scheduledMs > now) {
      return {
        data: {
          emailJobId: job.id,
          tenantId: job.tenantId,
          campaignId: job.campaignId,
          plannedSenderId: job.plannedSenderId,
          sequenceNo: job.sequenceNo,
        } satisfies SendEmailJobData,
        scheduledAt: scheduledMs,
      };
    }

    const gap = Math.max(job.campaign.minGapMs, 250);
    const spaced = now + overdueIndex * gap;
    overdueIndex++;

    return {
      data: {
        emailJobId: job.id,
        tenantId: job.tenantId,
        campaignId: job.campaignId,
        plannedSenderId: job.plannedSenderId,
        sequenceNo: job.sequenceNo,
      } satisfies SendEmailJobData,
      scheduledAt: spaced,
    };
  });

  for (let i = 0; i < items.length; i += BULK_CHUNK_SIZE) {
    await enqueueSendBulk(items.slice(i, i + BULK_CHUNK_SIZE), now);
  }

  if (overdueIndex > 0) {
    log.info(
      { total: items.length, overdue: overdueIndex },
      'Reconciled scheduled jobs — overdue backlog re-spaced',
    );
  }

  return { checked: pending.length, requeued: items.length };
}

/**
 * Mark campaigns complete once nothing is left pending.
 *
 * Kept out of the send path on purpose: having the last worker to finish decide the
 * campaign is complete is a race, because "last" is not well-defined when jobs can be
 * rescheduled into a later window.
 */
export async function finaliseCompletedCampaigns(): Promise<number> {
  const candidates = await prisma.campaign.findMany({
    where: { status: { in: ['SCHEDULED', 'RUNNING'] } },
    select: { id: true, tenantId: true, name: true },
    take: 500,
  });

  let completed = 0;

  for (const campaign of candidates) {
    const pending = await prisma.emailJob.count({
      where: { campaignId: campaign.id, status: { in: [...PENDING_STATUSES, 'SENDING'] } },
    });

    if (pending === 0) {
      const total = await prisma.emailJob.count({ where: { campaignId: campaign.id } });
      // Guard against a campaign whose rows have not been inserted yet.
      if (total === 0) continue;

      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'COMPLETED' },
      });
      completed++;
      log.info({ campaignId: campaign.id, name: campaign.name }, 'Campaign completed');
    }
  }

  return completed;
}

/**
 * Run one maintenance pass.
 *
 * Order matters: reap before reconcile, so rows freed by the reaper are re-enqueued
 * in the same pass rather than waiting for the next one.
 */
export async function runMaintenancePass(): Promise<void> {
  const started = Date.now();

  try {
    const reaped = await reapStalledJobs();
    const { requeued } = await reconcileScheduledJobs();
    const completed = await finaliseCompletedCampaigns();
    const prunedTokens = await pruneExpiredTokens();

    log.debug(
      { reaped, requeued, completed, prunedTokens, durationMs: Date.now() - started },
      'Maintenance pass complete',
    );
  } catch (err) {
    // Never rethrow: a failed pass must not break the chain, or maintenance stops
    // permanently and the failure is invisible until something else goes wrong.
    log.error({ err }, 'Maintenance pass failed — chain continues');
  }
}

/**
 * Seed the self-chaining maintenance job.
 *
 * Called once at worker startup. `scheduleMaintenance` uses a deterministic jobId per
 * iteration, so several worker instances starting at once produce ONE chain rather
 * than one chain each.
 */
export async function startMaintenanceChain(): Promise<void> {
  await scheduleMaintenance('reconcile', 0, 5_000);
  log.info(
    { intervalMs: env.RECONCILE_INTERVAL_MS },
    'Maintenance chain seeded (self-chaining delayed job — not cron)',
  );
}

/**
 * Startup recovery.
 *
 * Runs once, immediately, before the worker begins consuming. Deliberately eager:
 * waiting for the first scheduled pass would leave jobs stranded for up to a full
 * interval, which on a demo restart looks exactly like the system losing them.
 */
export async function runStartupRecovery(): Promise<void> {
  log.info('Running startup recovery…');

  const reaped = await reapStalledJobs();
  const { requeued } = await reconcileScheduledJobs();

  // Any job whose window has already closed gets moved into the current window, so
  // its rate-limit bucket is the live one rather than an expired key.
  const staleWindow = await prisma.emailJob.updateMany({
    where: {
      status: { in: [...PENDING_STATUSES] },
      hourWindow: { lt: new Date(hourWindowStart(Date.now())) },
    },
    data: { hourWindow: new Date(hourWindowStart(Date.now())) },
  });

  log.info(
    { reaped, requeued, windowsRealigned: staleWindow.count },
    'Startup recovery complete — future sends will fire at the correct time',
  );
}
