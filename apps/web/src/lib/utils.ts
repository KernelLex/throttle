/**
 * Shared frontend helpers.
 */

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge class names, resolving Tailwind conflicts.
 *
 * clsx alone would leave `px-2 px-4` both present, and which wins depends on CSS
 * source order rather than call order — so a component's `className` prop would
 * sometimes fail to override its defaults. twMerge makes the last one win.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Locale-aware date + time, e.g. "30 Sep, 16:12". */
export function formatDateTime(value: string | number | Date | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Time only, e.g. "16:12". Used on the chart's hour-window axis. */
export function formatTime(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Relative time, e.g. "in 12m" or "3h ago". */
export function formatRelative(value: string | number | Date | null): string {
  if (value === null) return '—';
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return '—';

  const deltaMs = target - Date.now();
  const future = deltaMs > 0;
  const seconds = Math.abs(Math.round(deltaMs / 1000));

  if (seconds < 45) return future ? 'in a moment' : 'just now';

  const [amount, unit] =
    seconds < 3600
      ? [Math.round(seconds / 60), 'm']
      : seconds < 86_400
        ? [Math.round(seconds / 3600), 'h']
        : [Math.round(seconds / 86_400), 'd'];

  return future ? `in ${amount}${unit}` : `${amount}${unit} ago`;
}

export const formatNumber = (value: number): string => value.toLocaleString();

/** Convert a local `datetime-local` input value to an ISO string. */
export function localInputToIso(value: string): string {
  return new Date(value).toISOString();
}

/** Format a Date for a `datetime-local` input, which needs local time, no zone. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
