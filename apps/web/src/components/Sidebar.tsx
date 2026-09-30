/**
 * Left navigation rail — the Figma's fixed sidebar.
 *
 * Holds the wordmark, the account card, the Compose action, and the CORE nav
 * (Scheduled / Sent) with live counts. Counts come from the real stats endpoint
 * rather than being decorative.
 */

import type { SessionUser } from '@throttle/core';
import { cn, formatNumber } from '../lib/utils';

export type MailboxView = 'scheduled' | 'sent';

interface SidebarProps {
  user: SessionUser | null;
  active: MailboxView;
  onSelect: (view: MailboxView) => void;
  onCompose: () => void;
  scheduledCount: number;
  sentCount: number;
  onLogout: () => void;
  loggingOut: boolean;
  /** Admin-only link to the Bull Board queue dashboard. */
  queuesHref?: string;
}

export function Sidebar({
  user,
  active,
  onSelect,
  onCompose,
  scheduledCount,
  sentCount,
  onLogout,
  loggingOut,
  queuesHref,
}: SidebarProps) {
  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r border-line bg-surface">
      {/* ── Wordmark ─────────────────────────────────────────────────────── */}
      <div className="px-6 pt-6 pb-5">
        <span
          className="text-[26px] leading-none font-black tracking-[0.06em] text-ink"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          ONB
        </span>
      </div>

      {/* ── Account ──────────────────────────────────────────────────────── */}
      <div className="px-4">
        <div className="flex items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5">
          {user?.avatarUrl ? (
            <img
              src={user.avatarUrl}
              alt=""
              // Required, or Google's avatar CDN returns 403 to a cross-origin request.
              referrerPolicy="no-referrer"
              className="size-9 shrink-0 rounded-full object-cover"
            />
          ) : (
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-4 text-sm font-medium text-ink-secondary">
              {user?.name?.charAt(0).toUpperCase() ?? '?'}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{user?.name ?? '—'}</p>
            <p className="truncate text-xs text-ink-secondary">{user?.email ?? ''}</p>
          </div>

          <button
            onClick={onLogout}
            disabled={loggingOut}
            title="Log out"
            aria-label="Log out"
            className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:bg-surface-4 hover:text-ink disabled:opacity-50"
          >
            <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Compose ──────────────────────────────────────────────────────── */}
      <div className="px-4 pt-4">
        <button
          onClick={onCompose}
          className="h-11 w-full rounded-pill border border-accent text-[15px] font-medium text-accent transition-colors hover:bg-accent-tint active:bg-accent-tint-strong"
        >
          Compose
        </button>
      </div>

      {/* ── Nav ──────────────────────────────────────────────────────────── */}
      <nav className="px-4 pt-7" aria-label="Mailboxes">
        <p className="px-3 pb-2 text-[11px] font-medium tracking-[0.1em] text-ink-muted uppercase">
          Core
        </p>

        <NavItem
          label="Scheduled"
          count={scheduledCount}
          selected={active === 'scheduled'}
          onClick={() => onSelect('scheduled')}
          icon={
            <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />

        <NavItem
          label="Sent"
          count={sentCount}
          selected={active === 'sent'}
          onClick={() => onSelect('sent')}
          icon={
            <svg className="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          }
        />
      </nav>

      <div className="flex-1" />

      {queuesHref ? (
        <div className="px-7 pb-5">
          <a
            href={queuesHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-ink-muted transition-colors hover:text-ink-secondary"
          >
            Queue dashboard ↗
          </a>
        </div>
      ) : null}
    </aside>
  );
}

function NavItem({
  label,
  count,
  selected,
  onClick,
  icon,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-pill px-3 py-2.5 text-[15px] transition-colors',
        selected
          ? 'bg-accent-tint font-semibold text-ink'
          : 'font-normal text-ink-secondary hover:bg-surface-2',
      )}
    >
      <span className={selected ? 'text-ink' : 'text-ink-muted'}>{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      <span className="tabular text-[13px] text-ink-secondary">{formatNumber(count)}</span>
    </button>
  );
}
