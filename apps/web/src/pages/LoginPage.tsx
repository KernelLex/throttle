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
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* ── Brand ──────────────────────────────────────────────────────── */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-brand">
            <svg className="size-6 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M13 2L4.5 12.5h6L11 22l8.5-10.5h-6L13 2z" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Throttle</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Schedule, rate-limit and deliver email at scale.
          </p>
        </div>

        {/* ── Sign-in card ───────────────────────────────────────────────── */}
        <div className="rounded-xl bg-surface p-6 ring-hairline">
          <h2 className="text-sm font-medium text-ink">Sign in to continue</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Use your Google account. The first person in a workspace becomes its
            administrator.
          </p>

          {googleEnabled ? (
            // A full-page navigation, deliberately not fetch(): OAuth requires a
            // top-level redirect so the browser lands on Google's own origin.
            <a
              href={api.auth.googleLoginUrl('/dashboard')}
              className="mt-5 flex h-11 w-full items-center justify-center gap-3 rounded-md bg-white font-medium text-[#1f1f1f] transition-opacity hover:opacity-90"
            >
              <svg className="size-5" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84c.87-2.6 3.3-4.51 6.16-4.51z" />
              </svg>
              Continue with Google
            </a>
          ) : (
            <div className="mt-5 rounded-md bg-warning/10 px-4 py-3 ring-1 ring-warning/30">
              <p className="text-sm font-medium text-warning">Google sign-in is not configured</p>
              <p className="mt-1 text-xs text-ink-muted">
                Set <code className="font-mono">GOOGLE_CLIENT_ID</code> and{' '}
                <code className="font-mono">GOOGLE_CLIENT_SECRET</code> in your{' '}
                <code className="font-mono">.env</code>, then restart the API.
              </p>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-ink-muted">
          Sessions use httpOnly cookies and rotate automatically.
        </p>
      </div>
    </main>
  );
}
