/**
 * Slack integration — real OAuth v2 install flow plus live message delivery.
 *
 * THE FLOW
 * --------
 *   1. User clicks "Connect Slack" → GET /api/slack/install
 *   2. We redirect to Slack's authorize URL with a signed, single-use `state`
 *   3. User picks a channel and approves
 *   4. Slack redirects to /api/slack/callback with a `code`
 *   5. We exchange it for an incoming webhook URL + bot token, encrypt both, store
 *      them against the tenant
 *   6. Rate-limit hits now post to that channel
 *
 * DISCONNECT / RECONNECT — explicitly required by the brief
 * ---------------------------------------------------------
 *   - Never connected → `notify()` returns silently. It must NOT throw, because it is
 *     called from the worker's send path and an unconfigured integration must never
 *     break delivery.
 *   - Disconnected → the row is soft-deactivated, not deleted, so reconnecting keeps
 *     the audit trail and a disconnect is distinguishable from "never connected".
 *   - Reconnected → the next event notifies immediately. No redeploy, no restart:
 *     the installation is read from the database on every notification rather than
 *     cached in module state.
 *
 * WHY THE WEBHOOK URL IS ENCRYPTED
 * --------------------------------
 * Possession of an incoming webhook URL is sufficient to post into the customer's
 * channel. It is a credential, not an address, and is stored as one.
 */

import { randomBytes } from 'node:crypto';
import { OAUTH_STATE_TTL_SECONDS, oauthStateKey } from '@throttle/core';
import { env, slackRedirectUri } from '../config.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { badRequest, upstreamUnavailable } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';

const log = createLogger('slack');

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

/**
 * `incoming-webhook` prompts the channel picker and returns a webhook URL.
 * `chat:write` allows richer posts later without a re-install.
 */
const SLACK_SCOPES = ['incoming-webhook', 'chat:write'].join(',');

interface SlackOAuthState {
  tenantId: string;
  userId: string;
  createdAt: number;
}

/**
 * Build Slack's authorize URL.
 *
 * The `state` binds the callback to the user who started it. Without it, an attacker
 * could complete an install flow against a victim's session and attach THEIR Slack
 * workspace to the victim's tenant — quietly redirecting the victim's alerts.
 */
export async function buildSlackInstallUrl(tenantId: string, userId: string): Promise<string> {
  const state = randomBytes(24).toString('base64url');

  const payload: SlackOAuthState = { tenantId, userId, createdAt: Date.now() };
  await redis.set(oauthStateKey(`slack:${state}`), JSON.stringify(payload), 'EX', OAUTH_STATE_TTL_SECONDS);

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: SLACK_SCOPES,
    redirect_uri: slackRedirectUri,
    state,
  });

  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/** Atomically consume a Slack OAuth state. */
export async function consumeSlackState(state: string): Promise<SlackOAuthState> {
  const raw = await redis.getdel(oauthStateKey(`slack:${state}`));
  if (!raw) {
    throw badRequest('This Slack connection link has expired or was already used.');
  }
  return JSON.parse(raw) as SlackOAuthState;
}

interface SlackAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  team?: { id: string; name: string };
  incoming_webhook?: { url: string; channel: string; channel_id: string };
}

