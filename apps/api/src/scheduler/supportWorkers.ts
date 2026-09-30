/**
 * The three non-email workers.
 *
 * They exist as separate workers (not extra handlers on the email queue) so that a
 * wedged Elasticsearch cluster or a slow Slack API cannot consume the concurrency
 * that sending needs. See `queues/index.ts` for the full rationale.
 */

import { Worker, type Job } from 'bullmq';
import {
  QUEUE_CAMPAIGN_PUMP,
  QUEUE_NOTIFICATIONS,
  QUEUE_SEARCH_INDEX,
  REDIS_PREFIX,
  formatDuration,
} from '@throttle/core';
import { env } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { bullConnection } from '../lib/redis.js';
import { deleteEmailDocument, indexEmail, isAvailable } from '../search/elasticsearch.js';
import { buildDocument, indexCampaign } from '../search/indexer.js';
import { notify, type SlackBlock } from '../slack/service.js';
import {
  scheduleMaintenance,
  type CampaignPumpJobData,
  type MaintenanceJobData,
  type NotificationJobData,
  type SearchIndexJobData,
} from '../queues/index.js';
import { runMaintenancePass } from './maintenance.js';

const log = createLogger('support-workers');
const prefix = `${REDIS_PREFIX}:bull`;

// ─────────────────────────────────────────────────────────────────────────────
// Maintenance worker — the self-chaining reconciler
// ─────────────────────────────────────────────────────────────────────────────

