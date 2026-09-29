/**
 * Campaign routes.
 *
 * Every query in this file is scoped by `tenantId` taken from the SESSION, never from
 * the request. A campaign id from another tenant returns 404 — deliberately the same
 * response as a genuinely missing id, so the endpoint cannot be used to probe which
 * campaign ids exist.
 */

import { Router } from 'express';
import {
  createCampaignSchema,
  previewPlanSchema,
  type ApiResponse,
  type CampaignDetailDto,
  type CampaignDto,
  type Paginated,
  type PlanPreviewResponse,
  type WindowSummary,
} from '@throttle/core';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler, getQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  cancelCampaign,
  createCampaign,
  getCampaignCounts,
  previewPlan,
} from '../services/campaignService.js';

export const campaignsRouter = Router();

// Every route below requires a session.
campaignsRouter.use(requireAuth);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum(['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'])
    .optional(),
});

// ── POST /api/campaigns/preview ───────────────────────────────────────────────
// Confirms the browser's local forecast against the authoritative sender list.

campaignsRouter.post(
  '/preview',
  validateBody(previewPlanSchema),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const input = req.body as z.infer<typeof previewPlanSchema>;

    const plan = await previewPlan({
      tenantId,
      recipientCount: input.recipientCount,
      startAt: new Date(input.startAt),
      minGapMs: input.minGapMs,
      hourlyLimitPerSender: input.hourlyLimitPerSender,
      ...(input.senderIds ? { senderIds: input.senderIds } : {}),
    });

    const body: ApiResponse<PlanPreviewResponse> = { ok: true, data: { plan } };
    res.json(body);
  }),
);

// ── POST /api/campaigns ───────────────────────────────────────────────────────

campaignsRouter.post(
  '/',
  validateBody(createCampaignSchema),
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = getAuth(req);
    const input = req.body as z.infer<typeof createCampaignSchema>;

    // Standard Idempotency-Key header. A retried POST returns the original campaign
    // rather than scheduling a second one.
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = typeof rawKey === 'string' ? rawKey.slice(0, 200) : undefined;

    const result = await createCampaign({
      tenantId,
      userId,
      name: input.name,
      subject: input.subject,
      body: input.body,
      recipients: input.recipients,
      startAt: new Date(input.startAt),
      minGapMs: input.minGapMs,
      hourlyLimitPerSender: input.hourlyLimitPerSender,
      ...(input.senderIds ? { senderIds: input.senderIds } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'campaign.created',
        resourceType: 'campaign',
        resourceId: result.campaignId,
        metadata: {
          recipients: input.recipients.length,
          windows: result.plan.windowCount,
          deduplicated: result.deduplicated,
        },
        ipAddress: req.ip ?? null,
      },
    });

    const body: ApiResponse<typeof result> = { ok: true, data: result };
    // 200 rather than 201 when deduplicated — nothing new was created.
    res.status(result.deduplicated ? 200 : 201).json(body);
  }),
);

// ── GET /api/campaigns ────────────────────────────────────────────────────────

campaignsRouter.get(
  '/',
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const { page, pageSize, status } = getQuery<z.infer<typeof listQuerySchema>>(req);

    const where = { tenantId, ...(status ? { status } : {}) };

    const [rows, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        include: { createdBy: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.campaign.count({ where }),
    ]);

    const items: CampaignDto[] = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        name: row.name,
        subject: row.subject,
        status: row.status,
        startAt: row.startAt.toISOString(),
        minGapMs: row.minGapMs,
        hourlyLimitPerSender: row.hourlyLimitPerSender,
        totalRecipients: row.totalRecipients,
        plannedWindows: row.plannedWindows,
        plannedFinishAt: row.plannedFinishAt.toISOString(),
        counts: await getCampaignCounts(row.id),
        createdAt: row.createdAt.toISOString(),
        createdByName: row.createdBy.name,
      })),
    );

    const body: ApiResponse<Paginated<CampaignDto>> = {
      ok: true,
      data: { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
    res.json(body);
  }),
);

// ── GET /api/campaigns/:id ────────────────────────────────────────────────────

campaignsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);

    const row = await prisma.campaign.findFirst({
      // tenantId in the WHERE is the isolation boundary.
      where: { id: req.params['id']!, tenantId },
      include: { createdBy: { select: { name: true } } },
    });

    if (!row) throw notFound('Campaign not found.');

    const detail: CampaignDetailDto = {
      id: row.id,
      name: row.name,
      subject: row.subject,
      body: row.bodyTemplate,
      status: row.status,
      startAt: row.startAt.toISOString(),
      minGapMs: row.minGapMs,
      hourlyLimitPerSender: row.hourlyLimitPerSender,
      totalRecipients: row.totalRecipients,
      plannedWindows: row.plannedWindows,
      plannedFinishAt: row.plannedFinishAt.toISOString(),
      counts: await getCampaignCounts(row.id),
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdBy.name,
      plannedWindowSummary:
        ((row.plannedWindowSummary as { windows?: WindowSummary[] } | null)?.windows ?? []),
    };

    const body: ApiResponse<CampaignDetailDto> = { ok: true, data: detail };
    res.json(body);
  }),
);

// ── POST /api/campaigns/:id/cancel ────────────────────────────────────────────

campaignsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = getAuth(req);
    const campaignId = req.params['id']!;

    const cancelled = await cancelCampaign(tenantId, campaignId);

    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'campaign.cancelled',
        resourceType: 'campaign',
        resourceId: campaignId,
        metadata: { cancelledJobs: cancelled },
        ipAddress: req.ip ?? null,
      },
    });

    const body: ApiResponse<{ cancelledJobs: number }> = {
      ok: true,
      data: { cancelledJobs: cancelled },
    };
    res.json(body);
  }),
);
