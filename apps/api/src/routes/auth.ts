/**
 * Authentication routes.
 *
 * GET  /api/auth/google           → redirect to Google
 * GET  /api/auth/google/callback  → exchange code, set cookies, redirect to dashboard
 * POST /api/auth/refresh          → rotate the session
 * POST /api/auth/logout           → revoke and clear
 * GET  /api/auth/me               → the current user (the only authenticated route here)
 */

import { Router, type Response } from 'express';
import type { ApiResponse, MeResponse, SessionUser } from '@throttle/core';
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  cookieOptions,
  env,
  googleOAuthEnabled,
} from '../config.js';
import {
  buildAuthorizationUrl,
  consumeState,
  exchangeCodeForProfile,
  sanitiseRedirect,
} from '../auth/google.js';
import {
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../auth/tokens.js';
import { badRequest, unauthenticated } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/validate.js';
import { getSlackStatus } from '../slack/service.js';

const log = createLogger('auth-routes');
export const authRouter = Router();

/** Set both session cookies. */
function setSessionCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  refreshExpiresAt: Date,
): void {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60 * 1000,
  });

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
    ...cookieOptions,
    // Scoped to the refresh endpoint only, so the long-lived credential is not
    // attached to every ordinary API request — it is sent exactly where it is used.
    path: '/api/auth',
    expires: refreshExpiresAt,
  });
}

function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, { ...cookieOptions });
  res.clearCookie(REFRESH_COOKIE_NAME, { ...cookieOptions, path: '/api/auth' });
}

