import { useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  composeDischargeSchema,
  DischargeSummary,
  editDischargeSchema,
} from '@health24/shared';
import { api, ApiError } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * The discharge summary (SP6 Phase 5). Composing, editing and signing all
 * change the encounter's record — signing writes a note and a document — so
 * every write clears the clinical cache.
 */

export function useDischargeSummary(encounterId: string, enabled = true) {
  return useQuery({
    queryKey: ['clinical', 'encounter', encounterId, 'discharge-summary'],
    queryFn: () => api<DischargeSummary>(`/encounters/${encounterId}/discharge-summary`),
    enabled,
    // A summary that has not been started yet is a 404, and that is an answer.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
}

export function useComposeDischarge() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof composeDischargeSchema>) =>
      api<DischargeSummary>('/discharge-summaries', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useEditDischarge() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof editDischargeSchema> }) =>
      api<DischargeSummary>(`/discharge-summaries/${id}`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSignDischarge() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (id: string) =>
      api<DischargeSummary>(`/discharge-summaries/${id}/sign`, {
        method: 'POST',
        body: { confirmed: true },
      }),
    onSuccess: invalidate,
  });
}
