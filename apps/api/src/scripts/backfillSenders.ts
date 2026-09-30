/**
 * One-off maintenance: give every workspace working senders.
 *
 * Fixes the state left by the original seed script, which created senders inside a
 * "Demo Workspace" that no user ever joins — so real users landed on a dashboard with
 * zero senders and could not schedule anything.
 *
 *   npx tsx apps/api/src/scripts/backfillSenders.ts
 *
 * Safe to re-run: workspaces that already have senders are skipped.
 */

import '../loadEnv.js';
import { prisma } from '../lib/prisma.js';
import { ensureTenantHasSenders } from '../services/senderProvisioning.js';

async function main(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    include: { _count: { select: { users: true, senders: true } } },
  });

  for (const tenant of tenants) {
    // A workspace with no users is the orphaned seed tenant. Its senders are
    // unreachable by anyone, so it is removed rather than left to confuse.
    if (tenant._count.users === 0) {
      await prisma.tenant.delete({ where: { id: tenant.id } });
      console.log(
        `removed orphaned workspace "${tenant.name}" (${tenant._count.senders} unreachable senders)`,
      );
      continue;
    }

    if (tenant._count.senders === 0) {
      const created = await ensureTenantHasSenders(tenant.id);
      console.log(`provisioned ${created} sender(s) for "${tenant.name}"`);
    } else {
      console.log(`"${tenant.name}" already has ${tenant._count.senders} sender(s) — skipped`);
    }
  }

  const after = await prisma.tenant.findMany({
    include: {
      users: { select: { email: true, role: true } },
      senders: { select: { label: true, fromEmail: true, hourlyLimit: true } },
    },
  });

  console.log('\n── final state ──');
  for (const tenant of after) {
    console.log(`  "${tenant.name}"`);
    for (const user of tenant.users) console.log(`     user:   ${user.email} (${user.role})`);
    for (const sender of tenant.senders) {
      console.log(`     sender: ${sender.label}  ${sender.fromEmail}  ${sender.hourlyLimit}/hr`);
    }
    const capacity = tenant.senders.reduce((sum, s) => sum + s.hourlyLimit, 0);
    console.log(`     capacity: ${capacity}/hr`);
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
