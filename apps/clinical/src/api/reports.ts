import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DataQualityReport,
  DiagnosisReport,
  FootfallReport,
  PrescriptionReport,
  ReportRange,
  RevenueReport,
  StatutoryReturn,
  StatutoryReturnList,
  SubmitReturnInput,
} from '@health24/shared';
import { api } from './client';

/**
 * The hospital's own numbers (sp6-plan.md, Phase 8).
 *
 * Under their own cache key: a report is counted from the record but is not
 * part of it, and recording a diagnosis has no business refetching a year's
 * footfall. The period is part of every key, so moving the dates is a fresh
 * question rather than a stale answer.
 */

const REPORTS = ['reports'] as const;

const period = (range: ReportRange) => `from=${range.from}&to=${range.to}`;

export function useFootfall(range: ReportRange, by: 'class' | 'system' | 'clinician') {
  return useQuery({
    queryKey: [...REPORTS, 'footfall', range, by],
    queryFn: () => api<FootfallReport>(`/reports/footfall?${period(range)}&by=${by}`),
  });
}

export function useDiagnosisReport(range: ReportRange) {
  return useQuery({
    queryKey: [...REPORTS, 'diagnoses', range],
    queryFn: () => api<DiagnosisReport>(`/reports/diagnoses?${period(range)}`),
  });
}

export function usePrescriptionReport(range: ReportRange) {
  return useQuery({
    queryKey: [...REPORTS, 'prescriptions', range],
    queryFn: () => api<PrescriptionReport>(`/reports/prescriptions?${period(range)}`),
  });
}

export function useRevenueReport(range: ReportRange) {
  return useQuery({
    queryKey: [...REPORTS, 'revenue', range],
    queryFn: () => api<RevenueReport>(`/reports/revenue?${period(range)}`),
  });
}

export function useDataQuality() {
  return useQuery({
    queryKey: [...REPORTS, 'data-quality'],
    queryFn: () => api<DataQualityReport>('/reports/data-quality'),
  });
}

// ---------------------------------------------------------------------------
// The statutory return (DF10)
// ---------------------------------------------------------------------------

const RETURNS = [...REPORTS, 'statutory'] as const;

export function useStatutoryReturns() {
  return useQuery({
    queryKey: [...RETURNS, 'list'],
    queryFn: () => api<StatutoryReturnList>('/statutory-returns'),
  });
}

export function useStatutoryReturn(returnId: string | null) {
  return useQuery({
    queryKey: [...RETURNS, returnId],
    queryFn: () => api<StatutoryReturn>(`/statutory-returns/${returnId!}`),
    enabled: returnId !== null,
  });
}

function useReturnWrite<TVariables>(request: (variables: TVariables) => Promise<StatutoryReturn>) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: RETURNS });
    },
  });
}

export function useGenerateReturn() {
  return useReturnWrite<ReportRange>((body) =>
    api<StatutoryReturn>('/statutory-returns', { method: 'POST', body }),
  );
}

export function useSubmitReturn() {
  return useReturnWrite<{ id: string; body: SubmitReturnInput }>(({ id, body }) =>
    api<StatutoryReturn>(`/statutory-returns/${id}/submit`, { method: 'POST', body }),
  );
}

/**
 * The return as a spreadsheet, which is how a ministry asks for one.
 *
 * Fetched through the same client as everything else — so it carries the
 * session, and the reading is audited — and handed to the browser as a file
 * rather than opened in a tab.
 */
export async function downloadReturnCsv(filed: StatutoryReturn): Promise<void> {
  const csv = await api<string>(`/statutory-returns/${filed.id}/csv`);
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `ayush-morbidity-${filed.periodFrom}-to-${filed.periodTo}.csv`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
