/**
 * Turning EmailJob rows into Elasticsearch documents.
 *
 * Shared by the indexing worker and the reindex script, so a document written
 * during normal operation and one written by a full rebuild are byte-identical.
 * Two separate mappers would drift, and the drift would only show up as search
 * results that differ depending on when a row happened to be indexed.
 */

import { BULK_CHUNK_SIZE } from '@throttle/core';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { bulkIndexEmails, type EmailDocument } from './elasticsearch.js';

const log = createLogger('indexer');

/** Everything a document needs, in one query shape. */
const INDEX_INCLUDE = {
  campaign: { select: { name: true, subject: true, bodyTemplate: true } },
  plannedSender: { select: { label: true } },
} as const;

type IndexableRow = {
  id: string;
  tenantId: string;
  campaignId: string;
  recipientEmail: string;
  recipientName: string | null;
  status: EmailDocument['status'];
  plannedSenderId: string;
  actualSenderId: string | null;
  scheduledAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  lastError: string | null;
  rescheduleCount: number;
  createdAt: Date;
  campaign: { name: string; subject: string; bodyTemplate: string };
  plannedSender: { label: string };
};

export function toDocument(row: IndexableRow): EmailDocument {
  return {
    emailJobId: row.id,
    tenantId: row.tenantId,
    campaignId: row.campaignId,
    campaignName: row.campaign.name,
    recipientEmail: row.recipientEmail,
    recipientName: row.recipientName,
    subject: row.campaign.subject,
    body: row.campaign.bodyTemplate,
    status: row.status,
    plannedSenderId: row.plannedSenderId,
    actualSenderId: row.actualSenderId,
    senderLabel: row.plannedSender.label,
    scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    lastError: row.lastError,
    rescheduleCount: row.rescheduleCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Index every email in a campaign.
 *
 * Called on campaign creation so SCHEDULED emails are searchable immediately,
 * which the brief requires — indexing only on send would leave the entire
 * scheduled backlog invisible to search, which is the half of the data a user
 * is most likely to go looking for.
 *
 * Paginated by cursor rather than offset: at 50,000 rows an OFFSET scan re-reads
 * everything it has already skipped.
 */
export async function indexCampaign(campaignId: string): Promise<number> {
  let cursor: string | undefined;
  let indexed = 0;
  let errors = 0;

  for (;;) {
    const rows = await prisma.emailJob.findMany({
      where: { campaignId },
      include: INDEX_INCLUDE,
      orderBy: { id: 'asc' },
      take: BULK_CHUNK_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (rows.length === 0) break;

    const result = await bulkIndexEmails(rows.map((row) => toDocument(row as IndexableRow)));
    indexed += result.indexed;
    errors += result.errors;

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BULK_CHUNK_SIZE) break;
  }

  log.info({ campaignId, indexed, errors }, 'Campaign indexed');
  return indexed;
}

/**
 * Rebuild the entire index from Postgres.
 *
 * This is what makes Elasticsearch safely disposable: it is a derived store, and
 * anything in it can be reconstructed from the source of truth. Used by the
 * `es:reindex` script and safe to run against a live system.
 */
export async function reindexAll(
  onProgress?: (done: number, total: number) => void,
): Promise<{ indexed: number; errors: number }> {
  const total = await prisma.emailJob.count();
  let cursor: string | undefined;
  let indexed = 0;
  let errors = 0;

  for (;;) {
    const rows = await prisma.emailJob.findMany({
      include: INDEX_INCLUDE,
      orderBy: { id: 'asc' },
      take: BULK_CHUNK_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (rows.length === 0) break;

    const result = await bulkIndexEmails(rows.map((row) => toDocument(row as IndexableRow)));
    indexed += result.indexed;
    errors += result.errors;

    onProgress?.(indexed + errors, total);

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < BULK_CHUNK_SIZE) break;
  }

  return { indexed, errors };
}

/** Build a document for one email, or null if the row is gone. */
export async function buildDocument(emailJobId: string): Promise<EmailDocument | null> {
  const row = await prisma.emailJob.findUnique({
    where: { id: emailJobId },
    include: INDEX_INCLUDE,
  });
  return row ? toDocument(row as IndexableRow) : null;
}
