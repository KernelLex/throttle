import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { API_URL, api } from '../lib/api';
import { useLogout, useSession } from '../hooks/useAuth';
import { useToast } from '../components/ui';
import { Sidebar, type MailboxView } from '../components/Sidebar';
import { EmailList } from '../features/emails/EmailList';
import { ComposePage } from '../features/compose/ComposePage';
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

  const [view, setView] = useState<MailboxView>('scheduled');
  const [composing, setComposing] = useState(false);
  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [panelOpen, setPanelOpen] = useState(false);

  const [searchParams, setSearchParams] = useSearchParams();

  // Surface the Slack callback result once, then strip the param so a refresh
  // does not replay the toast.
  const slackResult = searchParams.get('slack');
  useEffect(() => {
    if (!slackResult) return;
    const message = SLACK_MESSAGES[slackResult];
    if (message) toast(message.tone, message.text);
    searchParams.delete('slack');
    setSearchParams(searchParams, { replace: true });
  }, [slackResult, toast, searchParams, setSearchParams]);

  const stats = useQuery({
    queryKey: ['stats', refreshKey],
    queryFn: () => api.stats.get(),
    refetchInterval: 10_000,
  });

  return (
    <div className="flex h-screen overflow-hidden bg-surface-2">
      <Sidebar
        user={user}
        active={view}
        onSelect={(next) => {
          setView(next);
          setComposing(false);
        }}
        onCompose={() => setComposing(true)}
        scheduledCount={stats.data?.scheduledCount ?? 0}
        sentCount={stats.data?.sentCount ?? 0}
        onLogout={() => logout.mutate()}
        loggingOut={logout.isPending}
        {...(user?.role === 'ADMIN' ? { queuesHref: `${API_URL}/admin/queues` } : {})}
      />

      {/* ── Main pane ────────────────────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col p-3">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
          {composing ? (
            <ComposePage
              onClose={() => setComposing(false)}
              onScheduled={() => {
                setComposing(false);
                setView('scheduled');
                setRefreshKey((k) => k + 1);
              }}
            />
          ) : (
            <>
              {/* ── Search bar ─────────────────────────────────────────── */}
              <div className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
                <div className="relative flex-1">
                  <svg
                    className="pointer-events-none absolute top-1/2 left-4 size-[18px] -translate-y-1/2 text-ink-muted"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                  </svg>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search"
                    aria-label="Search emails"
                    className="h-11 w-full rounded-pill bg-surface-2 pr-4 pl-11 text-[15px] text-ink outline-none placeholder:text-ink-muted focus:bg-surface-3"
                  />
                </div>

                <button
                  onClick={() => setPanelOpen((v) => !v)}
                  aria-label="Sender health and integrations"
                  aria-expanded={panelOpen}
                  title="Sender health and integrations"
                  className={`rounded-md p-2 transition-colors ${panelOpen ? 'bg-accent-tint text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'}`}
                >
                  <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>

                <button
                  onClick={() => setRefreshKey((k) => k + 1)}
                  aria-label="Refresh"
                  title="Refresh"
                  className="rounded-md p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                >
                  <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              {/* ── List + optional side panel ──────────────────────────── */}
              <div className="flex min-h-0 flex-1">
                <div className="min-w-0 flex-1 overflow-y-auto">
                  <EmailList
                    view={view}
                    search={search}
                    onCompose={() => setComposing(true)}
                    refreshKey={refreshKey}
                  />
                </div>

                {panelOpen ? (
                  <div className="w-[340px] shrink-0 space-y-3 overflow-y-auto border-l border-line bg-surface-2 p-3">
                    <SenderHealthPanel />
                    <SlackConnectCard />
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
