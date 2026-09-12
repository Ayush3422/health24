import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AutoCodeResult,
  ConceptSummary,
  MapElementStatus,
  MapEquivalence,
  MapProvenance,
} from '@health24/shared';
import { api } from './client';

export interface CodeSystemInfo {
  id: string;
  key: string;
  name: string;
  version: string;
  publisher: string;
  status: 'draft' | 'active' | 'retired';
  experimental: boolean;
  licence: string | null;
  attribution: string | null;
  conceptCount: number;
}

export interface ConceptDetail {
  concept: Omit<ConceptSummary, 'score'> & { definition: string | null };
  parent: { code: string; display: string } | null;
  children: Array<{ code: string; display: string }>;
  codeSystem: {
    name: string;
    version: string;
    status: string;
    publisher: string;
    licence: string | null;
    attribution: string | null;
    experimental: boolean;
  };
}

export interface ReviewQueueItem {
  id: string;
  map: { id: string; key: string; version: string; name: string };
  source: { system: string; code: string; display: string | null };
  target: { system: string; code: string; display: string | null } | null;
  equivalence: MapEquivalence;
  confidence: number | null;
  comment: string | null;
  status: MapElementStatus;
  provenance: MapProvenance;
  proposedBy: string | null;
  supersedesElementId: string | null;
  experimental: boolean;
  createdAt: string;
  canReview: boolean;
}

export interface CoverageEntry {
  conceptMap: { id: string; key: string; version: string; name: string };
  experimental: boolean;
  reviewPolicy: string;
  sourceConcepts: number;
  mapped: number;
  reviewedUnmatched: number;
  unreviewed: number;
  awaitingReview: number;
  rejected: number;
}

export interface MappingHistoryEntry {
  action: 'import' | 'propose' | 'approve' | 'reject' | 'retire';
  actorLabel: string;
  comment: string | null;
  at: string;
}

/**
 * Plain-language equivalence, from the reader's side. "Wider" means the
 * target concept is broader than the source term, which is the sense a
 * clinician needs when deciding how much to trust it.
 */
export const EQUIVALENCE_LABELS: Record<MapEquivalence, string> = {
  equivalent: 'Equivalent',
  wider: 'Broader target',
  narrower: 'Narrower target',
  inexact: 'Inexact',
  unmatched: 'No correspondence',
};

const query = (params: Record<string, string | number | undefined>): string =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ).toString();

export function useCodeSystems() {
  return useQuery({
    queryKey: ['terminology', 'systems'],
    queryFn: () => api<CodeSystemInfo[]>('/terminology/systems'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useTerminologySearch(system: string, term: string) {
  const q = term.trim();

  return useQuery({
    queryKey: ['terminology', 'search', system, q],
    queryFn: () => api<ConceptSummary[]>(`/terminology/search?${query({ system, q, limit: 20 })}`),
    enabled: q.length > 0,
    // Keep showing the last results while the next keystroke's arrive, rather
    // than flashing an empty list on every character.
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useConcept(system: string, code: string | null) {
  return useQuery({
    queryKey: ['terminology', 'concept', system, code],
    queryFn: () =>
      api<ConceptDetail>(
        `/terminology/systems/${encodeURIComponent(system)}/concepts/${encodeURIComponent(code ?? '')}`,
      ),
    enabled: Boolean(code),
  });
}

export function useAutoCode(system: string, code: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['terminology', 'auto-code', system, code],
    queryFn: () =>
      api<AutoCodeResult>(`/terminology/auto-code?${query({ system, code: code ?? '' })}`),
    enabled: enabled && Boolean(code),
  });
}

export function useReviewQueue(status: MapElementStatus, page: number) {
  return useQuery({
    queryKey: ['terminology', 'review-queue', status, page],
    queryFn: () =>
      api<{ total: number; results: ReviewQueueItem[] }>(
        `/terminology/review-queue?${query({ status, page, limit: 20 })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useCoverage() {
  return useQuery({
    queryKey: ['terminology', 'coverage'],
    queryFn: () => api<CoverageEntry[]>('/terminology/coverage'),
  });
}

export function useMappingHistory(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['terminology', 'history', id],
    queryFn: () => api<MappingHistoryEntry[]>(`/terminology/map-elements/${id}/history`),
    enabled,
  });
}

export function useReviewMapping() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      decision,
      comment,
    }: {
      id: string;
      decision: 'approve' | 'reject';
      comment: string;
    }) =>
      api<{ id: string; status: string; retiredElementId: string | null }>(
        `/terminology/map-elements/${id}/review`,
        { method: 'POST', body: { decision, comment } },
      ),
    // A decision changes the queue, the coverage figures, and what auto-coding
    // attaches — so everything terminology-related is refetched.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['terminology'] }),
  });
}

export function useProposeMapping() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: {
      conceptMapId: string;
      sourceCode: string;
      targetCode: string | null;
      equivalence: MapEquivalence;
      comment: string;
      supersedesElementId?: string;
    }) =>
      api<{ id: string; status: 'proposed' }>('/terminology/map-elements', {
        method: 'POST',
        body,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['terminology'] }),
  });
}
