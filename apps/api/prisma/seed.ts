/**
 * Database seed.
 *
 * Creates a demo tenant and auto-provisions Ethereal SMTP accounts, so a first run
 * needs no manual mailbox setup at all — `npm run db:seed` and you have three working
 * senders.
 *
 * Ethereal accepts mail and renders it at a preview URL but never delivers it, which
 * is what makes it safe to fire a thousand test emails at.
 *
 * IDEMPOTENT: safe to re-run. Existing senders are left alone rather than duplicated,
 * because re-seeding is something people do while debugging and silently doubling the
 * sender pool would also silently double the effective sending rate.
 */

// MUST be first: crypto.ts imports config.ts, which validates the environment at
// import time and exits on failure.
import '../src/loadEnv.js';

import { PrismaClient } from '@prisma/client';
import { createEtherealAccount } from '../src/mailer/transport.js';
import { encrypt } from '../src/lib/crypto.js';

const prisma = new PrismaClient();

const SENDER_COUNT = Number.parseInt(process.env['SMTP_AUTO_PROVISION_COUNT'] ?? '3', 10);
const HOURLY_LIMIT = Number.parseInt(process.env['MAX_EMAILS_PER_HOUR_PER_SENDER'] ?? '200', 10);
const MIN_GAP_MS = Number.parseInt(process.env['MIN_DELAY_BETWEEN_EMAILS_MS'] ?? '2000', 10);

const SENDER_LABELS = [
  { label: 'Outreach One', fromName: 'Alex from Throttle' },
  { label: 'Outreach Two', fromName: 'Jordan from Throttle' },
  { label: 'Outreach Three', fromName: 'Sam from Throttle' },
  { label: 'Outreach Four', fromName: 'Riley from Throttle' },
  { label: 'Outreach Five', fromName: 'Casey from Throttle' },
];

async function main(): Promise<void> {
  console.log('\n🌱 Seeding Throttle…\n');

  // ── Tenant ────────────────────────────────────────────────────────────────
  let tenant = await prisma.tenant.findFirst({ where: { name: 'Demo Workspace' } });

  if (!tenant) {
    tenant = await prisma.tenant.create({ data: { name: 'Demo Workspace' } });
    console.log(`✓ Created tenant "Demo Workspace" (${tenant.id})`);
  } else {
    console.log(`· Tenant "Demo Workspace" already exists (${tenant.id})`);
  }

  // ── Senders ───────────────────────────────────────────────────────────────
  const existingCount = await prisma.sender.count({ where: { tenantId: tenant.id } });

  if (existingCount >= SENDER_COUNT) {
    console.log(`· ${existingCount} sender(s) already configured — skipping provisioning`);
  } else {
    const toCreate = SENDER_COUNT - existingCount;
    console.log(`\n📮 Provisioning ${toCreate} Ethereal mailbox(es)…`);
    console.log('   (this calls the Ethereal API and needs internet access)\n');

    for (let i = 0; i < toCreate; i++) {
      const meta = SENDER_LABELS[(existingCount + i) % SENDER_LABELS.length]!;

      try {
        const account = await createEtherealAccount();

        const sender = await prisma.sender.create({
          data: {
            tenantId: tenant.id,
            label: meta.label,
            fromName: meta.fromName,
            fromEmail: account.smtpUser,
            smtpHost: account.smtpHost,
            smtpPort: account.smtpPort,
            smtpUser: account.smtpUser,
            // Encrypted at rest with AES-256-GCM — never stored in plaintext, even
            // for a throwaway test mailbox, because the code path must be the real one.
            smtpPasswordEnc: encrypt(account.smtpPassword),
            smtpSecure: account.smtpSecure,
            hourlyLimit: HOURLY_LIMIT,
            minGapMs: MIN_GAP_MS,
          },
        });

        console.log(`  ✓ ${sender.label}  ${sender.fromEmail}`);
        console.log(`     inbox: https://ethereal.email/login`);
        console.log(`     user:  ${account.smtpUser}`);
        console.log(`     pass:  ${account.smtpPassword}\n`);
      } catch (err) {
        console.error(
          `  ✗ Could not provision sender ${i + 1}:`,
          err instanceof Error ? err.message : err,
        );
        console.error('    Check your internet connection, or add senders manually in the UI.\n');
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const senders = await prisma.sender.findMany({
    where: { tenantId: tenant.id },
    select: { label: true, fromEmail: true, hourlyLimit: true, minGapMs: true },
  });

  const totalCapacity = senders.reduce((sum, s) => sum + s.hourlyLimit, 0);

  console.log('─'.repeat(64));
  console.log(`  Tenant:            Demo Workspace`);
  console.log(`  Senders:           ${senders.length}`);
  console.log(`  Per-sender limit:  ${HOURLY_LIMIT}/hour`);
  console.log(`  Min gap:           ${MIN_GAP_MS}ms between sends`);
  console.log(`  Total capacity:    ${totalCapacity}/hour`);
  console.log('─'.repeat(64));
  console.log('\n  Sign in with Google to create your user — the first user in a');
  console.log('  workspace becomes its ADMIN.\n');
  console.log('  Note: Google sign-in creates a tenant from your email domain. To');
  console.log('  use these senders, either sign in with an address on a custom');
  console.log('  domain and move them, or add senders through the UI after login.\n');
}

main()
  .catch((err) => {
    console.error('\n✗ Seed failed:', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
