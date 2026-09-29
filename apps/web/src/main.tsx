import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { ApiRequestError } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Dashboard data is live, so a short stale window keeps it fresh without
      // refetching on every render.
      staleTime: 5_000,
      // The api client already retries once after refreshing an expired session, so
      // a 401 reaching here is a genuine sign-out — retrying would just delay the
      // redirect to the login screen.
      retry: (failureCount, error) => {
        if (error instanceof ApiRequestError && error.isAuthError) return false;
        if (error instanceof ApiRequestError && error.status === 404) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: true,
    },
    mutations: {
      // Mutations are never retried automatically. A retried POST /campaigns could
      // schedule a second campaign — the Idempotency-Key guards against it, but not
      // retrying at all is the clearer contract.
      retry: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
