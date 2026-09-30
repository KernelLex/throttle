/**
 * Force a rate-limit hit so the Slack alert can be verified live.
 *
 *   npx tsx apps/api/src/scripts/testSlackAlert.ts
 *
 * WHY THIS NEEDS A SCRIPT AT ALL
 * ------------------------------
 * `planSchedule()` spreads a campaign across hour windows so it stays under every
 * sender's budget. One campaign on its own therefore almost never trips the
 * limiter — which is the design working, not a gap.
 *
 * The limiter exists to catch DRIFT: reality diverging from the plan. The most
 * common real source of drift is two campaigns planned independently into the same
 * hour window, each unaware of the other's consumption. The first drains the
 * budget; the second finds it gone at send time and is deferred.
 *
 * That is exactly what this reproduces:
 *
 *   1. temporarily drop every sender to a tiny hourly limit
 *   2. campaign A fills that budget
 *   3. campaign B plans into the same window and hits HOURLY_LIMIT
 *   4. the worker defers B's jobs and fires ONE Slack alert per sender per window
 *   5. sender limits are restored
 *
 * Requires the API/worker to be running (`npm run dev`), because the send path is
 * what triggers the notification.
 */

import '../loadEnv.js';
import { hourWindowKey, rateLimitKey, slackDebounceKey } from '@throttle/core';
import { prisma } from '../lib/prisma.js';
import { closeRedis, redis } from '../lib/redis.js';
import { createCampaign } from '../services/campaignService.js';
import { getSlackStatus } from '../slack/service.js';

/** Small enough that the budget is exhausted within seconds. */
const TEST_LIMIT_PER_SENDER = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = () => console.log('─'.repeat(64));

async function main(): Promise<void> {
  console.log('\nRate-limit → Slack alert test\n');

  const tenant = await prisma.tenant.findFirst({
    include: { users: { take: 1 }, senders: { where: { isActive: true } } },
  });

  if (!tenant || tenant.users.length === 0) {
    console.error('No workspace found. Sign in at the dashboard first.\n');
    process.exit(1);
  }
  if (tenant.senders.length === 0) {
    console.error('No active senders. Sign in once — they are provisioned on first login.\n');
    process.exit(1);
  }

  // ── Slack must be connected, or there is nothing to verify ────────────────
  const slack = await getSlackStatus(tenant.id);
  if (!slack.connected) {
    console.error(
      'Slack is not connected for this workspace.\n\n' +
        '  1. open the dashboard and sign in\n' +
        '  2. click the funnel icon in the toolbar to open the side panel\n' +
        '  3. click "Connect Slack", pick a channel, approve\n' +
        '  4. a test message should arrive immediately\n' +
        '  5. re-run this script\n',
    );
    process.exit(1);
  }

  console.log(`  workspace : ${tenant.name}`);
  console.log(`  slack     : #${slack.channelName} in ${slack.teamName}`);
  console.log(`  senders   : ${tenant.senders.length}`);
  line();

  const originals = tenant.senders.map((s) => ({ id: s.id, hourlyLimit: s.hourlyLimit }));
  const capacity = TEST_LIMIT_PER_SENDER * tenant.senders.length;

  try {
    // ── 1. Shrink the budget ──────────────────────────────────────────────
    await prisma.sender.updateMany({
      where: { id: { in: originals.map((s) => s.id) } },
      data: { hourlyLimit: TEST_LIMIT_PER_SENDER },
    });
    console.log(`\n  limits dropped to ${TEST_LIMIT_PER_SENDER}/hour per sender (capacity ${capacity}/hr)`);

    // Clear this window's counters and the alert debounce, so the run starts from
    // a known state and the alert is not suppressed by an earlier test.
    const wk = hourWindowKey(Date.now());
    for (const s of originals) {
      await redis.del(rateLimitKey(tenant.id, s.id, wk), slackDebounceKey(tenant.id, s.id, wk));
    }
    console.log('  counters and alert debounce cleared for this hour window');

    const startAt = new Date(Date.now() + 3_000);
    const stamp = Date.now();

    // ── 2. Campaign A fills the budget ────────────────────────────────────
    const a = await createCampaign({
      tenantId: tenant.id,
      userId: tenant.users[0]!.id,
      name: `Slack test A ${stamp}`,
      subject: 'Rate limit test — campaign A',
      body: 'Filling the hourly budget.',
      recipients: Array.from({ length: capacity }, (_, i) => `a${i}.${stamp}@probe.test`),
      startAt,
      minGapMs: 0,
      hourlyLimitPerSender: TEST_LIMIT_PER_SENDER,
    });
    console.log(`\n  campaign A: ${capacity} emails — will consume the whole window`);

    // ── 3. Campaign B plans into the same window ──────────────────────────
    const b = await createCampaign({
      tenantId: tenant.id,
      userId: tenant.users[0]!.id,
      name: `Slack test B ${stamp}`,
      subject: 'Rate limit test — campaign B',
      body: 'Should be deferred into the next window.',
      recipients: Array.from({ length: capacity }, (_, i) => `b${i}.${stamp}@probe.test`),
      startAt,
      minGapMs: 0,
      hourlyLimitPerSender: TEST_LIMIT_PER_SENDER,
    });
    console.log(`  campaign B: ${capacity} emails — plans into the SAME window, unaware of A`);
    line();

    // ── 4. Watch ──────────────────────────────────────────────────────────
    console.log('\n  waiting for the worker (up to 90s)…\n');
    const ids = [a.campaignId, b.campaignId];
    let deferred = 0;

    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const rows = await prisma.emailJob.groupBy({
        by: ['status'],
        where: { campaignId: { in: ids } },
        _count: { _all: true },
      });
      const by = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
      deferred = by['RESCHEDULED'] ?? 0;
      const sent = by['SENT'] ?? 0;

      process.stdout.write(
        `\r  sent ${String(sent).padStart(2)}   deferred ${String(deferred).padStart(2)}   ` +
          `pending ${String((by['SCHEDULED'] ?? 0) + (by['QUEUED'] ?? 0)).padStart(2)}   `,
      );

      if (deferred > 0 && sent >= capacity) break;
    }
    console.log('\n');
    line();

    if (deferred > 0) {
      console.log('\n  ✓ rate limit hit — jobs deferred, not dropped');
      console.log('  ✓ a Slack message should now be in #' + slack.channelName);
      console.log('\n  It reads: "Rate limit reached — <sender> has hit its hourly limit",');
      console.log('  with the number of emails waiting and when they resume.');
      console.log('\n  Exactly ONE message per sender per hour window, however many');
      console.log('  jobs were blocked. That is the SETNX debounce doing its job.\n');
    } else {
      console.log('\n  No deferral observed. Usual causes:');
      console.log('    · the worker is not running  → npm run dev');
      console.log('    · sends are still in flight  → re-run to check again\n');
    }
  } finally {
    // ── 5. Always restore ─────────────────────────────────────────────────
    for (const s of originals) {
      await prisma.sender.update({ where: { id: s.id }, data: { hourlyLimit: s.hourlyLimit } });
    }
    console.log(`  sender limits restored to ${originals[0]?.hourlyLimit}/hour\n`);
  }
}

main()
  .catch((err) => {
    console.error('\nTest failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    // lib/redis.ts opens THREE connections (general, BullMQ, subscriber).
    // Disconnecting only one leaves the other two holding the event loop open, so
    // the script prints its result and then hangs forever. closeRedis() quits all
    // three; the explicit exit covers anything else still registered.
    await prisma.$disconnect();
    await closeRedis();
    process.exit(process.exitCode ?? 0);
  });
