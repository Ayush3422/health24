import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CorrectionRequestSummary,
  PortalCorrections,
  RequestCorrectionInput,
} from '@health24/shared';
import { api } from './client';

const CORRECTIONS = ['portal', 'corrections'] as const;

export function useCorrections() {
  return useQuery({
    queryKey: CORRECTIONS,
    queryFn: () => api<PortalCorrections>('/portal/corrections'),
  });
}

export function useRequestCorrection() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RequestCorrectionInput) =>
      api<CorrectionRequestSummary>('/portal/corrections', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CORRECTIONS }),
  });
}
