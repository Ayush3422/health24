import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AbhaChallenge,
  AbhaIdentity,
  AbhaVerificationMethod,
  CareContextState,
  ConsentSummary,
} from '@health24/shared';
import { api } from './client';

/**
 * A patient's ABHA, and which of their visits are on the national network
 * (sp8-plan.md, T31).
 *
 * Both invalidate the patient itself as well as their own key: the patient
 * summary carries whether the ABHA is verified, and a screen showing "not
 * verified" beside a verification that just succeeded is worse than a screen
 * that shows nothing.
 */

const abhaKey = (patientId: string) => ['abha', patientId] as const;
const careContextsKey = (patientId: string) => ['care-contexts', patientId] as const;

export function usePatientAbha(patientId: string) {
  return useQuery({
    queryKey: abhaKey(patientId),
    queryFn: () => api<AbhaIdentity>(`/patients/${patientId}/abha`),
  });
}

export function useStartAbhaVerification(patientId: string) {
  return useMutation({
    mutationFn: (input: {
      abhaAddress?: string;
      abhaNumber?: string;
      method: AbhaVerificationMethod;
    }) =>
      api<AbhaChallenge>(`/patients/${patientId}/abha/verification`, {
        method: 'POST',
        body: input,
      }),
  });
}

export function useConfirmAbhaVerification(patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { transactionId: string; code: string }) =>
      api<AbhaIdentity>(`/patients/${patientId}/abha/verification/confirm`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: abhaKey(patientId) });
      await queryClient.invalidateQueries({ queryKey: ['patient', patientId] });
    },
  });
}

export function useCareContexts(patientId: string) {
  return useQuery({
    queryKey: careContextsKey(patientId),
    queryFn: () => api<CareContextState[]>(`/patients/${patientId}/care-contexts`),
  });
}

export function useOfferCareContextLink(patientId: string) {
  return useMutation({
    mutationFn: (encounterIds: string[]) =>
      api<{ linkRequestId: string; expiresAt: string; sentTo: string | null }>(
        `/patients/${patientId}/care-contexts/link`,
        { method: 'POST', body: { encounterIds } },
      ),
  });
}

export function useConfirmCareContextLink(patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { linkRequestId: string; code: string }) =>
      api<CareContextState[]>(`/patients/${patientId}/care-contexts/link/confirm`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: careContextsKey(patientId) }),
  });
}

/**
 * What a national requester was given of **this hospital's** records.
 *
 * Deliberately a different list from the consent tab's. That one says what
 * this hospital may read of somebody else's record; this says what left it.
 * A single list holding both would say the opposite of the truth about half
 * its rows (SP8, T31).
 */
export function useAbdmConsents(patientId: string) {
  return useQuery({
    queryKey: ['abdm-consents', patientId],
    queryFn: () => api<ConsentSummary[]>(`/patients/${patientId}/consents?source=abdm`),
  });
}

export function useUnlinkCareContext(patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ careContextId, reason }: { careContextId: string; reason: string }) =>
      api<{ unlinked: true }>(
        `/patients/${patientId}/care-contexts/${careContextId}/unlink`,
        { method: 'POST', body: { reason } },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: careContextsKey(patientId) }),
  });
}
