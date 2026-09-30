/**
 * Print a ready-to-click Slack install link.
 *
 *   npx tsx apps/api/src/scripts/slackInstallLink.ts [email]
 *
 * The dashboard's "Connect Slack" button is the normal route. This exists for
 * diagnosis: it writes the same single-use OAuth state the endpoint would, then
 * prints the authorize URL directly. If the dashboard button fails but this link
 * works, the problem is in the app's auth or the browser, not in the Slack config.
 *
 * The state is written to the SAME Redis the deployed API reads, so approving this
 * link completes the install against the live deployment.
 */

import '../loadEnv.js';
import { randomBytes } from 'node:crypto';
import { OAUTH_STATE_TTL_SECONDS, oauthStateKey } from '@throttle/core';
import { env, slackOAuthEnabled, slackRedirectUri } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

async function main(): Promise<void> {
  if (!slackOAuthEnabled) {
    console.error('\nSLACK_CLIENT_ID / SLACK_CLIENT_SECRET are not set.\n');
    process.exit(1);
  }

  const wanted = process.argv[2];
  const user = wanted
    ? await prisma.user.findUnique({ where: { email: wanted.toLowerCase() }, include: { tenant: true } })
    : await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, include: { tenant: true } });

  if (!user) {
    console.error(`\nNo user${wanted ? ` with address ${wanted}` : ''}. Sign in first.\n`);
    process.exit(1);
  }

  const state = randomBytes(24).toString('base64url');
  await redis.set(
    oauthStateKey(`slack:${state}`),
    JSON.stringify({ tenantId: user.tenantId, userId: user.id, createdAt: Date.now() }),
    'EX',
    OAUTH_STATE_TTL_SECONDS,
  );

  const url =
    'https://slack.com/oauth/v2/authorize?' +
    new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      scope: 'incoming-webhook,chat:write',
      redirect_uri: slackRedirectUri,
      state,
    }).toString();

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log(`  workspace    ${user.tenant.name}`);
  console.log(`  user         ${user.email}`);
  console.log(`  redirect_uri ${slackRedirectUri}`);
  console.log(`  valid for    ${OAUTH_STATE_TTL_SECONDS / 60} minutes, single use`);
  console.log('─────────────────────────────────────────────────────────────\n');
  console.log('Open this, pick a channel, and approve:\n');
  console.log(url);
  console.log('');
}

main()
  .catch((err) => {
    console.error('\nFailed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });
