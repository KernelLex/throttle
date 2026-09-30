/**
 * Add a real Gmail sender to a workspace.
 *
 *   npx tsx apps/api/src/scripts/addGmailSender.ts <email> <app-password> [label]
 *
 * The dashboard has a form for this (Sender health → Add sender) and that is the
 * normal route. This script exists for the first sender, when the point is to get
 * real delivery working before anything else, and for scripted setup.
 *
 * Same guarantees as the endpoint: credentials are verified over a real SMTP
 * connection before anything is written, and the password is AES-256-GCM encrypted
 * at rest.
 *
 * NOTE: Gmail requires an APP PASSWORD, not the account password. 2-Step
 * Verification must be on, then generate one at myaccount.google.com/apppasswords.
 * The spaces Google displays are presentational and are stripped here.
 */

import '../loadEnv.js';
import { env } from '../config.js';
import { encrypt } from '../lib/crypto.js';
import { prisma } from '../lib/prisma.js';
import { invalidateTransport, verifyTransport } from '../mailer/transport.js';

async function main(): Promise<void> {
  const [email, rawPassword, label] = process.argv.slice(2);

  if (!email || !rawPassword) {
    console.error(
      '\nUsage: npx tsx apps/api/src/scripts/addGmailSender.ts <email> <app-password> [label]\n',
    );
    process.exit(1);
  }

  const password = rawPassword.replace(/\s+/g, '');
  const address = email.trim().toLowerCase();

  // The sender joins the workspace that owns this address, so the account that can
  // send the mail is the account that sees it in its dashboard.
  const user = await prisma.user.findUnique({
    where: { email: address },
    include: { tenant: true },
  });

  if (!user) {
    console.error(`\nNo user with address ${address}. Sign in with that account first.\n`);
    process.exit(1);
  }

  const existing = await prisma.sender.findFirst({
    where: { tenantId: user.tenantId, fromEmail: address },
  });
  if (existing) {
    console.log(`\n${address} is already a sender in "${user.tenant.name}". Nothing to do.\n`);
    return;
  }

  const encrypted = encrypt(password);

  // Verify BEFORE writing, exactly as the endpoint does — a bad password should
  // fail here, not silently three hours into a campaign.
  console.log(`\nVerifying ${address} against smtp.gmail.com…`);
  const probe = {
    id: 'verify-probe',
    label: label ?? 'Gmail',
    fromName: user.name,
    fromEmail: address,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpUser: address,
    smtpPasswordEnc: encrypted,
    smtpSecure: false,
  };

  const result = await verifyTransport(probe);
  invalidateTransport('verify-probe');

  if (!result.ok) {
    console.error(
      `\nSMTP verification failed: ${result.error}\n\n` +
        '  Gmail needs an APP PASSWORD, not the account password.\n' +
        '  2-Step Verification must be enabled, then generate one at:\n' +
        '    https://myaccount.google.com/apppasswords\n',
    );
    process.exit(1);
  }

  const sender = await prisma.sender.create({
    data: {
      tenantId: user.tenantId,
      label: label ?? 'Gmail',
      fromName: user.name,
      fromEmail: address,
      smtpHost: 'smtp.gmail.com',
      smtpPort: 587,
      smtpUser: address,
      smtpPasswordEnc: encrypted,
      smtpSecure: false,
      // Gmail allows 500/day. 50/hour leaves headroom and keeps the rate limiter
      // meaningful rather than theoretical.
      hourlyLimit: 50,
      minGapMs: env.MIN_DELAY_BETWEEN_EMAILS_MS,
    },
  });

  const all = await prisma.sender.findMany({
    where: { tenantId: user.tenantId, isActive: true },
    select: { label: true, fromEmail: true, hourlyLimit: true },
  });

  console.log(`\nAdded "${sender.label}" to "${user.tenant.name}"\n`);
  console.log('  senders now active:');
  for (const s of all) {
    const real = !s.fromEmail.endsWith('@ethereal.email');
    console.log(
      `    ${s.label.padEnd(16)} ${s.fromEmail.padEnd(34)} ${String(s.hourlyLimit).padStart(3)}/hr` +
        (real ? '   <- delivers for real' : ''),
    );
  }
  console.log(
    `\n  total capacity: ${all.reduce((sum, s) => sum + s.hourlyLimit, 0)}/hour\n`,
  );
}

main()
  .catch((err) => {
    console.error('\nFailed:', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
