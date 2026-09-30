import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession, useServerConfig } from '../hooks/useAuth';
import { useToast } from '../components/ui';

/** Maps the `?error=` values the OAuth callback redirects with to readable copy. */
const ERROR_MESSAGES: Record<string, string> = {
  cancelled: 'Sign-in was cancelled.',
  invalid_response: 'Google returned an unexpected response. Please try again.',
  signin_failed: 'Could not complete sign-in. Please try again.',
};

export function LoginPage() {
  const { isAuthenticated, isCheckingSession } = useSession();
  const { data: config } = useServerConfig();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  const error = searchParams.get('error');

  useEffect(() => {
    if (error) toast('error', ERROR_MESSAGES[error] ?? 'Sign-in failed. Please try again.');
  }, [error, toast]);

  if (isCheckingSession) return null;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  const googleEnabled = config?.googleOAuthEnabled ?? false;

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[420px] rounded-xl border border-line bg-surface px-10 py-11">
        <h1 className="text-center text-[32px] font-bold tracking-tight text-ink">Login</h1>

        {/* ── Google — the only working path ──────────────────────────────── */}
        <div className="mt-8">
          {googleEnabled ? (
            // A full-page navigation, deliberately not fetch(): OAuth requires a
            // top-level redirect so the browser lands on Google's own origin.
            <a
              href={api.auth.googleLoginUrl('/dashboard')}
              className="flex h-12 w-full items-center justify-center gap-3 rounded-lg bg-accent-tint text-[15px] font-medium text-ink transition-colors hover:bg-accent-tint-strong"
            >
              <svg className="size-5" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84c.87-2.6 3.3-4.51 6.16-4.51z" />
              </svg>
              Login with Google
            </a>
          ) : (
            <div className="rounded-lg bg-surface-3 px-4 py-3">
              <p className="text-sm font-medium text-ink">Google sign-in is not configured</p>
              <p className="mt-1 text-xs text-ink-secondary">
                Set <code className="font-mono">GOOGLE_CLIENT_ID</code> and{' '}
                <code className="font-mono">GOOGLE_CLIENT_SECRET</code>, then restart the API.
              </p>
            </div>
          )}
        </div>

        {/* ── Divider ─────────────────────────────────────────────────────── */}
        <div className="my-6 flex items-center gap-4">
          <span className="h-px flex-1 bg-line-strong" />
          <span className="text-[13px] text-ink-muted">or sign up through email</span>
          <span className="h-px flex-1 bg-line-strong" />
        </div>

        {/*
          The Figma shows email + password fields, so they are rendered at full
          fidelity rather than greyed out — a faded button would read as a broken
          implementation next to the design.

          They do not authenticate, deliberately. The brief specifies real Google
          OAuth and asks for no password flow, and shipping a live password form
          would mean storing credentials this product has no reason to hold.
          Submitting says so plainly instead of failing silently.
        */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            toast('info', 'Email sign-in isn’t enabled — use “Login with Google”.');
          }}
          className="space-y-3"
        >
          <input
            type="email"
            placeholder="Email ID"
            aria-label="Email ID"
            className="h-12 w-full rounded-lg bg-surface-2 px-4 text-[15px] text-ink outline-none placeholder:text-ink-muted focus:bg-surface-3"
          />
          <input
            type="password"
            placeholder="Password"
            aria-label="Password"
            className="h-12 w-full rounded-lg bg-surface-2 px-4 text-[15px] text-ink outline-none placeholder:text-ink-muted focus:bg-surface-3"
          />
          <button
            type="submit"
            className="h-12 w-full rounded-lg bg-accent text-[15px] font-medium text-white transition-colors hover:bg-accent-hover active:bg-accent-active"
          >
            Login
          </button>
        </form>
      </div>
    </main>
  );
}
