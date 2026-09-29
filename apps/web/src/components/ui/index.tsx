/**
 * Shared UI primitives.
 *
 * Collected in one module because they are small, share styling vocabulary, and are
 * always imported together. Splitting eight ~30-line components across eight files
 * would add navigation cost without adding clarity.
 *
 * `Button` lives in its own file — it has the most variants and the most props.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import type { EmailStatus } from '@throttle/core';
import { cn } from '../../lib/utils';

export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

// ═══════════════════════════════════════════════════════════════════════════
// Card
// ═══════════════════════════════════════════════════════════════════════════

export function Card({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg bg-surface ring-hairline', className)}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Form fields
// ═══════════════════════════════════════════════════════════════════════════

interface FieldWrapperProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/**
 * Wires up label/hint/error accessibility once.
 *
 * `aria-describedby` and `aria-invalid` are set here rather than at each call site,
 * because they are exactly the attributes people forget — and their absence is
 * invisible unless you are using a screen reader.
 */
function FieldWrapper({ label, hint, error, required, children }: FieldWrapperProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      {label ? (
        <label htmlFor={id} className="block text-sm font-medium text-ink-secondary">
          {label}
          {required ? (
            <span className="ml-0.5 text-critical" aria-hidden="true">
              *
            </span>
          ) : null}
        </label>
      ) : null}

      {children(id, describedBy)}

      {error ? (
        <p id={errorId} role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const fieldBase =
  'w-full rounded-md bg-surface-2 px-3 text-sm text-ink placeholder:text-ink-muted ' +
  'ring-1 ring-inset ring-line-strong transition-colors ' +
  'focus:ring-2 focus:ring-brand focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Input({ label, hint, error, className, ...props }: InputProps) {
  return (
    <FieldWrapper
      {...(label !== undefined ? { label } : {})}
      {...(hint !== undefined ? { hint } : {})}
      {...(error !== undefined ? { error } : {})}
      {...(props.required ? { required: true } : {})}
    >
      {(id, describedBy) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(fieldBase, 'h-10', error && 'ring-critical', className)}
          {...props}
        />
      )}
    </FieldWrapper>
  );
}

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  label?: string;
  hint?: string;
  error?: string;
}

