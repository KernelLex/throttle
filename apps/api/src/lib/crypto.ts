/**
 * Encryption at rest and token hashing.
 *
 * WHAT GETS ENCRYPTED, AND WHY
 * ----------------------------
 *   - SMTP passwords   → a leak lets an attacker send mail AS the customer
 *   - Slack webhook URL → possession of the URL alone lets anyone post to the channel
 *   - Slack bot token   → full API access to the workspace within granted scopes
 *
 * These are encrypted (reversible) because we must present them to SMTP/Slack.
 *
 * WHAT GETS HASHED INSTEAD
 * ------------------------
 *   - Refresh tokens → we only ever need to *compare*, never to recover
 *
 * The distinction matters: hashing is strictly safer, so anything we do not need to
 * read back is hashed rather than encrypted.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — the GCM-recommended nonce size
const AUTH_TAG_LENGTH = 16;

/** Validated as exactly 64 hex chars by config.ts, so this cannot be the wrong size. */
const key = Buffer.from(env.ENCRYPTION_KEY, 'hex');

/**
 * Encrypt a secret for storage.
 *
 * Output format: `v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>`
 *
 * The `v1` prefix is deliberate. It costs nothing now and makes key rotation or an
 * algorithm change possible later without a guessing game about which rows use which
 * scheme — `decrypt()` can dispatch on the version.
 *
 * GCM (not CBC) because it is authenticated: tampering with stored ciphertext causes
 * decryption to throw rather than silently yielding garbage that then gets used as an
 * SMTP password.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `v1:${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');

  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Malformed ciphertext: expected v1:iv:authTag:ciphertext');
  }

  const iv = Buffer.from(parts[1]!, 'hex');
  const authTag = Buffer.from(parts[2]!, 'hex');
  const ciphertext = Buffer.from(parts[3]!, 'hex');

  if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Malformed ciphertext: bad IV or auth tag length');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // Throws if the ciphertext was tampered with or the key is wrong — which is the
  // desired behaviour. A wrong ENCRYPTION_KEY must be loud, not silent.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Decrypt without throwing, for display paths where a failure should degrade rather
 *  than 500. Returns null on any failure. */
export function tryDecrypt(payload: string): string | null {
  try {
    return decrypt(payload);
  } catch {
    return null;
  }
}

// ── Token generation and hashing ──────────────────────────────────────────────

/** 256 bits of entropy, URL-safe. Used for refresh tokens and OAuth `state`. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash a refresh token for storage.
 *
 * Plain SHA-256 rather than bcrypt/argon2 is correct HERE, and only here: the input
 * is already 256 bits of cryptographic randomness, so there is no low-entropy
 * password to brute-force and no benefit to a slow KDF. Using bcrypt would add
 * meaningful latency to every token refresh for zero security gain.
 *
 * (User passwords would be different — but we have none: auth is Google OAuth only.)
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison, for anything an attacker could probe with timing. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so compare lengths first — the length
  // itself is not the secret.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Stable, non-reversible id for correlating a value in logs without logging it. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
