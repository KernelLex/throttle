/**
 * Slack connection card.
 *
 * Covers the three states the brief calls out explicitly:
 *   - never connected  → offer Connect; rate-limit hits simply do not notify
 *   - connected        → show the workspace/channel, offer Test and Disconnect
 *   - disconnected     → offer Reconnect; notifications resume with no redeploy,
 *                        because the worker reads the installation from the database
 *                        on every notification rather than caching it at boot
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/utils';
import { useServerConfig } from '../../hooks/useAuth';
import { Button, Card, CardHeader, Skeleton, useToast } from '../../components/ui';

export function SlackConnectCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: config } = useServerConfig();

  const status = useQuery({
    queryKey: ['slack', 'status'],
    queryFn: () => api.slack.status(),
  });

  const test = useMutation({
    mutationFn: () => api.slack.test(),
    onSuccess: (result) =>
      toast(
        result.delivered ? 'success' : 'error',
        result.delivered
          ? 'Test message sent — check your Slack channel.'
          : 'Could not deliver to Slack. The webhook may have been revoked.',
      ),
    onError: (error: Error) => toast('error', error.message),
  });

  const disconnect = useMutation({
    mutationFn: () => api.slack.disconnect(),
    onSuccess: () => {
      toast('info', 'Slack disconnected. Rate-limit alerts are paused.');
      void queryClient.invalidateQueries({ queryKey: ['slack'] });
      void queryClient.invalidateQueries({ queryKey: ['session'] });
    },
    onError: (error: Error) => toast('error', error.message),
  });

  const slackConfigured = config?.slackOAuthEnabled ?? false;

  return (
    <Card>
      <CardHeader
        title="Slack alerts"
        description="Get notified the moment a sender hits its hourly limit."
      />

      <div className="p-5">
        {status.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : !slackConfigured ? (
          <div className="rounded-md bg-surface-2 px-3 py-2.5">
            <p className="text-xs text-ink-muted">
              Slack is not configured on this server. Set{' '}
              <code className="font-mono text-ink-secondary">SLACK_CLIENT_ID</code> and{' '}
              <code className="font-mono text-ink-secondary">SLACK_CLIENT_SECRET</code>, then
              restart the API.
            </p>
          </div>
        ) : status.data?.connected ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 text-good" aria-hidden="true">
                ●
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  Connected to {status.data.teamName}
                </p>
                <p className="truncate text-xs text-ink-muted">
                  Posting to #{status.data.channelName}
                  {status.data.connectedAt
                    ? ` · connected ${formatRelative(status.data.connectedAt)}`
                    : ''}
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => test.mutate()}
                loading={test.isPending}
              >
                Send test
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => disconnect.mutate()}
                loading={disconnect.isPending}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Not connected. Rate-limit alerts are not being sent.
            </p>
            {/* Full-page navigation — OAuth needs a top-level redirect. */}
            <a
              href={api.slack.installUrl()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-surface-2 px-3 text-sm font-medium text-ink ring-1 ring-inset ring-line-strong transition-colors hover:bg-surface-3"
            >
              <svg className="size-4" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#E01E5A" d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.53h2.52v2.53zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.3a2.53 2.53 0 0 1-5.05 0v-6.3z" />
                <path fill="#36C5F0" d="M8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52H8.83zm0 1.27a2.53 2.53 0 0 1 0 5.05h-6.3a2.53 2.53 0 0 1 0-5.05h6.3z" />
                <path fill="#2EB67D" d="M18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52V8.83zm-1.27 0a2.53 2.53 0 0 1-5.05 0v-6.3a2.53 2.53 0 0 1 5.05 0v6.3z" />
                <path fill="#ECB22E" d="M15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52h2.53zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.3a2.53 2.53 0 0 1 0 5.05h-6.3z" />
              </svg>
              Connect Slack
            </a>
          </div>
        )}
      </div>
    </Card>
  );
}
