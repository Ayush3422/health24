import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PortalAccessSummary } from '@health24/shared';
import { api } from './client';

/** A patient's portal access, as the desk sees it (SP5, Decision J1). */

const accessKey = (patientId: string) => ['portal-access', patientId] as const;

export function usePortalAccess(patientId: string) {
  return useQuery({
    queryKey: accessKey(patientId),
    queryFn: () => api<PortalAccessSummary[]>(`/patients/${patientId}/portal-access`),
  });
}

export function useActivatePortalAccess(patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (phone: string) =>
      api<PortalAccessSummary>(`/patients/${patientId}/portal-access`, {
        method: 'POST',
        body: { phone, identityConfirmed: true },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accessKey(patientId) }),
  });
}

export function useRevokePortalAccess(patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<PortalAccessSummary>(`/portal-access/${id}/revoke`, { method: 'POST', body: { reason } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accessKey(patientId) }),
  });
}