/** Exchange the code and persist the installation. */
export async function completeSlackInstall(
  code: string,
  state: SlackOAuthState,
): Promise<{ teamName: string; channelName: string }> {
  const response = await fetch(SLACK_ACCESS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      redirect_uri: slackRedirectUri,
    }),
  });

  const data = (await response.json()) as SlackAccessResponse;

  // Slack returns HTTP 200 with `ok: false` for application errors, so checking the
  // status code alone would treat a failed install as a success.
  if (!data.ok || !data.incoming_webhook?.url) {
    log.error({ error: data.error }, 'Slack OAuth exchange failed');
    throw upstreamUnavailable(
      'Could not connect to Slack. Please try again, and make sure you select a channel.',
    );
  }

  const teamName = data.team?.name ?? 'Slack workspace';
  const channelName = data.incoming_webhook.channel;

  await prisma.slackInstallation.upsert({
    where: { tenantId: state.tenantId },
    create: {
      tenantId: state.tenantId,
      slackTeamId: data.team?.id ?? 'unknown',
      slackTeamName: teamName,
      channelId: data.incoming_webhook.channel_id,
      channelName,
      webhookUrlEnc: encrypt(data.incoming_webhook.url),
      botTokenEnc: data.access_token ? encrypt(data.access_token) : null,
      installedByUserId: state.userId,
      isActive: true,
    },
    update: {
      slackTeamId: data.team?.id ?? 'unknown',
      slackTeamName: teamName,
      channelId: data.incoming_webhook.channel_id,
      channelName,
      webhookUrlEnc: encrypt(data.incoming_webhook.url),
      botTokenEnc: data.access_token ? encrypt(data.access_token) : null,
      installedByUserId: state.userId,
      // Reconnecting reactivates without losing history.
      isActive: true,
      disconnectedAt: null,
    },
  });

  log.info({ tenantId: state.tenantId, teamName, channelName }, 'Slack connected');
  return { teamName, channelName };
}

/** Soft-disconnect. Keeps the row so reconnect is distinguishable from first install. */
export async function disconnectSlack(tenantId: string): Promise<void> {
  await prisma.slackInstallation.updateMany({
    where: { tenantId, isActive: true },
    data: { isActive: false, disconnectedAt: new Date() },
  });
  log.info({ tenantId }, 'Slack disconnected');
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

/**
 * Post a message to the tenant's Slack channel.
 *
 * NEVER THROWS. This is called from the notifications worker, which is in turn
 * triggered by the send path. An unconfigured, disconnected or broken Slack
 * integration must degrade to a log line, never to a failed email.
 *
 * Returns whether a message was actually delivered, so the caller can report honestly.
 */
export async function notify(
  tenantId: string,
  text: string,
  blocks?: SlackBlock[],
): Promise<boolean> {
  try {
    // Read on every call rather than caching: this is what makes reconnect work with
    // no redeploy, as the brief requires.
    const installation = await prisma.slackInstallation.findUnique({
      where: { tenantId },
      select: { webhookUrlEnc: true, isActive: true },
    });

    if (!installation || !installation.isActive) {
      log.debug({ tenantId }, 'Slack not connected — skipping notification');
      return false;
    }

    const webhookUrl = decrypt(installation.webhookUrlEnc);

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      const detail = await response.text();

      // 410 Gone means the user removed the app or deleted the channel. Deactivate
      // so we stop trying, and so the dashboard shows the real state.
      if (response.status === 410 || detail.includes('no_service')) {
        await disconnectSlack(tenantId);
        log.warn({ tenantId }, 'Slack webhook revoked — marking disconnected');
        return false;
      }

      log.warn({ tenantId, status: response.status, detail }, 'Slack notification failed');
      return false;
    }

    return true;
  } catch (err) {
    log.warn({ tenantId, err }, 'Slack notification error — continuing regardless');
    return false;
  }
}

export async function getSlackStatus(tenantId: string): Promise<{
  connected: boolean;
  teamName: string | null;
  channelName: string | null;
  connectedAt: string | null;
}> {
  const installation = await prisma.slackInstallation.findUnique({
    where: { tenantId },
    select: { isActive: true, slackTeamName: true, channelName: true, updatedAt: true },
  });

  if (!installation || !installation.isActive) {
    return { connected: false, teamName: null, channelName: null, connectedAt: null };
  }

  return {
    connected: true,
    teamName: installation.slackTeamName,
    channelName: installation.channelName,
    connectedAt: installation.updatedAt.toISOString(),
  };
}

/**
 * Send a test message.
 *
 * Offered in the dashboard right after connecting so the user gets immediate proof
 * the integration works — rather than discovering it is broken hours later when a
 * real rate-limit alert silently fails to arrive.
 */
export async function sendTestMessage(tenantId: string): Promise<boolean> {
  return notify(tenantId, '✅ Throttle is connected. Rate-limit alerts will arrive here.', [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*✅ Throttle connected*\n' +
          "You'll get a message here the moment a sender hits its hourly limit, " +
          'and when a sender’s circuit breaker opens or recovers.',
      },
    },
  ]);
}
