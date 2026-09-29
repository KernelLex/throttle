import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { API_URL, api } from '../lib/api';
import { formatNumber, formatRelative } from '../lib/utils';
import { useLogout, useSession } from '../hooks/useAuth';
import { Button, Card, Input, Skeleton, useToast } from '../components/ui';
import { ComposeModal } from '../features/compose/ComposeModal';
import { EmailTable, type EmailBucket } from '../features/emails/EmailTable';
import { SenderHealthPanel } from '../features/senders/SenderHealthPanel';
import { SlackConnectCard } from '../features/slack/SlackConnectCard';

/** Messages the Slack OAuth callback redirects back with. */
const SLACK_MESSAGES: Record<string, { tone: 'success' | 'error' | 'info'; text: string }> = {
  connected: { tone: 'success', text: 'Slack connected — check your channel for a test message.' },
  cancelled: { tone: 'info', text: 'Slack connection was cancelled.' },
  failed: { tone: 'error', text: 'Could not connect to Slack. Please try again.' },
  invalid: { tone: 'error', text: 'Slack returned an unexpected response.' },
};

export function DashboardPage() {
  const { user } = useSession();
  const logout = useLogout();
  const { toast } = useToast();

  const [tab, setTab] = useState<EmailBucket>('scheduled');
  const [composeOpen, setComposeOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();

  // Surface the Slack callback result once, then strip the param so a refresh does
  // not replay the toast.
  const slackResult = searchParams.get('slack');
  useEffect(() => {
    if (!slackResult) return;
    const message = SLACK_MESSAGES[slackResult];
    if (message) toast(message.tone, message.text);
    searchParams.delete('slack');
    setSearchParams(searchParams, { replace: true });
  }, [slackResult, toast, searchParams, setSearchParams]);

  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.stats.get(),
    refetchInterval: 10_000,
  });

  return (
    <div className="min-h-screen">
      {/* ═══ Header ═══════════════════════════════════════════════════════ */}
      <header className="sticky top-0 z-40 border-b border-line bg-plane/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-brand">
              <svg className="size-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M13 2L4.5 12.5h6L11 22l8.5-10.5h-6L13 2z" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink">Throttle</p>
              {user ? (
                <p className="text-xs text-ink-muted">{user.tenantName}</p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Bull Board — admins only, matching the server-side guard. */}
            {user?.role === 'ADMIN' ? (
              <a
                href={`${API_URL}/admin/queues`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden text-sm text-ink-muted transition-colors hover:text-ink sm:block"
              >
                Queues ↗
              </a>
            ) : null}

            {user ? (
              <div className="flex items-center gap-3">
                <div className="hidden text-right sm:block">
                  <p className="text-sm font-medium text-ink">{user.name}</p>
                  <p className="text-xs text-ink-muted">{user.email}</p>
                </div>

                {user.avatarUrl ? (
                  <img
                    src={user.avatarUrl}
                    alt=""
                    // referrerPolicy is required or Google's CDN returns 403 for
                    // avatars requested from a different origin.
                    referrerPolicy="no-referrer"
                    className="size-8 rounded-full ring-1 ring-line-strong"
                  />
                ) : (
                  <div className="flex size-8 items-center justify-center rounded-full bg-surface-3 text-sm font-medium text-ink-secondary">
                    {user.name.charAt(0).toUpperCase()}
                  </div>
                )}

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => logout.mutate()}
                  loading={logout.isPending}
                >
                  Log out
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        {/* ═══ Stat tiles ═════════════════════════════════════════════════ */}
        <section aria-label="Overview" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <StatTile
            label="Scheduled"
            value={stats.data?.scheduledCount}
            loading={stats.isLoading}
            hint={
              stats.data?.nextSendAt
                ? `next ${formatRelative(stats.data.nextSendAt)}`
                : 'nothing queued'
            }
          />
          <StatTile
            label="Sent"
            value={stats.data?.sentCount}
            loading={stats.isLoading}
            hint={`${formatNumber(stats.data?.sentLastHour ?? 0)} this hour`}
          />
          <StatTile
            label="Failed"
            value={stats.data?.failedCount}
            loading={stats.isLoading}
            tone={stats.data && stats.data.failedCount > 0 ? 'critical' : 'neutral'}
          />
          <StatTile
            label="Senders"
            value={stats.data?.activeSenders}
            loading={stats.isLoading}
            hint={
              stats.data && stats.data.openCircuits > 0
                ? `${stats.data.openCircuits} paused`
                : 'all healthy'
            }
            tone={stats.data && stats.data.openCircuits > 0 ? 'warning' : 'neutral'}
          />
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {/* ═══ Emails ══════════════════════════════════════════════════ */}
          <div className="lg:col-span-2">
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
                {/* Tabs */}
                <div
                  role="tablist"
                  aria-label="Email views"
                  className="flex gap-1 rounded-lg bg-surface-2 p-1"
                >
                  {(['scheduled', 'sent'] as const).map((value) => (
                    <button
                      key={value}
                      role="tab"
                      aria-selected={tab === value}
                      onClick={() => setTab(value)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                        tab === value
                          ? 'bg-surface-3 text-ink'
                          : 'text-ink-muted hover:text-ink-secondary'
                      }`}
                    >
                      {value === 'scheduled' ? 'Scheduled' : 'Sent'}
                    </button>
                  ))}
                </div>

                <div className="flex flex-1 items-center justify-end gap-2">
                  <div className="w-full max-w-56">
                    <Input
                      type="search"
                      placeholder="Search emails…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label="Search emails"
                      className="h-9"
                    />
                  </div>
                  <Button size="sm" onClick={() => setComposeOpen(true)}>
                    Compose
                  </Button>
                </div>
              </div>

              <div role="tabpanel">
                <EmailTable
                  bucket={tab}
                  search={search}
                  onCompose={() => setComposeOpen(true)}
                />
              </div>
            </Card>
          </div>

          {/* ═══ Side rail ═══════════════════════════════════════════════ */}
          <div className="space-y-6">
            <SenderHealthPanel />
            <SlackConnectCard />
          </div>
        </div>
      </main>

      <ComposeModal open={composeOpen} onClose={() => setComposeOpen(false)} />
    </div>
  );
}

function StatTile({
  label,
  value,
  hint,
  loading,
  tone = 'neutral',
}: {
  label: string;
  value: number | undefined;
  hint?: string;
  loading?: boolean;
  tone?: 'neutral' | 'warning' | 'critical';
}) {
  const tones = {
    neutral: 'text-ink',
    warning: 'text-warning',
    critical: 'text-critical',
  } as const;

  return (
    <Card className="px-4 py-3.5">
      <p className="text-xs text-ink-muted">{label}</p>
      {loading ? (
        <Skeleton className="mt-1.5 h-7 w-16" />
      ) : (
        // Proportional figures: these are standalone numbers, not a column needing
        // vertical alignment.
        <p className={`mt-0.5 text-2xl font-semibold ${tones[tone]}`}>
          {formatNumber(value ?? 0)}
        </p>
      )}
      {hint ? <p className="mt-0.5 text-xs text-ink-muted">{hint}</p> : null}
    </Card>
  );
}
