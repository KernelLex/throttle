/**
 * The email send worker.
 *
 * This is where every guarantee in the brief has to actually hold, so the ordering of
 * operations below is deliberate rather than incidental.
 *
 * THE SEQUENCE, AND WHY IT IS THIS SEQUENCE
 * -----------------------------------------
 *   1. Load the job + campaign + sender pool from Postgres
 *   2. Pick a sender (health-scored; reroutes away from open circuits)
 *   3. Acquire a rate-limit slot in Redis      ← atomic, before any DB write
 *   4. CLAIM the job in Postgres               ← atomic compare-and-swap
 *   5. Send over SMTP
 *   6. Record the outcome + circuit-breaker state
 *
 * Step 3 before step 4: the limiter is the cheaper check and the one most likely to
 * deny. Claiming first would mean flipping a row to SENDING and then immediately
 * reverting it on every throttled job — thousands of pointless writes under load.
 *
 * Step 4 before step 5: the claim is what makes double-sending impossible. It must
 * commit before a single byte reaches SMTP.
 *
 * THREE INDEPENDENT IDEMPOTENCY LAYERS
 * ------------------------------------
 *   1. BullMQ `jobId` = EmailJob id → the same job cannot be enqueued twice
 *   2. The DB claim (below)         → only one worker can transition a row to SENDING
 *   3. `@@unique([campaignId, recipientEmail])` → the database itself refuses dupes
 *
 * Layer 2 is the one that matters at send time. Layers 1 and 3 are defence in depth:
 * if Redis is flushed and the reconciler re-enqueues, or if two API calls race to
 * create the same campaign, the remaining layers still hold.
 *
 * RATE LIMITS ARE NOT FAILURES
 * ----------------------------
 * A throttled job is moved to delayed via `moveToDelayed()`, which does NOT consume a
 * BullMQ attempt. Throwing instead would burn the retry budget on being throttled and
 * eventually mark a perfectly good email as permanently failed — precisely the "do
 * not drop or permanently fail jobs" the brief forbids.
 */

