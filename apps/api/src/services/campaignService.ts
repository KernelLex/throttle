/**
 * Campaign creation — where a plan becomes rows and delayed jobs.
 *
 * THE CRITICAL PROPERTY
 * ---------------------
 * This service calls the SAME `planSchedule()` from @throttle/core that the compose
 * form calls to draw its forecast. Not a server-side reimplementation of it — the
 * identical function, from a shared workspace package.
 *
 * That is what makes the Delivery Planner trustworthy. If this file computed times
 * its own way, the two would drift the moment either changed, and the forecast would
 * quietly become decorative.
 *
 * ORDER OF OPERATIONS
 * -------------------
 *   1. Resolve senders          (authoritative — the client's list is not trusted)
 *   2. planSchedule()           (pure, deterministic)
 *   3. Postgres transaction     (campaign + all EmailJob rows, atomically)
 *   4. Enqueue BullMQ jobs      (AFTER the transaction commits)
 *
 * Step 4 must follow step 3. Enqueuing first would let a worker pick up a job whose
 * row does not exist yet — the worker would find nothing, log a warning, and the
 * email would silently never send. Committing first means the worst case is a job
 * that exists in Postgres but not Redis, which the reconciler repairs automatically.
 */

import {
  BULK_CHUNK_SIZE,
  hourWindowStart,
  parseLeads,
  planSchedule,
  type CampaignCounts,
  type EmailStatus,
  type PlanResult,
  type PlanSender,
} from '@throttle/core';
import type { Prisma } from '@prisma/client';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { enqueueSearchIndex, enqueueSendBulk, type SendEmailJobData } from '../queues/index.js';

const log = createLogger('campaign-service');

export interface CreateCampaignParams {
  tenantId: string;
  userId: string;
  name: string;
  subject: string;
  body: string;
  recipients: string[];
  startAt: Date;
  minGapMs: number;
  hourlyLimitPerSender: number;
  senderIds?: string[];
  idempotencyKey?: string;
}

export interface CreateCampaignResult {
  campaignId: string;
  plan: Omit<PlanResult, 'jobs'>;
  /** True when an existing campaign was returned for a repeated Idempotency-Key. */
  deduplicated: boolean;
}

/**
 * Load the senders a campaign may use.
 *
 * The campaign's `hourlyLimitPerSender` is applied as a CEILING on each sender's own
 * limit, never as a raise. A campaign must not be able to talk a sender into
 * exceeding the limit its administrator configured — otherwise the per-sender limit
 * is advisory, and any user could opt out of it.
 */
async function resolveSenders(
  tenantId: string,
  campaignHourlyLimit: number,
  campaignMinGapMs: number,
  senderIds?: string[],
): Promise<PlanSender[]> {
  const senders = await prisma.sender.findMany({
    where: {
      tenantId,
      isActive: true,
      ...(senderIds && senderIds.length > 0 ? { id: { in: senderIds } } : {}),
    },
    select: { id: true, label: true, hourlyLimit: true, minGapMs: true },
    orderBy: { createdAt: 'asc' },
  });

  if (senders.length === 0) {
    throw badRequest(
      senderIds && senderIds.length > 0
        ? 'None of the selected senders are active.'
        : 'No active senders are configured. Add a sender before scheduling a campaign.',
    );
  }

  return senders.map((sender) => ({
    id: sender.id,
    label: sender.label,
    hourlyLimit: Math.min(sender.hourlyLimit, campaignHourlyLimit),
    minGapMs: Math.max(sender.minGapMs, campaignMinGapMs),
  }));
}

/**
 * Forecast without creating anything.
 *
 * Backs `POST /api/campaigns/preview`, which the compose form uses to confirm its
 * local forecast against the authoritative sender list. The client computes the same
 * plan locally for instant feedback; this endpoint is the source of truth.
 */
