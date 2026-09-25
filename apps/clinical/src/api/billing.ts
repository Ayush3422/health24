import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  Catalogue,
  CatalogueCategory,
  CatalogueItem,
  catalogueItemInputSchema,
  captureChargeSchema,
  Charge,
  EncounterCharges,
  repriceItemSchema,
  retireItemSchema,
  voidChargeSchema,
} from '@health24/shared';
import { api } from './client';

/**
 * The catalogue and its charges (SP6 Phase 6).
 *
 * Under their own cache key rather than the clinical one: a bill is not a
 * clinical record, and recording a diagnosis has no reason to refetch it.
 */

const BILLING = ['billing'] as const;

export function useCatalogue(
  options: { category?: CatalogueCategory; q?: string; history?: boolean } = {},
) {
  return useQuery({
    queryKey: [...BILLING, 'catalogue', options],
    queryFn: () => {
      const query = new URLSearchParams();
      if (options.category) query.set('category', options.category);
      if (options.q) query.set('q', options.q);
      if (options.history) query.set('history', 'true');

      const search = query.toString();
      return api<Catalogue>(`/catalogue${search ? `?${search}` : ''}`);
    },
  });
}

export function useEncounterCharges(encounterId: string, enabled = true) {
  return useQuery({
    queryKey: [...BILLING, 'encounter', encounterId],
    queryFn: () => api<EncounterCharges>(`/encounters/${encounterId}/charges`),
    enabled,
  });
}

function useBillingWrite<TVariables, TResult>(
  request: (variables: TVariables) => Promise<TResult>,
) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: request,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: BILLING });
    },
  });
}

export function useAddCatalogueItem() {
  return useBillingWrite<z.input<typeof catalogueItemInputSchema>, CatalogueItem>((body) =>
    api<CatalogueItem>('/catalogue', { method: 'POST', body }),
  );
}

export function useRepriceItem() {
  return useBillingWrite<{ id: string; body: z.input<typeof repriceItemSchema> }, CatalogueItem>(
    ({ id, body }) => api<CatalogueItem>(`/catalogue/${id}/reprice`, { method: 'POST', body }),
  );
}

export function useRetireItem() {
  return useBillingWrite<{ id: string; body: z.input<typeof retireItemSchema> }, CatalogueItem>(
    ({ id, body }) => api<CatalogueItem>(`/catalogue/${id}/retire`, { method: 'POST', body }),
  );
}

export function useCaptureCharge() {
  return useBillingWrite<z.input<typeof captureChargeSchema>, Charge>((body) =>
    api<Charge>('/charges', { method: 'POST', body }),
  );
}

export function useVoidCharge() {
  return useBillingWrite<{ id: string; body: z.input<typeof voidChargeSchema> }, Charge>(
    ({ id, body }) => api<Charge>(`/charges/${id}/void`, { method: 'POST', body }),
  );
}
