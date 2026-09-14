import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  acknowledgeCodingReviewSchema,
  BreakGlassReviewItem,
  breakGlassSchema,
  ClinicalDataCategory,
  CodingReviewItem,
  ConsentSummary,
  PatientSummaryCard,
  recordConsentSchema,
  reviewBreakGlassSchema,
  TimelineKind,
  TimelinePage,
} from '@health24/shared';
import { api } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * Consent, emergency access, the timeline, the summary card and coding review.
 *
 * Consent sits under the clinical cache key: recording or revoking it changes
 * what every clinical list may show, so each write refetches the lot.
 */

export const CATEGORY_LABELS: Record<ClinicalDataCategory, string> = {
  encounters: 'Visits',
  diagnoses: 'Diagnoses',
  medications: 'Medicines',
  allergies: 'Allergies',
  observations: 'Vitals',
  notes: 'Clinical notes',
  procedures: 'Procedures and therapies',
  documents: 'Documents and reports',
};

export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  encounter: 'Visit',
  diagnosis: 'Diagnosis',
  prescription: 'Medicine',
  allergy: 'Allergy',
  vitals: 'Vitals',
  note: 'Note',
  procedure: 'Procedure',
};

// ---------------------------------------------------------------------------
// Consent and emergency access
// ---------------------------------------------------------------------------

export function usePatientConsents(patientId: string) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'consents'],
    queryFn: () => api<ConsentSummary[]>(`/patients/${patientId}/consents`),
  });
}

export function useRecordConsent(patientId: string) {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof recordConsentSchema>) =>
      api<ConsentSummary>(`/patients/${patientId}/consents`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useRevokeConsent() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<ConsentSummary>(`/consents/${id}/revoke`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

export function useBreakGlass(patientId: string) {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof breakGlassSchema>) =>
      api<ConsentSummary>(`/patients/${patientId}/break-glass`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useBreakGlassReviews() {
  return useQuery({
    queryKey: ['clinical', 'break-glass-reviews'],
    queryFn: () => api<BreakGlassReviewItem[]>('/break-glass/reviews'),
  });
}

export function useReviewBreakGlass() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof reviewBreakGlassSchema> }) =>
      api<ConsentSummary>(`/consents/${id}/review`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

// ---------------------------------------------------------------------------
// Timeline and summary
// ---------------------------------------------------------------------------

export interface TimelineFilters {
  categories: ClinicalDataCategory[];
  scope: 'all' | 'own';
}

export function usePatientTimeline(patientId: string, filters: TimelineFilters) {
  return useInfiniteQuery({
    queryKey: ['clinical', 'patient', patientId, 'timeline', filters],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50', scope: filters.scope });
      if (filters.categories.length > 0) params.set('categories', filters.categories.join(','));
      if (pageParam) params.set('before', pageParam);

      return api<TimelinePage>(`/patients/${patientId}/timeline?${params.toString()}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
}

export function usePatientSummary(patientId: string) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'summary'],
    queryFn: () => api<PatientSummaryCard>(`/patients/${patientId}/summary`),
  });
}

// ---------------------------------------------------------------------------
// Coding review
// ---------------------------------------------------------------------------

export function useCodingReviews() {
  return useQuery({
    queryKey: ['clinical', 'coding-reviews'],
    queryFn: () => api<CodingReviewItem[]>('/coding-reviews'),
  });
}

export function useAcknowledgeCodingReview() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({
      conditionId,
      body,
    }: {
      conditionId: string;
      body: z.input<typeof acknowledgeCodingReviewSchema>;
    }) => api(`/coding-reviews/${conditionId}/acknowledge`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}
