/**
 * Email listing and search.
 *
 * Powers the Scheduled and Sent tabs, plus the Elasticsearch-backed search.
 */

import { Router } from 'express';
import {
  listEmailsSchema,
  searchEmailsSchema,
  type ApiResponse,
  type EmailJobDto,
  type Paginated,
  type SearchHitDto,
  type SearchResponse,
} from '@throttle/core';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler, getQuery, validateQuery } from '../middleware/validate.js';
import { isAvailable, searchEmails } from '../search/elasticsearch.js';

const log = createLogger('email-routes');
export const emailsRouter = Router();

emailsRouter.use(requireAuth);

/** Shape used by every list/search response. Kept in one place so the two paths
 *  cannot drift into returning subtly different objects. */
const emailInclude = {
  campaign: { select: { name: true, subject: true } },
  plannedSender: { select: { label: true } },
  actualSender: { select: { label: true } },
} satisfies Prisma.EmailJobInclude;

type EmailRow = Prisma.EmailJobGetPayload<{ include: typeof emailInclude }>;

function toDto(row: EmailRow): EmailJobDto {
  return {
    id: row.id,
    recipientEmail: row.recipientEmail,
    subject: row.campaign.subject,
    status: row.status,
    scheduledAt: row.scheduledAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    campaignId: row.campaignId,
    campaignName: row.campaign.name,
    plannedSenderId: row.plannedSenderId,
    plannedSenderLabel: row.plannedSender.label,
    actualSenderId: row.actualSenderId,
    actualSenderLabel: row.actualSender?.label ?? null,
    attempts: row.attempts,
    lastError: row.lastError,
    previewUrl: row.previewUrl,
    rescheduleCount: row.rescheduleCount,
  };
}

// ── GET /api/emails ───────────────────────────────────────────────────────────

emailsRouter.get(
  '/',
  validateQuery(listEmailsSchema),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const query = getQuery<z.infer<typeof listEmailsSchema>>(req);

    const where: Prisma.EmailJobWhereInput = { tenantId };

    if (query.status) {
      where.status = query.status;
    } else if (query.bucket === 'scheduled') {
      // "Scheduled" means everything still owed to the user, including jobs a rate
      // limit has pushed into a later window — those are pending, not finished.
      where.status = { in: ['SCHEDULED', 'QUEUED', 'SENDING', 'RESCHEDULED'] };
    } else if (query.bucket === 'sent') {
      // "Sent" includes FAILED: the brief's Sent table has a status column showing
      // `sent` / `failed`, so failures belong in this view rather than nowhere.
      where.status = { in: ['SENT', 'FAILED'] };
    }

    if (query.campaignId) where.campaignId = query.campaignId;
    if (query.senderId) {
      where.OR = [{ plannedSenderId: query.senderId }, { actualSenderId: query.senderId }];
    }

    // Sent emails read best newest-first; scheduled ones read best soonest-first.
    const sortBy = query.bucket === 'sent' ? 'sentAt' : query.sortBy;
    const sortDir = query.bucket === 'sent' ? 'desc' : query.sortDir;

    const [rows, total] = await Promise.all([
      prisma.emailJob.findMany({
        where,
        include: emailInclude,
        orderBy: [{ [sortBy]: sortDir }, { sequenceNo: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.emailJob.count({ where }),
    ]);

    const body: ApiResponse<Paginated<EmailJobDto>> = {
      ok: true,
      data: {
        items: rows.map(toDto),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
    res.json(body);
  }),
);

// ── GET /api/emails/search ────────────────────────────────────────────────────

emailsRouter.get(
  '/search',
  validateQuery(searchEmailsSchema),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const query = getQuery<z.infer<typeof searchEmailsSchema>>(req);
    const started = Date.now();

    // ── Elasticsearch path ────────────────────────────────────────────────
    if (await isAvailable()) {
      try {
        const results = await searchEmails({
          // From the session. `searchEmailsSchema` has no tenantId field, so a client
          // cannot supply one even by trying.
          tenantId,
          query: query.q,
          ...(query.status ? { status: query.status } : {}),
          ...(query.campaignId ? { campaignId: query.campaignId } : {}),
          ...(query.senderId ? { senderId: query.senderId } : {}),
          ...(query.from ? { from: new Date(query.from) } : {}),
          ...(query.to ? { to: new Date(query.to) } : {}),
          page: query.page,
          pageSize: query.pageSize,
        });

        // Hydrate from Postgres so the response is identical in shape to the list
        // endpoint, and so a stale index cannot serve deleted rows.
        const rows = await prisma.emailJob.findMany({
          where: { id: { in: results.items.map((i) => i.emailJobId) }, tenantId },
          include: emailInclude,
        });

        // flatMap rather than map+filter: a type predicate on the filter would have
        // to restate the whole DTO shape, which drifts the moment the DTO changes.
        // An empty array from flatMap drops the row with no extra typing at all.
        const byId = new Map(rows.map((row) => [row.id, row]));
        const items: SearchHitDto[] = results.items.flatMap((hit) => {
          // A hit with no Postgres row means the index is stale — the row was
          // deleted after indexing. Dropping it is correct: Postgres is the truth.
          const row = byId.get(hit.emailJobId);
          if (!row) return [];
          return [{ ...toDto(row), score: hit.score, highlights: hit.highlights }];
        });

        const body: ApiResponse<SearchResponse> = {
          ok: true,
          data: {
            items,
            page: query.page,
            pageSize: query.pageSize,
            total: results.total,
            totalPages: Math.ceil(results.total / query.pageSize),
            backend: 'elasticsearch',
            tookMs: results.tookMs,
          },
        };
        res.json(body);
        return;
      } catch (err) {
        // Fall through to Postgres rather than erroring. Degraded search beats no
        // dashboard.
        log.warn({ err }, 'Elasticsearch query failed — falling back to Postgres');
      }
    }

    // ── Postgres fallback ─────────────────────────────────────────────────
    // No ranking and no highlighting, but the feature keeps working and the response
    // says `backend: 'postgres-fallback'` so the UI can say so honestly.
    const where: Prisma.EmailJobWhereInput = {
      tenantId,
      OR: [
        { recipientEmail: { contains: query.q, mode: 'insensitive' } },
        { campaign: { subject: { contains: query.q, mode: 'insensitive' } } },
        { campaign: { name: { contains: query.q, mode: 'insensitive' } } },
      ],
      ...(query.status ? { status: query.status } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.emailJob.findMany({
        where,
        include: emailInclude,
        orderBy: { scheduledAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.emailJob.count({ where }),
    ]);

    const body: ApiResponse<SearchResponse> = {
      ok: true,
      data: {
        items: rows.map((row) => ({ ...toDto(row), score: null })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
        backend: 'postgres-fallback',
        tookMs: Date.now() - started,
      },
    };
    res.json(body);
  }),
);

// ── GET /api/emails/:id ───────────────────────────────────────────────────────

emailsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);

    const row = await prisma.emailJob.findFirst({
      where: { id: req.params['id']!, tenantId },
      include: emailInclude,
    });

    if (!row) {
      const body: ApiResponse<never> = {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Email not found.' },
      };
      res.status(404).json(body);
      return;
    }

    const body: ApiResponse<EmailJobDto> = { ok: true, data: toDto(row) };
    res.json(body);
  }),
);
