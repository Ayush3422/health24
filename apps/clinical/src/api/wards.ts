import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  addBedsSchema,
  Admission,
  AdmissionList,
  admitSchema,
  BedSummary,
  createWardSchema,
  dischargeSchema,
  setBedStatusSchema,
  transferSchema,
  updateWardSchema,
  WardList,
  WardSummary,
} from '@health24/shared';
import { api } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * Wards, beds and admissions (SP6 Phase 3).
 *
 * The board and the record are one thing: admitting, moving and discharging
 * all change an encounter as well as a bed, so every write clears the clinical
 * cache along with the board.
 */

export function useWards(enabled = true) {
  return useQuery({
    queryKey: ['clinical', 'wards'],
    queryFn: () => api<WardList>('/wards'),
    enabled,
    // The board is read while other people are moving patients around it.
    refetchInterval: 60_000,
  });
}

export function useAdmissions(scope: 'current' | 'all' = 'current', patientId?: string) {
  return useQuery({
    queryKey: ['clinical', 'admissions', scope, patientId ?? null],
    queryFn: () => {
      const query = new URLSearchParams({ scope });
      if (patientId) query.set('patientId', patientId);
      return api<AdmissionList>(`/admissions?${query.toString()}`);
    },
  });
}

export function useAdmission(encounterId: string, enabled = true) {
  return useQuery({
    queryKey: ['clinical', 'encounter', encounterId, 'admission'],
    queryFn: () => api<Admission>(`/admissions/${encounterId}`),
    enabled,
    retry: false,
  });
}

function useWardWrite<TBody, TResult>(path: (body: TBody) => string) {
  const invalidate = useInvalidateClinical();
  const client = useQueryClient();

  return useMutation({
    mutationFn: (body: TBody) => api<TResult>(path(body), { method: 'POST', body }),
    onSuccess: async () => {
      await invalidate();
      await client.invalidateQueries({ queryKey: ['clinical', 'wards'] });
    },
  });
}

export function useCreateWard() {
  return useWardWrite<z.input<typeof createWardSchema>, WardSummary>(() => '/wards');
}

export function useUpdateWard() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof updateWardSchema> }) =>
      api<WardSummary>(`/wards/${id}`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useAddBeds() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof addBedsSchema> }) =>
      api<WardSummary>(`/wards/${id}/beds`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useSetBedStatus() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof setBedStatusSchema> }) =>
      api<BedSummary>(`/beds/${id}/status`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useAdmit() {
  return useWardWrite<z.input<typeof admitSchema>, Admission>(() => '/admissions');
}

export function useTransfer() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({
      encounterId,
      body,
    }: {
      encounterId: string;
      body: z.input<typeof transferSchema>;
    }) => api<Admission>(`/admissions/${encounterId}/transfer`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useDischarge() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({
      encounterId,
      body,
    }: {
      encounterId: string;
      body: z.input<typeof dischargeSchema>;
    }) => api<Admission>(`/admissions/${encounterId}/discharge`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}
