import { useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  AllergySummary,
  CorrectableKind,
  correctAllergySchema,
  correctDiagnosisSchema,
  correctNoteSchema,
  correctPrescriptionSchema,
  correctProcedureSchema,
  NoteSummary,
  PrescriptionResult,
  ProcedureList,
  ProcedureSummary,
  recordProcedureSchema,
  recordVitalsSchema,
  RecordedDiagnosis,
  VersionHistoryEntry,
  VitalSet,
  VitalsList,
  writeNoteSchema,
} from '@health24/shared';
import { api } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * Vitals, notes, procedures, and corrections to any clinical entry. Every
 * write refetches the whole clinical cache: a correction changes the entry's
 * list, the patient's summaries and the entry's history at once.
 */

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

export function useEncounterVitals(encounterId: string) {
  return useQuery({
    queryKey: ['clinical', 'encounter', encounterId, 'vitals'],
    queryFn: () => api<VitalSet[]>(`/encounters/${encounterId}/vitals`),
  });
}

export function usePatientVitals(patientId: string) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'vitals'],
    queryFn: () => api<VitalsList>(`/patients/${patientId}/vitals`),
  });
}

export function useRecordVitals() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof recordVitalsSchema>) =>
      api<VitalSet>('/vitals', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useMarkVitalsInError() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ groupId, reason }: { groupId: string; reason: string }) =>
      api(`/vitals/${groupId}/entered-in-error`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export function useEncounterNotes(encounterId: string) {
  return useQuery({
    queryKey: ['clinical', 'encounter', encounterId, 'notes'],
    queryFn: () => api<NoteSummary[]>(`/encounters/${encounterId}/notes`),
  });
}

export function useWriteNote() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof writeNoteSchema>) =>
      api<NoteSummary>('/notes', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCorrectNote() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof correctNoteSchema> }) =>
      api<NoteSummary>(`/notes/${id}/correct`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Procedures
// ---------------------------------------------------------------------------

export function useEncounterProcedures(encounterId: string) {
  return useQuery({
    queryKey: ['clinical', 'encounter', encounterId, 'procedures'],
    queryFn: () => api<ProcedureSummary[]>(`/encounters/${encounterId}/procedures`),
  });
}

export function usePatientProcedures(patientId: string) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'procedures'],
    queryFn: () => api<ProcedureList>(`/patients/${patientId}/procedures`),
  });
}

export function useRecordProcedure() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof recordProcedureSchema>) =>
      api<ProcedureSummary>('/procedures', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCorrectProcedure() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof correctProcedureSchema> }) =>
      api<ProcedureSummary>(`/procedures/${id}/correct`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export function useCorrectDiagnosis() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof correctDiagnosisSchema> }) =>
      api<RecordedDiagnosis>(`/diagnoses/${id}/correct`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCorrectPrescription() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof correctPrescriptionSchema> }) =>
      api<PrescriptionResult>(`/prescriptions/${id}/correct`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCorrectAllergy() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof correctAllergySchema> }) =>
      api<AllergySummary>(`/allergies/${id}/correct`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useMarkEnteredInError() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ kind, id, reason }: { kind: CorrectableKind; id: string; reason: string }) =>
      api(`/${kind}/${id}/entered-in-error`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

export function useEntryHistory(kind: CorrectableKind, id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['clinical', 'history', kind, id],
    queryFn: () => api<VersionHistoryEntry[]>(`/clinical-history/${kind}/${id}`),
    enabled,
  });
}