export async function previewPlan(params: {
  tenantId: string;
  recipientCount: number;
  startAt: Date;
  minGapMs: number;
  hourlyLimitPerSender: number;
  senderIds?: string[];
}): Promise<Omit<PlanResult, 'jobs'>> {
  const senders = await resolveSenders(
    params.tenantId,
    params.hourlyLimitPerSender,
    params.minGapMs,
    params.senderIds,
  );

  // Placeholder addresses: the plan depends only on the COUNT, never on the actual
  // values, so a preview needs no real recipient data. That also means the compose
  // form can forecast before a file is even uploaded.
  const placeholders = Array.from(
    { length: params.recipientCount },
    (_, i) => `placeholder-${i}@example.com`,
  );

  const { jobs: _jobs, ...summary } = planSchedule({
    recipients: placeholders,
    senders,
    startAt: params.startAt.getTime(),
    minGapMs: params.minGapMs,
  });

  return summary;
}

export async function createCampaign(
  params: CreateCampaignParams,
): Promise<CreateCampaignResult> {
  // ── Idempotency ────────────────────────────────────────────────────────────
  // A retried POST (flaky network, impatient double-click) must not schedule the
  // campaign twice. Checked before any work is done.
  if (params.idempotencyKey) {
    const existing = await prisma.campaign.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: params.tenantId,
          idempotencyKey: params.idempotencyKey,
        },
      },
      select: { id: true, plannedWindowSummary: true },
    });

    if (existing) {
      log.info({ campaignId: existing.id }, 'Idempotency key matched — returning existing campaign');
      return {
        campaignId: existing.id,
        plan: existing.plannedWindowSummary as unknown as Omit<PlanResult, 'jobs'>,
        deduplicated: true,
      };
    }
  }

  // ── 1. Senders ─────────────────────────────────────────────────────────────
  const senders = await resolveSenders(
    params.tenantId,
    params.hourlyLimitPerSender,
    params.minGapMs,
    params.senderIds,
  );

  // Re-parse and re-dedupe server-side. The client already did this to show a count,
  // but that was UX — this is the authoritative pass. A client could send duplicates
  // or malformed addresses regardless of what the UI did.
  const parsed = parseLeads(params.recipients.join('\n'));
  if (parsed.emails.length === 0) {
    throw badRequest('No valid email addresses were found in the recipient list.');
  }

  // ── 2. Plan ────────────────────────────────────────────────────────────────
  const plan = planSchedule({
    recipients: parsed.emails,
    senders,
    startAt: params.startAt.getTime(),
    minGapMs: params.minGapMs,
  });

  if (plan.jobs.length === 0) {
    throw badRequest(
      'The schedule could not be planned. Check that your senders have an hourly limit above zero.',
    );
  }

  const { jobs, ...planSummary } = plan;

  // ── 3. Persist ─────────────────────────────────────────────────────────────
  const campaignId = await prisma.$transaction(
    async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          tenantId: params.tenantId,
          createdByUserId: params.userId,
          name: params.name,
          subject: params.subject,
          bodyTemplate: params.body,
          startAt: params.startAt,
          minGapMs: params.minGapMs,
          hourlyLimitPerSender: params.hourlyLimitPerSender,
          status: 'SCHEDULED',
          totalRecipients: jobs.length,
          plannedWindows: plan.windowCount,
          plannedFinishAt: new Date(plan.finishesAt),
          plannedWindowSummary: planSummary as unknown as Prisma.InputJsonValue,
          idempotencyKey: params.idempotencyKey ?? null,
        },
        select: { id: true },
      });

      // createMany in chunks. One statement for 50,000 rows would exceed Postgres's
      // parameter limit and hold a lock far longer than necessary.
      for (let i = 0; i < jobs.length; i += BULK_CHUNK_SIZE) {
        const chunk = jobs.slice(i, i + BULK_CHUNK_SIZE);
        await tx.emailJob.createMany({
          data: chunk.map((job) => ({
            tenantId: params.tenantId,
            campaignId: campaign.id,
            recipientEmail: job.recipient,
            sequenceNo: job.sequenceNo,
            plannedSenderId: job.senderId,
            hourWindow: new Date(job.windowStart),
            scheduledAt: new Date(job.scheduledAt),
            status: 'SCHEDULED' as const,
          })),
          // The unique constraint on (campaignId, recipientEmail) is the backstop;
          // skipping duplicates means a race cannot abort the whole transaction.
          skipDuplicates: true,
        });
      }

      return campaign.id;
    },
    {
      // Large campaigns legitimately take a while to insert; the default 5s timeout
      // would abort a 50k-recipient campaign partway.
      timeout: 120_000,
      maxWait: 10_000,
    },
  );

  // ── 4. Enqueue ─────────────────────────────────────────────────────────────
  // Only now that the rows are committed. See the header note on ordering.
  const created = await prisma.emailJob.findMany({
    where: { campaignId },
    select: { id: true, plannedSenderId: true, sequenceNo: true, scheduledAt: true },
    orderBy: { sequenceNo: 'asc' },
  });

  const now = Date.now();
  for (let i = 0; i < created.length; i += BULK_CHUNK_SIZE) {
    const chunk = created.slice(i, i + BULK_CHUNK_SIZE);
    await enqueueSendBulk(
      chunk.map((row) => ({
        data: {
          emailJobId: row.id,
          tenantId: params.tenantId,
          campaignId,
          plannedSenderId: row.plannedSenderId,
          sequenceNo: row.sequenceNo,
        } satisfies SendEmailJobData,
        scheduledAt: row.scheduledAt.getTime(),
      })),
      now,
    );
  }

  // Make the SCHEDULED emails searchable immediately. The brief requires both
  // sent AND scheduled email to be searchable, and indexing only on send would
  // leave the entire pending backlog invisible. One campaign-level job rather
  // than one per recipient.
  await enqueueSearchIndex({ tenantId: params.tenantId, campaignId, operation: 'campaign' });

  log.info(
    {
      campaignId,
      recipients: created.length,
      windows: plan.windowCount,
      senders: senders.length,
      finishesAt: new Date(plan.finishesAt).toISOString(),
    },
    'Campaign scheduled',
  );

  return { campaignId, plan: planSummary, deduplicated: false };
}

