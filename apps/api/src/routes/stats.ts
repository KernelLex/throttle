/**
 * Dashboard statistics.
 */

import { Router } from 'express';
import { hourWindowStart, type ApiResponse, type DashboardStatsDto } from '@throttle/core';
import { prisma } from '../lib/prisma.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/validate.js';

export const statsRouter = Router();

statsRouter.use(requireAuth);

// ── GET /api/stats ────────────────────────────────────────────────────────────

statsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const windowStart = new Date(hourWindowStart(Date.now()));

    // One round-trip for all of it. Issued as a Promise.all rather than sequentially
    // because the dashboard polls this and sequential counts would make it the
    // slowest endpoint in the app.
    const [
      scheduledCount,
      sentCount,
      failedCount,
      sentLastHour,
      activeCampaigns,
      activeSenders,
      openCircuits,
      nextSend,
    ] = await Promise.all([
      prisma.emailJob.count({
        where: { tenantId, status: { in: ['SCHEDULED', 'QUEUED', 'SENDING', 'RESCHEDULED'] } },
      }),
      prisma.emailJob.count({ where: { tenantId, status: 'SENT' } }),
      prisma.emailJob.count({ where: { tenantId, status: 'FAILED' } }),
      prisma.emailJob.count({
        where: { tenantId, status: 'SENT', sentAt: { gte: windowStart } },
      }),
      prisma.campaign.count({ where: { tenantId, status: { in: ['SCHEDULED', 'RUNNING'] } } }),
      prisma.sender.count({ where: { tenantId, isActive: true } }),
      prisma.sender.count({ where: { tenantId, circuitState: 'OPEN' } }),
      prisma.emailJob.findFirst({
        where: { tenantId, status: { in: ['SCHEDULED', 'QUEUED', 'RESCHEDULED'] } },
        orderBy: { scheduledAt: 'asc' },
        select: { scheduledAt: true },
      }),
    ]);

    const data: DashboardStatsDto = {
      scheduledCount,
      sentCount,
      failedCount,
      sentLastHour,
      activeCampaigns,
      activeSenders,
      openCircuits,
      nextSendAt: nextSend?.scheduledAt.toISOString() ?? null,
    };

    const body: ApiResponse<DashboardStatsDto> = { ok: true, data };
    res.json(body);
  }),
);
