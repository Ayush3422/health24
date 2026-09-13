import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  AllergyBanner,
  AllergyCriticality,
  AllergyMatch,
  AllergySummary,
  ClinicianOption,
  ConditionSummary,
  CurrentMedications,
  EncounterClass,
  EncounterSummary,
  FoodTiming,
  MedicationSummary,
  openEncounterSchema,
  prescribeSchema,
  PrescriptionResult,
  ProblemList,
  recordAllergySchema,
  recordDiagnosisSchema,
  RecordedDiagnosis,
  SystemOfMedicine,
} from '@health24/shared';
import { ApiError, api } from './client';

export const SYSTEM_LABELS: Record<SystemOfMedicine, string> = {
  ayurveda: 'Ayurveda',
  siddha: 'Siddha',
  unani: 'Unani',
  yoga_naturopathy: 'Yoga & Naturopathy',
  homeopathy: 'Homeopathy',
  allopathy: 'Allopathy',
};

export const ENCOUNTER_CLASS_LABELS: Record<EncounterClass, string> = {
  outpatient: 'OPD',
  inpatient: 'IPD',
  emergency: 'Emergency',
  teleconsultation: 'Teleconsultation',
};

/** Words, not colour alone: the banner must read correctly in greyscale. */
export const CRITICALITY_LABELS: Record<AllergyCriticality, string> = {
  high: 'High risk',
  low: 'Low risk',
  unable_to_assess: 'Risk not assessed',
};

export const FOOD_TIMING_LABELS: Record<FoodTiming, string> = {
  empty_stomach: 'Empty stomach',
  before_food: 'Before food',
  with_food: 'With food',
  after_food: 'After food',
  bedtime: 'At bedtime',
  not_applicable: 'Not applicable',
};

/** Code systems by key, as a clinician would name them. */
export const CODE_SYSTEM_LABELS: Record<string, string> = {
  namaste: 'NAMASTE',
  'icd11-tm2': 'ICD-11 TM2',
  'icd11-mms': 'ICD-11 MMS',
};

/**
 * Every clinical query sits under one key. A clinical write can change what
 * several screens show — a new allergy changes the banner and the next
 * prescription's check — so a write refetches the lot rather than guessing.
 */
const CLINICAL = ['clinical'] as const;

export function useInvalidateClinical() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: CLINICAL });
}

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

export function useWorklist(date: string) {
  return useQuery({
    queryKey: [...CLINICAL, 'worklist', date],
    queryFn: () =>
      api<{ results: EncounterSummary[]; total: number }>(`/encounters?date=${date}&limit=100`),
    placeholderData: keepPreviousData,
  });
}

export function usePatientEncounters(patientId: string) {
  return useQuery({
    queryKey: [...CLINICAL, 'patient', patientId, 'encounters'],
    queryFn: () =>
      api<{ results: EncounterSummary[]; total: number }>(
        `/encounters?patientId=${patientId}&limit=100`,
      ),
  });
}

export function useEncounter(id: string | undefined) {
  return useQuery({
    queryKey: [...CLINICAL, 'encounter', id],
    queryFn: () => api<EncounterSummary>(`/encounters/${id}`),
    enabled: Boolean(id),
  });
}

export function useOpenEncounter() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof openEncounterSchema>) =>
      api<EncounterSummary>('/encounters', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCloseEncounter() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({
      id,
      outcome,
      reason,
    }: {
      id: string;
      outcome: 'finish' | 'cancel';
      reason?: string;
    }) =>
      api<EncounterSummary>(`/encounters/${id}/${outcome}`, {
        method: 'POST',
        body: outcome === 'cancel' ? { reason } : {},
      }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Diagnoses
// ---------------------------------------------------------------------------

export function useEncounterDiagnoses(encounterId: string | undefined) {
  return useQuery({
    queryKey: [...CLINICAL, 'encounter', encounterId, 'diagnoses'],
    queryFn: () => api<ConditionSummary[]>(`/encounters/${encounterId}/diagnoses`),
    enabled: Boolean(encounterId),
  });
}

export function useProblemList(patientId: string) {
  return useQuery({
    queryKey: [...CLINICAL, 'patient', patientId, 'problems'],
    queryFn: () => api<ProblemList>(`/patients/${patientId}/problems`),
  });
}

export function useRecordDiagnosis() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof recordDiagnosisSchema>) =>
      api<RecordedDiagnosis>('/diagnoses', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Allergies
// ---------------------------------------------------------------------------

export function useAllergyBanner(patientId: string | undefined) {
  return useQuery({
    queryKey: [...CLINICAL, 'patient', patientId, 'allergies'],
    queryFn: () => api<AllergyBanner>(`/patients/${patientId}/allergies`),
    enabled: Boolean(patientId),
  });
}

export function useRecordAllergy() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof recordAllergySchema>) =>
      api<AllergySummary>('/allergies', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Prescriptions
// ---------------------------------------------------------------------------

export function useEncounterPrescriptions(encounterId: string | undefined) {
  return useQuery({
    queryKey: [...CLINICAL, 'encounter', encounterId, 'prescriptions'],
    queryFn: () => api<MedicationSummary[]>(`/encounters/${encounterId}/prescriptions`),
    enabled: Boolean(encounterId),
  });
}

export function useCurrentMedications(patientId: string) {
  return useQuery({
    queryKey: [...CLINICAL, 'patient', patientId, 'medications'],
    queryFn: () => api<CurrentMedications>(`/patients/${patientId}/medications`),
  });
}

export function usePrescribe() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof prescribeSchema>) =>
      api<PrescriptionResult>('/prescriptions', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useStopPrescription() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<MedicationSummary>(`/prescriptions/${id}/stop`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

/**
 * The allergy warning, when a prescription was refused for matching a
 * recorded allergy. Anything else is an ordinary error.
 */
export function allergyMatchesFrom(
  error: unknown,
): { matches: AllergyMatch[]; limitation: string } | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;

  const body = error.body as {
    code?: string;
    matches?: AllergyMatch[];
    limitation?: string;
  } | null;

  return body?.code === 'ALLERGY_MATCH' && body.matches
    ? { matches: body.matches, limitation: body.limitation ?? '' }
    : null;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export function useClinicians(enabled: boolean) {
  return useQuery({
    queryKey: [...CLINICAL, 'clinicians'],
    queryFn: () => api<ClinicianOption[]>('/clinicians'),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
