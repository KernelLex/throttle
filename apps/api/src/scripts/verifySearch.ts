/**
 * End-to-end verification of the Elasticsearch requirement.
 *
 * Proves the two things the brief actually asks for:
 *   1. SCHEDULED email is searchable (not only sent email)
 *   2. Search is tenant-isolated
 *
 *   npx tsx apps/api/src/scripts/verifySearch.ts
 *
 * Creates a small throwaway campaign, indexes it, runs real queries against the
 * cluster, then deletes what it created. Safe to run repeatedly.
 */

import '../loadEnv.js';
import { env } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { createCampaign } from '../services/campaignService.js';
import { ensureIndex, esClient, pingElasticsearch, searchEmails } from '../search/elasticsearch.js';
import { indexCampaign } from '../search/indexer.js';

const ok = (m: string) => console.log(`  PASS  ${m}`);
const bad = (m: string) => {
  console.log(`  FAIL  ${m}`);
  process.exitCode = 1;
};

async function main(): Promise<void> {
  console.log('\nVerifying Elasticsearch search\n');

  if (!(await pingElasticsearch())) {
    console.error('Elasticsearch unreachable at ' + env.ELASTICSEARCH_URL);
    process.exit(1);
  }
  await ensureIndex();

  const tenant = await prisma.tenant.findFirst({
    include: { users: { take: 1 }, senders: { where: { isActive: true }, take: 5 } },
  });
  if (!tenant || tenant.users.length === 0 || tenant.senders.length === 0) {
    console.error('Need a tenant with at least one user and one active sender. Sign in first.');
    process.exit(1);
  }

  const marker = `zzsearchprobe${Date.now()}`;
  const recipients = [
    `alice.${marker}@probe-alpha.test`,
    `bob.${marker}@probe-beta.test`,
    `carol.${marker}@probe-gamma.test`,
  ];

  console.log(`  workspace: ${tenant.name}  senders: ${tenant.senders.length}\n`);

  // ── Create ────────────────────────────────────────────────────────────────
  const { campaignId } = await createCampaign({
    tenantId: tenant.id,
    userId: tenant.users[0]!.id,
    name: `Search probe ${marker}`,
    subject: `Quarterly ${marker} briefing`,
    body: 'Probe body. Distinctive token: ' + marker,
    recipients,
    // Far enough out that nothing actually sends during the check.
    startAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    minGapMs: 2000,
    hourlyLimitPerSender: 50,
  });

  const created = await prisma.emailJob.count({ where: { campaignId } });
  created === recipients.length
    ? ok(`campaign created with ${created} SCHEDULED emails`)
    : bad(`expected ${recipients.length} rows, got ${created}`);

  // The API enqueues this on a queue; run it inline so the check does not depend
  // on a worker being up.
  await indexCampaign(campaignId);
  await esClient.indices.refresh({ index: env.ELASTICSEARCH_INDEX });

  // ── 1. Scheduled email is searchable ──────────────────────────────────────
  const bySubject = await searchEmails({
    tenantId: tenant.id, query: marker, page: 1, pageSize: 10,
  });
  bySubject.total === 3
    ? ok(`SCHEDULED email is searchable by subject (${bySubject.total} hits, ${bySubject.tookMs}ms)`)
    : bad(`expected 3 hits for subject token, got ${bySubject.total}`);

  // ── 2. The email analyser splits on @ and . ───────────────────────────────
  const byLocalPart = await searchEmails({
    tenantId: tenant.id, query: 'alice', page: 1, pageSize: 10,
  });
  byLocalPart.total >= 1
    ? ok(`recipient analyser matches a local-part fragment ("alice" -> ${byLocalPart.total})`)
    : bad('searching "alice" did not match alice.<marker>@probe-alpha.test');

  // ── 3. Status filter ──────────────────────────────────────────────────────
  const scheduledOnly = await searchEmails({
    tenantId: tenant.id, query: marker, status: 'SCHEDULED', page: 1, pageSize: 10,
  });
  scheduledOnly.total === 3
    ? ok('status filter works (SCHEDULED)')
    : bad(`status filter returned ${scheduledOnly.total}, expected 3`);

  const sentOnly = await searchEmails({
    tenantId: tenant.id, query: marker, status: 'SENT', page: 1, pageSize: 10,
  });
  sentOnly.total === 0
    ? ok('status filter excludes non-matching statuses (SENT -> 0)')
    : bad(`SENT filter returned ${sentOnly.total}, expected 0`);

  // ── 4. Tenant isolation ───────────────────────────────────────────────────
  const otherTenant = await searchEmails({
    tenantId: 'some-other-tenant-id', query: marker, page: 1, pageSize: 10,
  });
  otherTenant.total === 0
    ? ok('tenant isolation holds (another tenant sees 0)')
    : bad(`LEAK: another tenant saw ${otherTenant.total} documents`);

  // ── 5. Highlighting ───────────────────────────────────────────────────────
  const hasHighlight = bySubject.items.some((i) => Object.keys(i.highlights).length > 0);
  hasHighlight ? ok('highlight fragments returned') : bad('no highlight fragments');

  // ── Clean up ──────────────────────────────────────────────────────────────
  const ids = await prisma.emailJob.findMany({ where: { campaignId }, select: { id: true } });
  await prisma.campaign.delete({ where: { id: campaignId } });
  await Promise.allSettled(
    ids.map((r) => esClient.delete({ index: env.ELASTICSEARCH_INDEX, id: r.id })),
  );
  await esClient.indices.refresh({ index: env.ELASTICSEARCH_INDEX });
  console.log('\n  cleaned up probe campaign\n');
}

main()
  .catch((err) => {
    console.error('\nVerification failed:', err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
