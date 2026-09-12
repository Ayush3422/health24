import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HospitalSummary,
  PatientSummary,
  RegisterPatientInput,
  StaffSummary,
} from '@health24/shared';
import { api } from './client';

export interface RegistrationResult {
  patient: PatientSummary;
  linkedExisting: boolean;
  queuedForReview: number;
}

export interface MatchCandidate {
  patientId: string;
  score: number;
  method: string;
  matchedOn: string[];
  maskedName: string;
  maskedPhone: string | null;
  yearOfBirth: number | null;
  hospitalCount: number;
}

export interface MergeQueueEntry {
  id: string;
  score: number;
  method: string;
  matchedOn: string[];
  detectedAt: string;
  patients: Array<{
    patientId: string;
    maskedName: string;
    maskedPhone: string | null;
    yearOfBirth: number | null;
    gender: string | null;
  }>;
}

export function useOwnHospital(enabled = true) {
  return useQuery({
    queryKey: ['hospital', 'me'],
    queryFn: () => api<HospitalSummary>('/hospitals/me'),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

export function usePatientSearch(term: string) {
  return useQuery({
    queryKey: ['patients', 'search', term],
    queryFn: () =>
      api<{ results: PatientSummary[]; total: number }>(`/patients?q=${encodeURIComponent(term)}`),
    // Searching for an empty string would return the whole register.
    enabled: term.trim().length > 0,
    staleTime: 10_000,
  });
}

export function usePatient(id: string | undefined) {
  return useQuery({
    queryKey: ['patients', id],
    queryFn: () => api<PatientSummary>(`/patients/${id}`),
    enabled: Boolean(id),
  });
}

export function useRegisterPatient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RegisterPatientInput & { forceCreate?: boolean }) =>
      api<RegistrationResult>('/patients', { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useLinkPatient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ patientId, identity }: { patientId: string; identity: unknown }) =>
      api<RegistrationResult>(`/patients/${patientId}/link`, {
        method: 'POST',
        body: identity,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useUpdatePatient(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      api<PatientSummary>(`/patients/${id}`, { method: 'PATCH', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useMergeQueue(enabled: boolean) {
  return useQuery({
    queryKey: ['merge-queue'],
    queryFn: () => api<MergeQueueEntry[]>('/patients/merge-queue'),
    enabled,
  });
}

export function useResolveMerge() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      decision,
      reason,
      keepPatientId,
    }: {
      id: string;
      decision: 'merge' | 'reject';
      reason: string;
      keepPatientId?: string;
    }) =>
      api<{ status: string; survivingPatientId?: string; mergeLogId?: string }>(
        `/patients/merge-queue/${id}/resolve`,
        { method: 'POST', body: { decision, reason, keepPatientId } },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['merge-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useStaff(enabled: boolean) {
  return useQuery({
    queryKey: ['staff'],
    queryFn: () => api<StaffSummary[]>('/staff'),
    enabled,
  });
}
