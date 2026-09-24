import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  advanceOrderSchema,
  cancelOrderSchema,
  OrderList,
  OrderSummary,
  placeOrderSchema,
  ServiceRequestCategory,
  ServiceRequestPriority,
  ServiceRequestStatus,
  Worklist,
} from '@health24/shared';
import { api } from './client';
import { useInvalidateClinical } from './clinical';

/**
 * Orders (SP6 Phase 2): what this hospital asked for, and how far the work
 * has got.
 *
 * Under the clinical cache key, because an order and the result that answers
 * it are the same story: typing the values closes the order, and both lists
 * have to change at once.
 */

export const ORDER_CATEGORY_LABELS: Record<ServiceRequestCategory, string> = {
  laboratory: 'Laboratory',
  imaging: 'Imaging',
  procedure: 'Procedure',
};

export const ORDER_STATUS_LABELS: Record<ServiceRequestStatus, string> = {
  ordered: 'Ordered',
  collected: 'Sample collected',
  in_progress: 'In progress',
  resulted: 'Resulted',
  cancelled: 'Cancelled',
};

export const ORDER_PRIORITY_LABELS: Record<ServiceRequestPriority, string> = {
  routine: 'Routine',
  urgent: 'Urgent',
};

export interface WorklistFilters {
  category?: ServiceRequestCategory;
  status?: ServiceRequestStatus;
  patientId?: string;
}

export function useEncounterOrders(encounterId: string) {
  return useQuery({
    queryKey: ['clinical', 'encounter', encounterId, 'orders'],
    queryFn: () => api<OrderSummary[]>(`/encounters/${encounterId}/orders`),
  });
}

export function usePatientOrders(patientId: string) {
  return useQuery({
    queryKey: ['clinical', 'patient', patientId, 'orders'],
    queryFn: () => api<OrderList>(`/patients/${patientId}/orders`),
  });
}

/** The lab's and the radiology desk's list: outstanding work, urgent first. */
export function useOrderWorklist(filters: WorklistFilters) {
  return useQuery({
    queryKey: ['clinical', 'orders', 'worklist', filters],
    queryFn: () => {
      const query = new URLSearchParams();
      if (filters.category) query.set('category', filters.category);
      if (filters.status) query.set('status', filters.status);
      if (filters.patientId) query.set('patientId', filters.patientId);

      const search = query.toString();
      return api<Worklist>(`/orders${search ? `?${search}` : ''}`);
    },
    // A worklist is read while other people are working through it.
    refetchInterval: 60_000,
  });
}

export function usePlaceOrder() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: (body: z.input<typeof placeOrderSchema>) =>
      api<OrderSummary>('/orders', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useAdvanceOrder() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof advanceOrderSchema> }) =>
      api<OrderSummary>(`/orders/${id}/advance`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useCancelOrder() {
  const invalidate = useInvalidateClinical();

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: z.input<typeof cancelOrderSchema> }) =>
      api<OrderSummary>(`/orders/${id}/cancel`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

/** Refetches the worklist alone, for a change that cannot touch a record. */
export function useRefreshWorklist(): () => Promise<void> {
  const client = useQueryClient();

  return async () => {
    await client.invalidateQueries({ queryKey: ['clinical', 'orders', 'worklist'] });
  };
}