export function Textarea({ label, hint, error, className, ...props }: TextareaProps) {
  return (
    <FieldWrapper
      {...(label !== undefined ? { label } : {})}
      {...(hint !== undefined ? { hint } : {})}
      {...(error !== undefined ? { error } : {})}
      {...(props.required ? { required: true } : {})}
    >
      {(id, describedBy) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={cn(fieldBase, 'min-h-28 py-2.5 leading-relaxed', error && 'ring-critical', className)}
          {...props}
        />
      )}
    </FieldWrapper>
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

export function Select({ label, hint, error, className, children, ...props }: SelectProps) {
  return (
    <FieldWrapper
      {...(label !== undefined ? { label } : {})}
      {...(hint !== undefined ? { hint } : {})}
      {...(error !== undefined ? { error } : {})}
    >
      {(id, describedBy) => (
        <select
          id={id}
          aria-describedby={describedBy}
          className={cn(fieldBase, 'h-10', error && 'ring-critical', className)}
          {...props}
        >
          {children}
        </select>
      )}
    </FieldWrapper>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Badge — status pills
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Status colours pair with a TEXT LABEL, never colour alone.
 *
 * Roughly 8% of men have some form of colour-vision deficiency, so a red dot and a
 * green dot are the same dot to a meaningful slice of users. The label is the
 * accessible channel; the colour is reinforcement.
 */
const STATUS_STYLES: Record<EmailStatus, { label: string; className: string }> = {
  SCHEDULED: { label: 'Scheduled', className: 'bg-series-1/15 text-series-1 ring-series-1/30' },
  QUEUED: { label: 'Queued', className: 'bg-series-1/15 text-series-1 ring-series-1/30' },
  SENDING: { label: 'Sending', className: 'bg-warning/15 text-warning ring-warning/30' },
  SENT: { label: 'Sent', className: 'bg-good/15 text-good ring-good/30' },
  FAILED: { label: 'Failed', className: 'bg-critical/15 text-critical ring-critical/30' },
  CANCELLED: {
    label: 'Cancelled',
    className: 'bg-ink-muted/15 text-ink-muted ring-ink-muted/30',
  },
  RESCHEDULED: {
    label: 'Rescheduled',
    className: 'bg-serious/15 text-serious ring-serious/30',
  },
};

export function StatusBadge({ status }: { status: EmailStatus }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'good' | 'warning' | 'critical' | 'brand';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-surface-3 text-ink-secondary ring-line-strong',
    good: 'bg-good/15 text-good ring-good/30',
    warning: 'bg-warning/15 text-warning ring-warning/30',
    critical: 'bg-critical/15 text-critical ring-critical/30',
    brand: 'bg-brand/15 text-brand-hover ring-brand/30',
  } as const;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Skeleton & EmptyState
// ═══════════════════════════════════════════════════════════════════════════

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded', className)} aria-hidden="true" />;
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-line" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-4 px-5 py-3.5">
          {Array.from({ length: columns }).map((__, colIndex) => (
            <Skeleton
              key={colIndex}
              className={cn('h-4', colIndex === 0 ? 'w-1/3' : 'flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon ? <div className="mb-4 text-ink-muted">{icon}</div> : null}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-ink-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      icon={
        <svg className="size-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v5M12 16h.01" strokeLinecap="round" />
        </svg>
      }
      title={title}
      {...(description !== undefined ? { description } : {})}
      {...(onRetry
        ? {
            action: (
              <button
                onClick={onRetry}
                className="text-sm font-medium text-brand-hover hover:underline"
              >
                Try again
              </button>
            ),
          }
        : {})}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Modal
// ═══════════════════════════════════════════════════════════════════════════

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  size?: 'md' | 'lg' | 'xl';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Escape to close, and lock body scroll while open. Without the scroll lock the
  // page behind the modal scrolls under it, which feels broken on a long dashboard.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog so keyboard users are not left behind it.
    panelRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' } as const;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'animate-in relative my-8 w-full rounded-xl bg-surface shadow-2xl ring-hairline focus:outline-none',
          widths[size],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="-m-1.5 rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Toasts
// ═══════════════════════════════════════════════════════════════════════════

export interface Toast {
  id: string;
  tone: 'success' | 'error' | 'info';
  message: string;
}

interface ToastContextValue {
  toast: (tone: Toast['tone'], message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { id, tone, message }]);
      // Errors linger — they usually need reading and sometimes acting on.
      setTimeout(() => dismiss(id), tone === 'error' ? 8_000 : 4_000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  const tones = {
    success: 'ring-good/40 text-good',
    error: 'ring-critical/40 text-critical',
    info: 'ring-line-strong text-ink-secondary',
  } as const;

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
        // `polite` rather than `assertive`: a toast should not interrupt a screen
        // reader mid-sentence.
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'animate-in pointer-events-auto flex items-start gap-3 rounded-lg bg-surface-2 px-4 py-3 shadow-lg ring-1',
              tones[t.tone],
            )}
          >
            <span className="mt-0.5 shrink-0" aria-hidden="true">
              {t.tone === 'success' ? '✓' : t.tone === 'error' ? '✕' : 'i'}
            </span>
            <p className="flex-1 text-sm text-ink">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-ink-muted transition-colors hover:text-ink"
            >
              <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}

// ═══════════════════════════════════════════════════════════════════════════
// Table
// ═══════════════════════════════════════════════════════════════════════════

export function Table({ children }: { children: ReactNode }) {
  return (
    // The wrapper scrolls horizontally rather than the page, so a wide table on a
    // narrow screen does not break the whole layout.
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = 'left',
}: {
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-line px-5 py-3 text-xs font-medium tracking-wide text-ink-muted uppercase',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align = 'left',
}: {
  children: ReactNode;
  className?: string;
  align?: 'left' | 'right' | 'center';
}) {
  return (
    <td
      className={cn(
        'border-b border-line/60 px-5 py-3.5 text-ink-secondary',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className,
      )}
    >
      {children}
    </td>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Pagination
// ═══════════════════════════════════════════════════════════════════════════

export function Pagination({
  page,
  totalPages,
  total,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between border-t border-line px-5 py-3">
      <p className="text-sm text-ink-muted">
        Page <span className="tabular text-ink-secondary">{page}</span> of{' '}
        <span className="tabular text-ink-secondary">{totalPages}</span>
        <span className="ml-2 text-ink-muted">({total.toLocaleString()} total)</span>
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-md px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="rounded-md px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
