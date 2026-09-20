import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DecideErasureInput, ErasureQueueItem } from '@health24/shared';
import { api } from './client';

/** Erasure requests, for Health24's data-protection officer (SP5, Decision N1). */

const QUEUE = ['erasure-requests'] as const;

export function useErasureQueue() {
  return useQuery({
    queryKey: QUEUE,
    queryFn: () => api<ErasureQueueItem[]>('/erasure-requests'),
  });
}

export function useDecideErasure() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...body }: DecideErasureInput & { id: string }) =>
      api<ErasureQueueItem>(`/erasure-requests/${id}/decide`, { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUEUE }),
  });
}
