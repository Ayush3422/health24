import { useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  correctImplantSchema,
  ImplantList,
  ImplantSearchResults,
  ImplantSummary,
  recordImplantSchema,
} from '@health24/shared';
import { api } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * Implants and devices (SP6 Phase 4). Under the clinical cache key: a device
 * is part of the operation, and a correction to one changes the encounter's
 * list and the device's own history at once.
 */

export function useEncounterImplants(encounterId: string) {
  return useQuery({
    queryKey: ['clinical', 'encounter', encounterId, 'implants'],
    queryFn: () => api<ImplantSummary[]>(`/encounters/${encounterId}/implants`),
  });
}

export function usePatientImplants(patientId: string) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'implants'],
    queryFn: () => api<ImplantList>(`/patients/${patientId}/implants`),
  });
}

/** A recall: every device of a batch this hospital has implanted. */
export function useDeviceSearch(term: string) {
  return useQuery({
    queryKey: ['clinical', 'implants', 'search', term],
    queryFn: () => api<ImplantSearchResults>(`/implants?q=${encodeURIComponent(term)}`),
    enabled: term.trim().length >= 2,
  });
}

export function useRecordImplant() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof recordImplantSchema>) =>
      api<ImplantSummary>('/implants', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCorrectImplant() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof correctImplantSchema> }) =>
      api<ImplantSummary>(`/implants/${id}/correct`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}
