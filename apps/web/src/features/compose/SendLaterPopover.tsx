/**
 * "Send Later" popover — the Figma's date/time picker with quick presets.
 *
 * Presets are computed from the current clock rather than hardcoded, so
 * "Tomorrow, 10:00 AM" always means the next 10am, not a fixed string.
 */

import { useEffect, useRef } from 'react';
import { toLocalInputValue } from '../../lib/utils';

interface SendLaterPopoverProps {
  /** Current value, in `datetime-local` format. */
  value: string;
  onChange: (next: string) => void;
  onClose: () => void;
}

/** Tomorrow at a given hour, local time. */
function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, minute, 0, 0);
  return d;
}

const PRESETS: { label: string; build: () => Date }[] = [
  { label: 'Tomorrow', build: () => tomorrowAt(9) },
  { label: 'Tomorrow, 10:00 AM', build: () => tomorrowAt(10) },
  { label: 'Tomorrow, 11:00 AM', build: () => tomorrowAt(11) },
  { label: 'Tomorrow, 3:00 PM', build: () => tomorrowAt(15) },
];

export function SendLaterPopover({ value, onChange, onClose }: SendLaterPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape. Both, because a popover that only closes
  // one way is the kind of thing keyboard users get stuck in.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Send later"
      className="animate-in popover-shadow absolute top-full right-0 z-50 mt-2 w-[340px] rounded-xl border border-line bg-surface p-5"
    >
      <h2 className="text-[17px] font-semibold text-ink">Send Later</h2>

      <label className="mt-4 flex items-center gap-2 border-b border-line pb-2">
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Pick date and time"
          className="flex-1 bg-transparent text-[15px] text-ink outline-none"
        />
      </label>

      <ul className="mt-4 space-y-0.5">
        {PRESETS.map((preset) => (
          <li key={preset.label}>
            <button
              onClick={() => onChange(toLocalInputValue(preset.build()))}
              className="w-full rounded-md px-2 py-2 text-left text-[15px] text-ink transition-colors hover:bg-surface-2"
            >
              {preset.label}
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-6 flex items-center justify-end gap-3">
        <button
          onClick={onClose}
          className="px-3 py-2 text-[15px] text-ink-secondary transition-colors hover:text-ink"
        >
          Cancel
        </button>
        <button
          onClick={onClose}
          className="h-10 rounded-pill border border-accent px-6 text-[15px] font-medium text-accent transition-colors hover:bg-accent-tint"
        >
          Done
        </button>
      </div>
    </div>
  );
}
