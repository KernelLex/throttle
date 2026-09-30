/**
 * Automatic sender provisioning.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Tenants are created on first login, keyed by email domain. The seed script, by
 * contrast, creates senders in a "Demo Workspace" that nobody ever joins. So the very
 * first thing a new user saw was a dashboard with zero senders — unable to schedule
 * anything, with no obvious way forward. For a reviewer opening the deployed app that
 * reads as "broken", not as "needs configuration".
 *
 * Every workspace now gets working Ethereal mailboxes the moment it is created, so
 * anyone who signs in can compose and schedule immediately.
 *
 * WHY ETHEREAL IS SAFE TO AUTO-PROVISION
 * --------------------------------------
 * Ethereal accepts mail and renders it at a preview URL but never delivers it. Handing
 * a brand-new account three working senders therefore cannot send real email to real
 * people. A production system would require the user to connect their own SMTP.
 */

import { createEtherealAccount } from '../mailer/transport.js';
import { encrypt } from '../lib/crypto.js';
import { env } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

const log = createLogger('sender-provisioning');

const SENDER_PRESETS = [
  { label: 'Outreach One', fromName: 'Alex from Throttle' },
  { label: 'Outreach Two', fromName: 'Jordan from Throttle' },
  { label: 'Outreach Three', fromName: 'Sam from Throttle' },
  { label: 'Outreach Four', fromName: 'Riley from Throttle' },
  { label: 'Outreach Five', fromName: 'Casey from Throttle' },
];

/**
 * Give a tenant working senders if it has none.
 *
 * NO-OP when the tenant already has at least one sender, so this is safe to call on
 * every login — it only ever fires once per workspace.
 *
 * NEVER THROWS. It is called from the OAuth callback, and a failure to reach Ethereal
 * must not prevent someone signing in. The dashboard's empty state covers the
 * degraded case.
 */
export async function ensureTenantHasSenders(
  tenantId: string,
  count: number = env.SMTP_AUTO_PROVISION_COUNT,
): Promise<number> {
  if (count <= 0) return 0;

  try {
    const existing = await prisma.sender.count({ where: { tenantId } });
    if (existing > 0) return 0;

    log.info({ tenantId, count }, 'New workspace has no senders — provisioning Ethereal mailboxes');

    // In parallel: three sequential HTTP round-trips would add noticeable latency to
    // the login redirect, and they are independent of one another.
    const results = await Promise.allSettled(
      Array.from({ length: count }, () => createEtherealAccount()),
    );

    const accounts = results
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createEtherealAccount>>> =>
        r.status === 'fulfilled',
      )
      .map((r) => r.value);

    if (accounts.length === 0) {
      log.warn({ tenantId }, 'Could not provision any Ethereal accounts');
      return 0;
    }

    await prisma.sender.createMany({
      data: accounts.map((account, index) => {
        const preset = SENDER_PRESETS[index % SENDER_PRESETS.length]!;
        return {
          tenantId,
          label: preset.label,
          fromName: preset.fromName,
          fromEmail: account.smtpUser,
          smtpHost: account.smtpHost,
          smtpPort: account.smtpPort,
          smtpUser: account.smtpUser,
          // Encrypted at rest even for a throwaway mailbox — the code path must be
          // the real one, not a special case that bypasses encryption.
          smtpPasswordEnc: encrypt(account.smtpPassword),
          smtpSecure: account.smtpSecure,
          hourlyLimit: env.MAX_EMAILS_PER_HOUR_PER_SENDER,
          minGapMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
        };
      }),
      // Ethereal has, very rarely, returned a duplicate address. Skipping beats
      // failing the whole batch — and the login it is attached to.
      skipDuplicates: true,
    });

    log.info(
      { tenantId, provisioned: accounts.length, requested: count },
      'Provisioned senders for new workspace',
    );

    return accounts.length;
  } catch (err) {
    // Deliberately swallowed. This runs inside the OAuth callback; a provisioning
    // failure must degrade to "no senders yet", never to "cannot sign in".
    log.error({ err, tenantId }, 'Sender provisioning failed — continuing with login');
    return 0;
  }
}