/**
 * Find or create the user, and the tenant they belong to.
 *
 * TENANT ASSIGNMENT: users are grouped by email domain. Everyone at `acme.com` lands
 * in the same workspace and shares senders and campaigns.
 *
 * This is a deliberate simplification for the assignment and is documented as such in
 * the README — a real product needs explicit invitations, because domain-based
 * auto-join means anyone who can get an address at the domain joins the workspace.
 * Public domains are therefore given a PRIVATE tenant per user, so signing in with a
 * personal Gmail account never drops someone into a shared workspace with strangers.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
]);

async function findOrCreateUser(profile: {
  googleId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}) {
  const existing = await prisma.user.findUnique({
    where: { googleId: profile.googleId },
    include: { tenant: true },
  });

  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        lastLoginAt: new Date(),
      },
      include: { tenant: true },
    });
  }

  const domain = profile.email.split('@')[1] ?? '';
  const isPublicDomain = PUBLIC_EMAIL_DOMAINS.has(domain);

  return prisma.$transaction(async (tx) => {
    let tenantId: string;
    let isFirstUser = false;

    if (isPublicDomain) {
      const tenant = await tx.tenant.create({
        data: { name: `${profile.name}'s workspace` },
      });
      tenantId = tenant.id;
      isFirstUser = true;
    } else {
      const existingTenant = await tx.tenant.findFirst({
        where: { users: { some: { email: { endsWith: `@${domain}` } } } },
        select: { id: true },
      });

      if (existingTenant) {
        tenantId = existingTenant.id;
      } else {
        const tenant = await tx.tenant.create({ data: { name: domain } });
        tenantId = tenant.id;
        isFirstUser = true;
      }
    }

    return tx.user.create({
      data: {
        tenantId,
        googleId: profile.googleId,
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        // Whoever creates a workspace administers it. Later joiners are members, so
        // an existing workspace cannot be taken over by signing up to its domain.
        role: isFirstUser ? 'ADMIN' : 'MEMBER',
        lastLoginAt: new Date(),
      },
      include: { tenant: true },
    });
  });
}

// ── GET /api/auth/google ──────────────────────────────────────────────────────

authRouter.get(
  '/google',
  asyncHandler(async (req, res) => {
    if (!googleOAuthEnabled) {
      throw badRequest(
        'Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
      );
    }

    const redirectTo = sanitiseRedirect(req.query['redirect']);
    res.redirect(await buildAuthorizationUrl(redirectTo));
  }),
);

// ── GET /api/auth/google/callback ─────────────────────────────────────────────

authRouter.get(
  '/google/callback',
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;

    // The user pressed "Cancel" on Google's consent screen. Not an error worth an
    // error page — send them back to login with a hint.
    if (typeof error === 'string') {
      log.info({ error }, 'Google sign-in was cancelled or denied');
      res.redirect(`${env.WEB_BASE_URL}/login?error=cancelled`);
      return;
    }

    if (typeof code !== 'string' || typeof state !== 'string') {
      res.redirect(`${env.WEB_BASE_URL}/login?error=invalid_response`);
      return;
    }

    try {
      const stored = await consumeState(state);
      const profile = await exchangeCodeForProfile(code, stored.codeVerifier);
      const user = await findOrCreateUser(profile);

      const accessToken = signAccessToken({
        sub: user.id,
        tid: user.tenantId,
        role: user.role,
      });

      const refresh = await issueRefreshToken(user.id, {
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
      });

      setSessionCookies(res, accessToken, refresh.token, refresh.expiresAt);

      await prisma.auditLog.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          action: 'auth.login',
          ipAddress: req.ip ?? null,
          userAgent: req.headers['user-agent']?.slice(0, 500) ?? null,
        },
      });

      log.info({ userId: user.id, email: user.email }, 'User signed in');
      res.redirect(`${env.WEB_BASE_URL}${stored.redirectTo}`);
    } catch (err) {
      // Redirect rather than render a JSON error: the user is in a browser following
      // a redirect chain, and a raw JSON body here is a dead end for them.
      log.warn({ err }, 'Google sign-in failed');
      res.redirect(`${env.WEB_BASE_URL}/login?error=signin_failed`);
    }
  }),
);

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof token !== 'string') {
      throw unauthenticated('No session to refresh.');
    }

    const result = await rotateRefreshToken(token, {
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
    });

    if (!result.ok) {
      clearSessionCookies(res);

      if (result.reason === 'REUSE_DETECTED') {
        // Already logged at error level with the family id by rotateRefreshToken.
        throw unauthenticated('Your session was ended for security reasons. Please sign in again.');
      }
      throw unauthenticated('Your session has expired. Please sign in again.');
    }

    const user = await prisma.user.findUnique({
      where: { id: result.userId },
      select: { id: true, tenantId: true, role: true },
    });

    if (!user) {
      clearSessionCookies(res);
      throw unauthenticated('Account no longer exists.');
    }

    setSessionCookies(
      res,
      signAccessToken({ sub: user.id, tid: user.tenantId, role: user.role }),
      result.token,
      result.expiresAt,
    );

    const body: ApiResponse<{ refreshed: true }> = { ok: true, data: { refreshed: true } };
    res.json(body);
  }),
);

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE_NAME];
    if (typeof token === 'string') {
      await revokeRefreshToken(token);
    }

    clearSessionCookies(res);

    // Always 200, even with no session. Logout must be idempotent — an error here
    // would leave a confused user unable to clear a session they believe they have.
    const body: ApiResponse<{ loggedOut: true }> = { ok: true, data: { loggedOut: true } };
    res.json(body);
  }),
);

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, tenantId } = getAuth(req);

    const user = await prisma.user.findFirst({
      // tenantId in the WHERE, not just the id: a token whose tenant no longer
      // matches the user must not resolve.
      where: { id: userId, tenantId },
      include: { tenant: { select: { name: true } } },
    });

    if (!user) throw unauthenticated('Account no longer exists.');

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      tenantId: user.tenantId,
      tenantName: user.tenant.name,
    };

    const body: ApiResponse<MeResponse> = {
      ok: true,
      data: { user: sessionUser, slack: await getSlackStatus(tenantId) },
    };
    res.json(body);
  }),
);