/**
 * Cancel a campaign.
 *
 * Only pending jobs are cancelled — already-sent emails obviously cannot be recalled,
 * and marking them CANCELLED would corrupt the sent history.
 *
 * The queued BullMQ jobs are deliberately NOT purged. Removing thousands of delayed
 * jobs is slow and racy; instead the worker checks campaign status on pickup and
 * skips. The stale jobs then expire from Redis on their own.
 */
export async function cancelCampaign(tenantId: string, campaignId: string): Promise<number> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, tenantId },
    select: { id: true, status: true },
  });

  if (!campaign) throw notFound('Campaign not found.');
  if (campaign.status === 'COMPLETED') {
    throw conflict('This campaign has already finished.');
  }
  if (campaign.status === 'CANCELLED') {
    throw conflict('This campaign is already cancelled.');
  }

  const [, { count }] = await prisma.$transaction([
    prisma.campaign.update({ where: { id: campaignId }, data: { status: 'CANCELLED' } }),
    prisma.emailJob.updateMany({
      where: { campaignId, status: { in: ['SCHEDULED', 'QUEUED', 'RESCHEDULED'] } },
      data: { status: 'CANCELLED' },
    }),
  ]);

  log.info({ campaignId, cancelledJobs: count }, 'Campaign cancelled');
  return count;
}

/**
 * Live status counts for a campaign.
 *
 * One grouped query rather than seven separate counts — the campaign list renders
 * this per row, so seven queries per row is the difference between a fast list and
 * an N+1 problem.
 */
export async function getCampaignCounts(campaignId: string): Promise<CampaignCounts> {
  const grouped = await prisma.emailJob.groupBy({
    by: ['status'],
    where: { campaignId },
    _count: { _all: true },
  });

  const counts: CampaignCounts = {
    scheduled: 0,
    queued: 0,
    sending: 0,
    sent: 0,
    failed: 0,
    cancelled: 0,
    rescheduled: 0,
    total: 0,
  };

  // Maps the Prisma enum to the DTO's lowercase keys. Explicit rather than a
  // `toLowerCase()` cast, so adding a status to the enum without adding it here is
  // a compile error instead of a silently dropped count.
  const keyByStatus: Record<EmailStatus, keyof CampaignCounts> = {
    SCHEDULED: 'scheduled',
    QUEUED: 'queued',
    SENDING: 'sending',
    SENT: 'sent',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
    RESCHEDULED: 'rescheduled',
  };

  for (const row of grouped) {
    counts[keyByStatus[row.status]] = row._count._all;
    counts.total += row._count._all;
  }

  return counts;
}

/** Current hour window, exported so routes can report it consistently. */
export function currentWindowStart(): Date {
  return new Date(hourWindowStart(Date.now()));
}
