import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortalConsent, PortalConsents, PortalGrantConsentInput } from '@health24/shared';
import { api } from './client';

const CONSENTS = ['portal', 'consents'] as const;

export function usePortalConsents() {
  return useQuery({
    queryKey: CONSENTS,
    queryFn: () => api<PortalConsents>('/portal/consents'),
  });
}

/** Sharing changes what hospitals see: refresh the list after either. */
export function useGrantConsent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: PortalGrantConsentInput) =>
      api<PortalConsent>('/portal/consents', { method: 'POST', body: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONSENTS }),
  });
}

export function useRevokeConsent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api<PortalConsent>(`/portal/consents/${id}/revoke`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CONSENTS }),
  });
}
