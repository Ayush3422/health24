import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CorrectionQueueItem } from '@health24/shared';
import { api } from './client';

/** Corrections patients have asked this hospital for (SP5, Decision N1). */

const QUEUE = ['correction-requests'] as const;

export function useCorrectionQueue() {
  return useQuery({
    queryKey: QUEUE,
    queryFn: () => api<CorrectionQueueItem[]>('/correction-requests'),
  });
}

function useResolve(action: 'apply' | 'decline') {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api<CorrectionQueueItem>(`/correction-requests/${id}/${action}`, {
        method: 'POST',
        body: note ? { note } : {},
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUEUE }),
  });
}

export const useApplyCorrection = () => useResolve('apply');
export const useDeclineCorrection = () => useResolve('decline');
