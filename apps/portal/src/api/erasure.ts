import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ErasureRequestSummary, RequestErasureInput } from '@health24/shared';
import { api } from './client';

const ERASURE = ['portal', 'erasure'] as const;

export function useErasureRequests() {
  return useQuery({
    queryKey: ERASURE,
    queryFn: () => api<ErasureRequestSummary[]>('/portal/erasure-requests'),
  });
}

export function useRequestErasure() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RequestErasureInput) =>
      api<ErasureRequestSummary>('/portal/erasure-requests', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ERASURE }),
  });
}
