/**
 * Sender management and live health.
 *
 * `GET /senders/health` is what powers the circuit-breaker panel in the dashboard. It
 * returns the SAME health score the worker uses to choose a sender — computed by the
 * same `computeHealthScore()` from `senderHealth.ts` — because a dashboard showing a
 * number the scheduler does not actually use would be worse than showing none.
 */

import { Router } from 'express';
import {
  createSenderSchema,
  hourWindowStart,
  updateSenderSchema,
  type ApiResponse,
  type SenderDto,
  type SenderHealthDto,
} from '@throttle/core';
import type { z } from 'zod';
import { encrypt } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { invalidateTransport, verifyTransport } from '../mailer/transport.js';
import { getAuth, requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/validate.js';
import { getUsageForSenders } from '../scheduler/rateLimiter.js';
import { computeHealthScore, getHealthForSenders, resetSenderHealth } from '../scheduler/senderHealth.js';

export const sendersRouter = Router();

sendersRouter.use(requireAuth);

/** Never serialise credentials. `SenderDto` has no password field, so this is
 *  enforced by the type rather than by remembering to omit it. */
function toDto(sender: {
  id: string;
  label: string;
  fromName: string;
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpSecure: boolean;
  hourlyLimit: number;
  minGapMs: number;
  isActive: boolean;
  createdAt: Date;
}): SenderDto {
  return {
    id: sender.id,
    label: sender.label,
    fromName: sender.fromName,
    fromEmail: sender.fromEmail,
    smtpHost: sender.smtpHost,
    smtpPort: sender.smtpPort,
    smtpUser: sender.smtpUser,
    smtpSecure: sender.smtpSecure,
    hourlyLimit: sender.hourlyLimit,
    minGapMs: sender.minGapMs,
    isActive: sender.isActive,
    createdAt: sender.createdAt.toISOString(),
  };
}

// ── GET /api/senders ──────────────────────────────────────────────────────────

sendersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);

    const senders = await prisma.sender.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });

    const body: ApiResponse<SenderDto[]> = { ok: true, data: senders.map(toDto) };
    res.json(body);
  }),
);

// ── GET /api/senders/health ───────────────────────────────────────────────────

sendersRouter.get(
  '/health',
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const now = Date.now();

    const senders = await prisma.sender.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });

    // Two pipelines rather than 2N round-trips.
    const [usage, health] = await Promise.all([
      getUsageForSenders(
        tenantId,
        senders.map((s) => ({ id: s.id, hourlyLimit: s.hourlyLimit })),
        now,
      ),
      getHealthForSenders(
        senders.map((s) => s.id),
        now,
      ),
    ]);

    const items: SenderHealthDto[] = senders.map((sender) => {
      const senderUsage = usage.get(sender.id);
      const senderHealth = health.get(sender.id);

      const remaining = senderUsage?.remaining ?? sender.hourlyLimit;
      const state = senderHealth?.state ?? 'CLOSED';
      const failureRate = senderHealth?.failureRate ?? 0;
      const eligible = sender.isActive && state !== 'OPEN' && remaining > 0;

      return {
        senderId: sender.id,
        label: sender.label,
        fromEmail: sender.fromEmail,
        isActive: sender.isActive,

        circuitState: state,
        circuitOpenedAt: senderHealth?.openedAt
          ? new Date(senderHealth.openedAt).toISOString()
          : null,
        retryAt: senderHealth?.retryAt ? new Date(senderHealth.retryAt).toISOString() : null,
        consecutiveFailures: senderHealth?.consecutiveFailures ?? 0,

        windowStart: new Date(hourWindowStart(now)).toISOString(),
        hourlyLimit: sender.hourlyLimit,
        sentThisWindow: senderUsage?.used ?? 0,
        remainingThisWindow: remaining,

        sentTotal: sender.totalSent,
        failedTotal: sender.totalFailed,
        recentFailureRate: failureRate,

        // Identical formula to the one the worker selects with.
        healthScore: computeHealthScore({ remainingBudget: remaining, failureRate, eligible }),
        eligible,
      };
    });

    const body: ApiResponse<SenderHealthDto[]> = { ok: true, data: items };
    res.json(body);
  }),
);

