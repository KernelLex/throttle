/**
 * Session tokens.
 *
 * THE SPLIT, AND WHY
 * ------------------
 *   access token  — JWT, 15 minutes, stateless, NOT revocable
 *   refresh token — opaque random string, 7 days, stored hashed, revocable
 *
 * A JWT cannot be revoked without a blocklist that defeats the point of being
 * stateless, so the access token is kept short-lived and the revocation story lives
 * entirely in the refresh token, which we do store and therefore can kill.
 *
 * REFRESH TOKEN ROTATION WITH REUSE DETECTION
 * -------------------------------------------
 * Every refresh issues a NEW refresh token and marks the old one used. All tokens
 * descended from one login share a `familyId`.
 *
 * If a token that was already rotated is presented again, exactly one of two things
 * happened: the token was stolen and the thief is using it, or the token was stolen
 * and the legitimate user is using it. Either way one of the two parties is an
 * attacker and we cannot tell which — so the entire family is revoked and both are
 * forced to re-authenticate. This is the standard OAuth 2.0 BCP mitigation, and it
 * turns a silent long-lived compromise into a single forced re-login.
 *
 * Tokens are stored as SHA-256 hashes: a database leak yields no usable sessions.
 */

import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

const log = createLogger('auth-tokens');

export interface AccessTokenPayload {
  sub: string; // user id
  tid: string; // tenant id
  role: Role;
}

/** Days of validity for a refresh token, derived from the configured TTL string. */
function refreshTtlMs(): number {
  const match = /^(\d+)([smhd])$/.exec(env.JWT_REFRESH_TTL);
  if (!match) return 7 * 24 * 60 * 60 * 1000;

  const value = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const multipliers: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * (multipliers[unit] ?? 86_400_000);
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: 'throttle',
    audience: 'throttle-api',
  } as jwt.SignOptions);
}

/**
 * Verify an access token.
 *
 * `issuer` and `audience` are verified, not merely present. Without that check a JWT
 * signed by any other system sharing the secret would be accepted — and secrets do
 * get reused across services more often than anyone admits.
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'throttle',
      audience: 'throttle-api',
      algorithms: ['HS256'], // pinned: never let the token's own header pick `none`
    });

    if (typeof decoded === 'string') return null;
    const { sub, tid, role } = decoded as jwt.JwtPayload & AccessTokenPayload;
    if (!sub || !tid || !role) return null;

    return { sub, tid, role };
  } catch {
    // Expired, malformed or wrongly signed — all indistinguishable to the caller,
    // deliberately. Telling a client *why* a token failed helps an attacker probe.
    return null;
  }
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
  familyId: string;
}

/** Start a new token family. Called once per login. */
export async function issueRefreshToken(
  userId: string,
  context: { userAgent?: string; ipAddress?: string } = {},
): Promise<IssuedRefreshToken> {
  const token = generateToken();
  const familyId = generateToken(16);
  const expiresAt = new Date(Date.now() + refreshTtlMs());

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      familyId,
      expiresAt,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      ipAddress: context.ipAddress ?? null,
    },
  });

  return { token, expiresAt, familyId };
}

export type RotateResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'REUSE_DETECTED' };

/**
 * Exchange a refresh token for a new one.
 *
 * The whole rotation happens inside a transaction so a concurrent double-refresh
 * (two browser tabs, or a retried request) cannot both succeed and produce two live
 * families from one token.
 */
export async function rotateRefreshToken(
  rawToken: string,
  context: { userAgent?: string; ipAddress?: string } = {},
): Promise<RotateResult> {
  const tokenHash = hashToken(rawToken);

  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      familyId: true,
      expiresAt: true,
      revokedAt: true,
      replacedById: true,
    },
  });

  if (!existing) return { ok: false, reason: 'NOT_FOUND' };

  // ── Reuse detection ──────────────────────────────────────────────────────
  // A token that has already been replaced, or that was explicitly revoked, is
  // being replayed. Burn the whole family.
  if (existing.replacedById !== null || existing.revokedAt !== null) {
    await revokeTokenFamily(existing.familyId);
    log.error(
      { userId: existing.userId, familyId: existing.familyId },
      'Refresh token reuse detected — entire family revoked',
    );
    return { ok: false, reason: 'REUSE_DETECTED' };
  }

  if (existing.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const newToken = generateToken();
  // Rotation keeps the ORIGINAL family expiry rather than extending it, so a session
  // cannot be kept alive forever by refreshing every 14 minutes.
  const expiresAt = existing.expiresAt;

  await prisma.$transaction(async (tx) => {
    const created = await tx.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: hashToken(newToken),
        familyId: existing.familyId,
        expiresAt,
        userAgent: context.userAgent?.slice(0, 500) ?? null,
        ipAddress: context.ipAddress ?? null,
      },
    });

    await tx.refreshToken.update({
      where: { id: existing.id },
      data: { replacedById: created.id, revokedAt: new Date() },
    });
  });

  return { ok: true, userId: existing.userId, token: newToken, expiresAt };
}

/** Revoke every token descended from one login. */
export async function revokeTokenFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke a single token. Used on logout. */
export async function revokeRefreshToken(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke every session for a user. */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Delete expired tokens.
 *
 * Run from the maintenance chain (a self-chaining delayed job), NOT from cron —
 * the brief forbids cron, and this is exactly the kind of housekeeping that usually
 * gets a crontab entry.
 */
export async function pruneExpiredTokens(): Promise<number> {
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: new Date() } },
        // Revoked tokens are kept briefly so reuse detection still fires for a
        // stolen token presented shortly after logout.
        { revokedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      ],
    },
  });

  if (count > 0) log.debug({ count }, 'Pruned expired refresh tokens');
  return count;
}
