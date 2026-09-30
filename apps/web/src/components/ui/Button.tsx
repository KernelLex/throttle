import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button. */
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

/**
 * With no accent hue, hierarchy is carried entirely by contrast: the primary
 * action is white-on-black and everything else recedes toward the surface.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-plane hover:bg-accent-hover active:bg-accent-muted font-medium',
  secondary: 'bg-surface-3 text-ink hover:bg-surface-4 ring-1 ring-inset ring-line-strong',
  ghost: 'bg-transparent text-ink-secondary hover:bg-surface-2 hover:text-ink',
  // Destructive is an OUTLINE, not a fill. Without red to signal danger, the
  // distinction has to come from form — and the confirming copy on the button.
  danger: 'bg-transparent text-ink ring-1 ring-inset ring-ink-muted hover:bg-surface-3',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3.5 text-[13px] gap-1.5',
  md: 'h-10 px-4.5 text-sm gap-2',
  lg: 'h-12 px-6 text-[15px] gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth,
    className,
    children,
    disabled,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      // A loading button must also be disabled, or a double-click fires the action
      // twice while the first request is still in flight.
      disabled={disabled || loading}
      // Screen readers otherwise announce nothing when a button enters a loading
      // state — the label is unchanged and the spinner is decorative.
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium',
        'transition-all duration-200 ease-out active:scale-[0.98]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? (
        <svg className="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          <path
            d="M12 2a10 10 0 0 1 10 10"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
