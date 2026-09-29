/**
 * Session state.
 *
 * Backed by React Query rather than a bespoke context, so the session is cached,
 * deduplicated across components and revalidated on window focus for free — a user
 * returning to a tab after lunch gets a fresh session check rather than a stale one.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { MeResponse } from '@throttle/core';
import { ApiRequestError, api } from '../lib/api';

export function useSession() {
  const query = useQuery<MeResponse, ApiRequestError>({
    queryKey: ['session'],
    queryFn: () => api.auth.me(),
    // A 401 here means "not signed in", which is an expected state rather than an
    // error worth retrying.
    retry: false,
    staleTime: 60_000,
  });

  return {
    ...query,
    user: query.data?.user ?? null,
    slack: query.data?.slack ?? null,
    isAuthenticated: query.isSuccess && query.data !== undefined,
    // Distinguishes "still checking" from "definitely signed out", so the app can
    // show a loading state instead of flashing the login screen on every refresh.
    isCheckingSession: query.isLoading,
  };
}

export function useLogout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSettled: () => {
      // Clear on settled, not onSuccess: even if the logout request fails, the user
      // asked to sign out and must not be left looking at cached tenant data.
      queryClient.clear();
      navigate('/login', { replace: true });
    },
  });
}

/** The server-reported feature flags — which login providers are configured. */
export function useServerConfig() {
  return useQuery({
    queryKey: ['config'],
    queryFn: () => api.config(),
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
}