// ── POST /api/senders ─────────────────────────────────────────────────────────
// Admin only: a sender is a sending credential, not a preference.

sendersRouter.post(
  '/',
  requireRole('ADMIN'),
  validateBody(createSenderSchema),
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = getAuth(req);
    const input = req.body as z.infer<typeof createSenderSchema>;

    const encrypted = encrypt(input.smtpPassword);

    // Verify BEFORE saving, so a typo surfaces now rather than three hours later
    // when the first scheduled email silently fails.
    const verification = await verifyTransport({
      id: 'verify-probe',
      label: input.label,
      fromName: input.fromName,
      fromEmail: input.fromEmail,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpUser: input.smtpUser,
      smtpPasswordEnc: encrypted,
      smtpSecure: input.smtpSecure,
    });
    invalidateTransport('verify-probe');

    if (!verification.ok) {
      throw badRequest('Could not connect with those SMTP settings.', {
        smtpHost: [verification.error],
      });
    }

    const sender = await prisma.sender.create({
      data: {
        tenantId,
        label: input.label,
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        smtpHost: input.smtpHost,
        smtpPort: input.smtpPort,
        smtpUser: input.smtpUser,
        smtpPasswordEnc: encrypted,
        smtpSecure: input.smtpSecure,
        hourlyLimit: input.hourlyLimit,
        minGapMs: input.minGapMs,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'sender.created',
        resourceType: 'sender',
        resourceId: sender.id,
        metadata: { label: sender.label, fromEmail: sender.fromEmail },
        ipAddress: req.ip ?? null,
      },
    });

    const body: ApiResponse<SenderDto> = { ok: true, data: toDto(sender) };
    res.status(201).json(body);
  }),
);

// ── PATCH /api/senders/:id ────────────────────────────────────────────────────

sendersRouter.patch(
  '/:id',
  requireRole('ADMIN'),
  validateBody(updateSenderSchema),
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = getAuth(req);
    const senderId = req.params['id']!;
    const input = req.body as z.infer<typeof updateSenderSchema>;

    const existing = await prisma.sender.findFirst({
      where: { id: senderId, tenantId },
      select: { id: true },
    });
    if (!existing) throw notFound('Sender not found.');

    const { smtpPassword, ...rest } = input;

    const sender = await prisma.sender.update({
      where: { id: senderId },
      data: {
        ...rest,
        ...(smtpPassword ? { smtpPasswordEnc: encrypt(smtpPassword) } : {}),
      },
    });

    // Drop the cached transport so the next send uses the new settings rather than
    // a pooled connection authenticated with the old ones.
    invalidateTransport(senderId);

    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'sender.updated',
        resourceType: 'sender',
        resourceId: senderId,
        metadata: { fields: Object.keys(input) },
        ipAddress: req.ip ?? null,
      },
    });

    const body: ApiResponse<SenderDto> = { ok: true, data: toDto(sender) };
    res.json(body);
  }),
);

// ── POST /api/senders/:id/reset-circuit ───────────────────────────────────────
// Manual override for when the credentials have been fixed and waiting out the
// cooldown is pure friction.

sendersRouter.post(
  '/:id/reset-circuit',
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = getAuth(req);
    const senderId = req.params['id']!;

    const existing = await prisma.sender.findFirst({
      where: { id: senderId, tenantId },
      select: { id: true },
    });
    if (!existing) throw notFound('Sender not found.');

    await resetSenderHealth(senderId);
    await prisma.sender.update({
      where: { id: senderId },
      data: { circuitState: 'CLOSED', circuitOpenedAt: null, consecutiveFailures: 0 },
    });

    await prisma.auditLog.create({
      data: {
        tenantId,
        userId,
        action: 'sender.circuit_reset',
        resourceType: 'sender',
        resourceId: senderId,
        ipAddress: req.ip ?? null,
      },
    });

    const body: ApiResponse<{ reset: true }> = { ok: true, data: { reset: true } };
    res.json(body);
  }),
);