import { DelayedError, UnrecoverableError, Worker, type Job } from 'bullmq';
import { QUEUE_EMAIL_SEND, REDIS_PREFIX, hourWindowStart } from '@throttle/core';
import type { EmailStatus } from '@throttle/core';
import { env } from '../config.js';
import { isPermanentSmtpError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { bullConnection } from '../lib/redis.js';
import { sendEmail } from '../mailer/send.js';
import type { PoolSender } from '../mailer/transport.js';
import { enqueueNotification, enqueueSearchIndex, type SendEmailJobData } from '../queues/index.js';
import { acquireSendSlot, getUsageForSenders, releaseSendSlot } from './rateLimiter.js';
import { recordSendResult, selectHealthiestSender } from './senderHealth.js';
import {
  shouldNotifyCircuitChange,
  shouldNotifyRateLimit,
  shouldNotifySendersExhausted,
} from './notificationGuards.js';

const log = createLogger('email-worker');

/** Identifies this process in `locked_by`, so an abandoned claim is traceable. */
const WORKER_ID = `${process.pid}@${process.env['HOSTNAME'] ?? 'local'}`;

/**
 * Spread synchronised retries.
 *
 * After a restart, hundreds of overdue jobs wake at once. If each is rescheduled by
 * exactly the same `retryAfterMs`, they all wake together again — a thundering herd
 * that repeats indefinitely. Staggering by sequence number is deterministic (no
 * randomness, so behaviour stays reproducible) and spreads the retry across a spread
 * of slots.
 */
function staggerFor(sequenceNo: number, gapMs: number): number {
  const slots = Math.max(1, env.WORKER_CONCURRENCY);
  return (sequenceNo % slots) * Math.max(gapMs, 250);
}

interface LoadedJob {
  emailJob: {
    id: string;
    tenantId: string;
    campaignId: string;
    recipientEmail: string;
    recipientName: string | null;
    mergeData: unknown;
    sequenceNo: number;
    plannedSenderId: string;
    status: EmailStatus;
    attempts: number;
    rescheduleCount: number;
  };
  campaign: { subject: string; bodyTemplate: string; minGapMs: number; hourlyLimitPerSender: number };
}

/**
 * Atomically claim a job.
 *
 * Raw SQL because Prisma has no primitive for `UPDATE ... WHERE <status guard>
 * RETURNING *`, and this statement is the single thing standing between us and a
 * double send. Postgres guarantees only one concurrent transaction can match the
 * WHERE clause and transition the row — the loser gets zero rows back.
 *
 * `locked_at` doubles as the reaper's input: a worker killed between here and the
 * SMTP call leaves a stale claim that the reaper returns to SCHEDULED.
 */
async function claimJob(emailJobId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE email_jobs
       SET status     = 'SENDING',
           attempts   = attempts + 1,
           "lockedAt" = NOW(),
           "lockedBy" = ${WORKER_ID},
           "updatedAt" = NOW()
     WHERE id = ${emailJobId}
       AND status IN ('SCHEDULED', 'QUEUED', 'RESCHEDULED')
    RETURNING id
  `;
  return rows.length > 0;
}

/** Release a claim without consuming an attempt — used when we claim then must bail. */
async function releaseClaim(emailJobId: string, status: EmailStatus): Promise<void> {
  await prisma.emailJob.update({
    where: { id: emailJobId },
    data: { status, lockedAt: null, lockedBy: null, attempts: { decrement: 1 } },
  });
}

async function loadJob(emailJobId: string): Promise<LoadedJob | null> {
  const row = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: {
      campaign: {
        select: {
          subject: true,
          bodyTemplate: true,
          minGapMs: true,
          hourlyLimitPerSender: true,
          status: true,
        },
      },
    },
  });

  if (!row) return null;

  // A cancelled or paused campaign must not keep sending. Checked here rather than by
  // purging the queue, because purging thousands of delayed jobs is slow and racy.
  if (row.campaign.status === 'CANCELLED' || row.campaign.status === 'PAUSED') return null;

  return {
    emailJob: row,
    campaign: row.campaign,
  };
}

/**
 * Active senders for this tenant, with both SMTP credentials and scheduling policy.
 *
 * Selected explicitly rather than with a bare `findMany` so that adding a column to
 * the Sender model can never silently widen what this hot-path query pulls — and so
 * it is obvious at a glance that the encrypted password is loaded deliberately.
 */
async function loadSenderPool(tenantId: string): Promise<PoolSender[]> {
  return prisma.sender.findMany({
    where: { tenantId, isActive: true },
    select: {
      id: true,
      label: true,
      fromName: true,
      fromEmail: true,
      smtpHost: true,
      smtpPort: true,
      smtpUser: true,
      smtpPasswordEnc: true,
      smtpSecure: true,
      hourlyLimit: true,
      minGapMs: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export function createEmailWorker(): Worker<SendEmailJobData> {
  const worker = new Worker<SendEmailJobData>(
    QUEUE_EMAIL_SEND,
    async (job: Job<SendEmailJobData>, token?: string) => {
      const { emailJobId, tenantId, sequenceNo } = job.data;
      const jobLog = log.child({ emailJobId, attempt: job.attemptsMade + 1 });

      // ── 1. Load ────────────────────────────────────────────────────────────
      const loaded = await loadJob(emailJobId);
      if (!loaded) {
        jobLog.info('Email job missing, cancelled or campaign paused — skipping');
        return { skipped: true, reason: 'not-actionable' };
      }

      const { emailJob, campaign } = loaded;

      // Already terminal. This is the reconciler's re-enqueue meeting a job that
      // completed while the process was down — a no-op, not an error.
      if (emailJob.status === 'SENT' || emailJob.status === 'CANCELLED') {
        jobLog.info({ status: emailJob.status }, 'Already terminal — skipping');
        return { skipped: true, reason: 'already-terminal' };
      }

      const senders = await loadSenderPool(tenantId);
      if (senders.length === 0) {
        // No senders at all is a configuration problem, not a transient one. Retrying
        // cannot fix it, so fail fast rather than burning the retry budget.
        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            lastError: 'No active senders are configured for this workspace.',
            lockedAt: null,
            lockedBy: null,
          },
        });
        throw new UnrecoverableError('No active senders configured');
      }

      // ── 2. Choose a sender ─────────────────────────────────────────────────
      const usage = await getUsageForSenders(
        tenantId,
        senders.map((s) => ({ id: s.id, hourlyLimit: s.hourlyLimit })),
      );

      // Prefer the planner's choice, but only if it is still healthy and has budget.
      const planned = senders.find((s) => s.id === emailJob.plannedSenderId);
      const plannedUsable =
        planned !== undefined && (usage.get(planned.id)?.remaining ?? 0) > 0;

      let chosen = plannedUsable
        ? await selectHealthiestSender([planned!], usage)
        : null;

      if (!chosen) {
        // Planned sender is out of budget or circuit-open → reroute to the healthiest
        // available sender. This is the circuit breaker doing its job.
        chosen = await selectHealthiestSender(senders, usage);
      }

      if (!chosen) {
        // Every sender is throttled or broken. NOT a failure — push into the next
        // window and try again. The brief is explicit that jobs must never be dropped.
        const nextWindow = hourWindowStart(Date.now()) + 3_600_000;
        const delayMs = Math.max(1, nextWindow - Date.now()) + staggerFor(sequenceNo, 1_000);

        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'RESCHEDULED',
            scheduledAt: new Date(Date.now() + delayMs),
            hourWindow: new Date(hourWindowStart(Date.now() + delayMs)),
            rescheduleCount: { increment: 1 },
            lastError: 'All senders unavailable (rate limited or circuit open).',
          },
        });

        // Nothing can send at all. This is the most serious state the scheduler
        // reaches, and until now it was the only one that stayed silent — the
        // per-sender limit alert below never fires here, because execution never
        // reaches the rate limiter.
        if (await shouldNotifySendersExhausted(tenantId)) {
          const [backlog, senderStates] = await Promise.all([
            prisma.emailJob.count({
              where: { tenantId, status: { in: ['SCHEDULED', 'QUEUED', 'RESCHEDULED'] } },
            }),
            prisma.sender.findMany({
              where: { tenantId, isActive: true },
              select: { label: true, circuitState: true, lastError: true },
            }),
          ]);

          await enqueueNotification({
            kind: 'SENDERS_EXHAUSTED',
            tenantId,
            payload: {
              senderCount: senderStates.length,
              openCircuits: senderStates.filter((s) => s.circuitState === 'OPEN').length,
              backlogCount: backlog,
              resumesAt: Date.now() + delayMs,
              senders: senderStates.map((s) => ({
                label: s.label,
                state: s.circuitState,
                lastError: s.lastError?.slice(0, 160) ?? null,
              })),
            },
          });
        }

        jobLog.warn({ delayMs }, 'No sender available — deferring to next window');
        await job.moveToDelayed(Date.now() + delayMs, token);
        throw new DelayedError();
      }

      const sender = senders.find((s) => s.id === chosen!.senderId)!;
      const wasRerouted = sender.id !== emailJob.plannedSenderId;

      // ── 3. Rate-limit slot ─────────────────────────────────────────────────
      const slot = await acquireSendSlot({
        tenantId,
        senderId: sender.id,
        hourlyLimit: Math.min(sender.hourlyLimit, campaign.hourlyLimitPerSender),
        minGapMs: Math.max(sender.minGapMs, campaign.minGapMs),
      });

      if (!slot.allowed) {
        const delayMs = slot.retryAfterMs + staggerFor(sequenceNo, campaign.minGapMs);
        const newScheduledAt = Date.now() + delayMs;

        await prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            status: 'RESCHEDULED',
            scheduledAt: new Date(newScheduledAt),
            hourWindow: new Date(hourWindowStart(newScheduledAt)),
            rescheduleCount: { increment: 1 },
            lastError: `Deferred: ${slot.reason}`,
          },
        });

        // An hourly-limit hit is the event the brief wants surfaced in Slack. The
        // guard collapses a whole blocked backlog into ONE message per sender per
        // window — without it, 1,000 throttled jobs would send 1,000 Slack messages.
        if (slot.reason === 'HOURLY_LIMIT' || slot.reason === 'GLOBAL_LIMIT') {
          if (await shouldNotifyRateLimit(tenantId, sender.id)) {
            const backlog = await prisma.emailJob.count({
              where: { tenantId, status: { in: ['SCHEDULED', 'QUEUED', 'RESCHEDULED'] } },
            });

            await enqueueNotification({
              kind: 'RATE_LIMIT_HIT',
              tenantId,
              payload: {
                senderId: sender.id,
                senderLabel: sender.label,
                senderEmail: sender.fromEmail,
                limit: slot.countThisWindow,
                scope: slot.reason,
                windowEndsAt: slot.windowEndsAt,
                resumesAt: newScheduledAt,
                backlogCount: backlog,
              },
            });
          }
        }

        jobLog.info(
          { reason: slot.reason, delayMs, senderId: sender.id },
          'Rate limited — rescheduled (not failed)',
        );

        await job.moveToDelayed(newScheduledAt, token);
        throw new DelayedError();
      }

      // ── 4. Claim ───────────────────────────────────────────────────────────
      const claimed = await claimJob(emailJobId);
      if (!claimed) {
        // Another worker owns this job. Hand the slot back — we consumed budget we
        // are not going to use.
        await releaseSendSlot(tenantId, sender.id);
        jobLog.info('Lost the claim race — another worker owns this job');
        return { skipped: true, reason: 'claim-lost' };
      }

      // ── 5. Send ────────────────────────────────────────────────────────────
      const result = await sendEmail({
        sender,
        to: emailJob.recipientEmail,
        toName: emailJob.recipientName,
        subject: campaign.subject,
        body: campaign.bodyTemplate,
        mergeData: emailJob.mergeData as Record<string, unknown> | null,
        messageIdSeed: emailJob.id,
      });

      // ── 6. Record ──────────────────────────────────────────────────────────
      const health = await recordSendResult(sender.id, result.ok);

      // Alert on real state transitions only — `stateChanged` is true once per
      // transition, not once per failed send.
      if (health.stateChanged && (await shouldNotifyCircuitChange(tenantId, sender.id))) {
        await enqueueNotification({
          kind: health.state === 'OPEN' ? 'CIRCUIT_OPENED' : 'CIRCUIT_RECOVERED',
          tenantId,
          payload: {
            senderId: sender.id,
            senderLabel: sender.label,
            senderEmail: sender.fromEmail,
            state: health.state,
            previousState: health.previousState,
            consecutiveFailures: health.consecutiveFailures,
            failureRate: health.failureRate,
            cooldownMs: env.CIRCUIT_COOLDOWN_MS,
          },
        });
      }

      if (result.ok) {
        await prisma.$transaction([
          prisma.emailJob.update({
            where: { id: emailJobId },
            data: {
              status: 'SENT',
              sentAt: new Date(),
              actualSenderId: sender.id,
              messageId: result.messageId,
              previewUrl: result.previewUrl,
              lastError: null,
              lockedAt: null,
              lockedBy: null,
            },
          }),
          prisma.sender.update({
            where: { id: sender.id },
            data: {
              totalSent: { increment: 1 },
              lastSuccessAt: new Date(),
              consecutiveFailures: 0,
              circuitState: health.state,
            },
          }),
        ]);

        await enqueueSearchIndex({ emailJobId, tenantId, operation: 'upsert' });

        jobLog.info(
          {
            senderId: sender.id,
            to: emailJob.recipientEmail,
            rerouted: wasRerouted,
            previewUrl: result.previewUrl,
          },
          'Email sent',
        );

        return { sent: true, previewUrl: result.previewUrl, senderId: sender.id };
      }

      // ── Failure ────────────────────────────────────────────────────────────
      const permanent = isPermanentSmtpError(result.cause);
      const attemptsUsed = emailJob.attempts + 1;
      const exhausted = attemptsUsed >= env.MAX_SEND_ATTEMPTS;
      const terminal = permanent || exhausted;

      await prisma.$transaction([
        prisma.emailJob.update({
          where: { id: emailJobId },
          data: {
            // Non-terminal failures go back to SCHEDULED so BullMQ's own retry can
            // re-claim them; the claim guard accepts that status.
            status: terminal ? 'FAILED' : 'SCHEDULED',
            failedAt: terminal ? new Date() : null,
            actualSenderId: sender.id,
            lastError: result.error.slice(0, 2_000),
            lockedAt: null,
            lockedBy: null,
          },
        }),
        prisma.sender.update({
          where: { id: sender.id },
          data: {
            totalFailed: { increment: 1 },
            lastFailureAt: new Date(),
            lastError: result.error.slice(0, 500),
            consecutiveFailures: health.consecutiveFailures,
            circuitState: health.state,
            circuitOpenedAt: health.state === 'OPEN' ? new Date() : null,
          },
        }),
      ]);

      if (terminal) {
        await enqueueSearchIndex({ emailJobId, tenantId, operation: 'upsert' });
        jobLog.error(
          { senderId: sender.id, permanent, attemptsUsed, error: result.error },
          'Email permanently failed',
        );
        // UnrecoverableError stops BullMQ retrying something that cannot succeed.
        throw new UnrecoverableError(result.error);
      }

      jobLog.warn(
        { senderId: sender.id, attemptsUsed, error: result.error },
        'Email send failed — will retry',
      );
      // A plain throw lets BullMQ apply its exponential backoff.
      throw new Error(result.error);
    },
    {
      connection: bullConnection,
      prefix: `${REDIS_PREFIX}:bull`,
      concurrency: env.WORKER_CONCURRENCY,

      // Must exceed the slowest realistic SMTP round-trip, or BullMQ will declare a
      // healthy in-flight send "stalled" and hand it to a second worker — which the
      // DB claim would block, but only after wasted work.
      lockDuration: env.JOB_LOCK_TTL_MS,
      stalledInterval: 30_000,
      maxStalledCount: 2,
    },
  );

  worker.on('failed', (job, err) => {
    // DelayedError is the rate-limit path, not a failure. Logging it as one would
    // make a correctly-throttling system look like it is broken.
    if (err instanceof DelayedError || err.name === 'DelayedError') return;
    log.error({ jobId: job?.id, err: err.message }, 'Job failed');
  });

  worker.on('error', (err) => log.error({ err }, 'Worker error'));

  log.info(
    {
      concurrency: env.WORKER_CONCURRENCY,
      minGapMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
      hourlyLimitPerSender: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
    },
    'Email worker started',
  );

  return worker;
}