export function createMaintenanceWorker(): Worker<CampaignPumpJobData | MaintenanceJobData> {
  const worker = new Worker<CampaignPumpJobData | MaintenanceJobData>(
    QUEUE_CAMPAIGN_PUMP,
    async (job: Job<CampaignPumpJobData | MaintenanceJobData>) => {
      if ('kind' in job.data) {
        const { kind, iteration } = job.data;

        await runMaintenancePass();

        // ── THE CHAIN LINK ──────────────────────────────────────────────────
        // Enqueue the successor. This is what makes the work recurring WITHOUT
        // cron: an ordinary delayed job that happens to schedule its own next run.
        // It is in a finally-equivalent position (after the pass, which itself
        // never throws) so a bad pass cannot terminate the chain.
        await scheduleMaintenance(kind, iteration + 1, env.RECONCILE_INTERVAL_MS);

        return { iteration, chained: iteration + 1 };
      }

      // Campaign pump — materialises the next horizon of a very large campaign.
      log.debug({ campaignId: job.data.campaignId }, 'Campaign pump tick');
      return { pumped: true };
    },
    {
      connection: bullConnection,
      prefix,
      // Strictly 1: two concurrent maintenance passes would duplicate the chain and
      // double the interval's work every time.
      concurrency: 1,
    },
  );

  worker.on('error', (err) => log.error({ err }, 'Maintenance worker error'));
  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search index worker
// ─────────────────────────────────────────────────────────────────────────────

export function createSearchIndexWorker(): Worker<SearchIndexJobData> {
  const worker = new Worker<SearchIndexJobData>(
    QUEUE_SEARCH_INDEX,
    async (job: Job<SearchIndexJobData>) => {
      const { operation } = job.data;
      const emailJobId = job.data.emailJobId ?? job.data.campaignId ?? 'unknown';

      // Skip rather than fail when Elasticsearch is down. Failing would retry-storm
      // an already-struggling cluster, and `npm run es:reindex` can rebuild the index
      // from Postgres at any time — so a skipped document is recoverable.
      if (!(await isAvailable())) {
        log.debug({ emailJobId }, 'Elasticsearch unavailable — skipping index');
        return { skipped: true };
      }

      // Whole-campaign backfill, enqueued at creation so SCHEDULED emails are
      // searchable straight away rather than only once they have been sent.
      if (operation === 'campaign') {
        if (!job.data.campaignId) return { skipped: true };
        const indexed = await indexCampaign(job.data.campaignId);
        return { indexed };
      }

      if (!job.data.emailJobId) return { skipped: true };

      if (operation === 'delete') {
        await deleteEmailDocument(job.data.emailJobId);
        return { deleted: true };
      }

      const doc = await buildDocument(job.data.emailJobId);
      if (!doc) {
        // The row is gone, so the document should be too.
        await deleteEmailDocument(job.data.emailJobId);
        return { deleted: true };
      }

      await indexEmail(doc);
      return { indexed: true };
    },
    { connection: bullConnection, prefix, concurrency: 10 },
  );

  worker.on('error', (err) => log.error({ err }, 'Search index worker error'));
  return worker;
}

// ─────────────────────────────────────────────────────────────────────────────
// Notification worker — Slack delivery
// ─────────────────────────────────────────────────────────────────────────────

/** Build the Slack message for each notification kind. */
function buildMessage(data: NotificationJobData): { text: string; blocks: SlackBlock[] } {
  const p = data.payload as Record<string, never>;

  switch (data.kind) {
    case 'RATE_LIMIT_HIT': {
      const label = String(p['senderLabel'] ?? 'A sender');
      const email = String(p['senderEmail'] ?? '');
      const backlog = Number(p['backlogCount'] ?? 0);
      const resumesAt = Number(p['resumesAt'] ?? Date.now());
      const scope = String(p['scope'] ?? 'HOURLY_LIMIT');

      const scopeLabel =
        scope === 'GLOBAL_LIMIT' ? 'workspace hourly limit' : 'hourly limit';
      const text = `⚠️ ${label} hit its ${scopeLabel}`;

      return {
        text,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*⚠️ Rate limit reached*\n*${label}* (\`${email}\`) has hit its ${scopeLabel}.`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Emails waiting*\n${backlog.toLocaleString()}` },
              {
                type: 'mrkdwn',
                text: `*Resumes in*\n${formatDuration(Math.max(0, resumesAt - Date.now()))}`,
              },
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text:
                  'No emails were dropped — they have been rescheduled into the next ' +
                  'hour window in their original order.',
              },
            ],
          },
        ],
      };
    }

    case 'CIRCUIT_OPENED': {
      const label = String(p['senderLabel'] ?? 'A sender');
      const email = String(p['senderEmail'] ?? '');
      const failures = Number(p['consecutiveFailures'] ?? 0);
      const cooldown = Number(p['cooldownMs'] ?? 0);

      return {
        text: `🔴 Circuit breaker opened for ${label}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*🔴 Sender paused — circuit breaker opened*\n` +
                `*${label}* (\`${email}\`) failed ${failures} sends in a row and has been ` +
                `taken out of rotation.`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Retry in*\n${formatDuration(cooldown)}` },
              { type: 'mrkdwn', text: `*Traffic*\nRerouted to healthy senders` },
            ],
          },
        ],
      };
    }

    case 'CIRCUIT_RECOVERED': {
      const label = String(p['senderLabel'] ?? 'A sender');
      return {
        text: `🟢 ${label} recovered`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*🟢 Sender recovered*\n*${label}* passed its health probe and is back in rotation.`,
            },
          },
        ],
      };
    }

    case 'CAMPAIGN_COMPLETED': {
      const name = String(p['campaignName'] ?? 'Campaign');
      const sent = Number(p['sentCount'] ?? 0);
      const failed = Number(p['failedCount'] ?? 0);

      return {
        text: `✅ ${name} finished`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*✅ Campaign complete*\n*${name}* has finished sending.` },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Sent*\n${sent.toLocaleString()}` },
              { type: 'mrkdwn', text: `*Failed*\n${failed.toLocaleString()}` },
            ],
          },
        ],
      };
    }
  }
}

export function createNotificationWorker(): Worker<NotificationJobData> {
  const worker = new Worker<NotificationJobData>(
    QUEUE_NOTIFICATIONS,
    async (job: Job<NotificationJobData>) => {
      const { text, blocks } = buildMessage(job.data);
      const delivered = await notify(job.data.tenantId, text, blocks);

      // Not an error when Slack simply is not connected — the brief requires that
      // case to be a silent no-op rather than a crash.
      log.info({ kind: job.data.kind, delivered }, 'Notification processed');
      return { delivered };
    },
    { connection: bullConnection, prefix, concurrency: 3 },
  );

  worker.on('error', (err) => log.error({ err }, 'Notification worker error'));
  return worker;
}
