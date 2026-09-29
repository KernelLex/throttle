/**
 * Slack connection routes.
 *
 * NOTE ON `/callback` BEING PUBLIC
 * --------------------------------
 * Slack redirects the user's browser here, and that request carries no session
 * guarantee we can rely on. It is therefore listed in PUBLIC_PATHS — but it is not
 * unauthenticated in any meaningful sense: the `state` parameter is single-use,
 * stored server-side in Redis, and carries the tenant and user that started the flow.
 * Without a valid state the callback does nothing.
 *
 * That is the same pattern as the Google callback, and it is why `state` cannot be
 * treated as an optional nicety.
 */

import { Router } from 'express';
import type { ApiResponse, SlackConnectionStatus } from '@throttle/core';
import { env, slackOAuthEnabled } from '../config.js';
import { badRequest } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getAuth, requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/validate.js';
import {
  buildSlackInstallUrl,
  completeSlackInstall,
  consumeSlackState,
  disconnectSlack,
  getSlackStatus,
  sendTestMessage,
} from '../slack/service.js';

const log = createLogger('slack-routes');
export const slackRouter = Router();

// ── GET /api/slack/install ────────────────────────────────────────────────────

slackRouter.get(
  '/install',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = getAuth(req);

    if (!slackOAuthEnabled) {
      throw badRequest(
        'Slack is not configured on this server. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET.',
      );
    }

    res.redirect(await buildSlackInstallUrl(tenantId, userId));
  }),
);

// ── GET /api/slack/callback ───────────────────────────────────────────────────

slackRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;

    if (typeof error === 'string') {
      res.redirect(`${env.WEB_BASE_URL}/dashboard?slack=cancelled`);
      return;
    }

    if (typeof code !== 'string' || typeof state !== 'string') {
      res.redirect(`${env.WEB_BASE_URL}/dashboard?slack=invalid`);
      return;
    }

    try {
      // Consuming the state is what authenticates this request — it proves the flow
      // was started by a signed-in user of this tenant, and it cannot be replayed.
      const stored = await consumeSlackState(state);
      const { channelName } = await completeSlackInstall(code, stored);

      await prisma.auditLog.create({
        data: {
          tenantId: stored.tenantId,
          userId: stored.userId,
          action: 'slack.connected',
          metadata: { channelName },
          ipAddress: req.ip ?? null,
        },
      });

      // Confirm immediately, so the user sees proof rather than trusting a green dot.
      await sendTestMessage(stored.tenantId);

      res.redirect(`${env.WEB_BASE_URL}/dashboard?slack=connected`);
    } catch (err) {
      log.warn({ err }, 'Slack connection failed');
      res.redirect(`${env.WEB_BASE_URL}/dashboard?slack=failed`);
    }
  }),
);

// ── GET /api/slack/status ─────────────────────────────────────────────────────

slackRouter.get(
  '/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const body: ApiResponse<SlackConnectionStatus> = {
      ok: true,
      data: await getSlackStatus(tenantId),
    };
    res.json(body);
  }),
);

// ── POST /api/slack/test ──────────────────────────────────────────────────────

slackRouter.post(
  '/test',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { tenantId } = getAuth(req);
    const delivered = await sendTestMessage(tenantId);

    const body: ApiResponse<{ delivered: boolean }> = { ok: true, data: { delivered } };
    res.json(body);
  }),
);

// ── POST /api/slack/disconnect ────────────────────────────────────────────────

slackRouter.post(
  '/disconnect',
  requireAuth,
  requireRole('ADMIN'),
  asyncHandler(async (req, res) => {
    const { tenantId, userId } = getAuth(req);

    await disconnectSlack(tenantId);
    await prisma.auditLog.create({
      data: { tenantId, userId, action: 'slack.disconnected', ipAddress: req.ip ?? null },
    });

    const body: ApiResponse<{ disconnected: true }> = { ok: true, data: { disconnected: true } };
    res.json(body);
  }),
);
