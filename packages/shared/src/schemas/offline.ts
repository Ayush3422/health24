import { z } from 'zod';

/**
 * The read-only offline cache (sp3-plan.md, decision S1): what may be cached,
 * and how a view made offline is reported once the connection returns.
 *
 * Shared, because the client decides what to cache from this list and the
 * server decides what an uploaded view means from the same list — a path the
 * client could never have cached is a path the server refuses to record.
 */

/** A cached entry older than this is not shown, and a view older than this is not accepted. */
export const OFFLINE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface OfflineRead {
  /** As the same read is audited online. */
  resourceType: string;
  action: 'read' | 'search';
  patientId: string | null;
  resourceId: string | null;
  /** Clinical data, as opposed to the registry: needs `clinical:read`. */
  clinical: boolean;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const PATIENT_PARTS: Record<string, string> = {
  summary: 'patient_summary',
  allergies: 'allergy_intolerance',
  problems: 'condition',
  medications: 'medication_request',
  vitals: 'observation',
};

/**
 * Today's worklist, and for each patient opened: the registry record, summary
 * card, allergies, active problems, current medicines and recent vitals. Not
 * the full history, not notes, not documents.
 */
const RULES: Array<{ pattern: RegExp; describe: (match: RegExpMatchArray) => OfflineRead }> = [
  {
    pattern: /^\/encounters\?date=\d{4}-\d{2}-\d{2}&limit=100$/,
    describe: () => ({
      resourceType: 'encounter',
      action: 'search',
      patientId: null,
      resourceId: null,
      clinical: true,
    }),
  },
  {
    pattern: new RegExp(`^/encounters/(${UUID})$`, 'i'),
    describe: (match) => ({
      resourceType: 'encounter',
      action: 'read',
      patientId: null,
      resourceId: match[1]!.toLowerCase(),
      clinical: true,
    }),
  },
  {
    pattern: new RegExp(`^/patients/(${UUID})$`, 'i'),
    describe: (match) => ({
      resourceType: 'patient',
      action: 'read',
      patientId: match[1]!.toLowerCase(),
      resourceId: match[1]!.toLowerCase(),
      clinical: false,
    }),
  },
  {
    pattern: new RegExp(
      `^/patients/(${UUID})/(summary|allergies|problems|medications|vitals)$`,
      'i',
    ),
    describe: (match) => ({
      resourceType: PATIENT_PARTS[match[2]!]!,
      action: 'read',
      patientId: match[1]!.toLowerCase(),
      resourceId: null,
      clinical: true,
    }),
  },
];

/** What a read of this API path is, when it is one the offline cache may hold; otherwise null. */
export function describeOfflineRead(path: string): OfflineRead | null {
  for (const rule of RULES) {
    const match = path.match(rule.pattern);
    if (match) return rule.describe(match);
  }

  return null;
}

export const offlineViewsSchema = z.object({
  views: z
    .array(
      z.object({
        /** The API path, as the client requested it: `/patients/…/allergies`. */
        path: z.string().min(1).max(300),
        /** When the device showed it. */
        viewedAt: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(500),
});
export type OfflineViewsInput = z.infer<typeof offlineViewsSchema>;

export const offlineViewsResultSchema = z.object({
  recorded: z.number().int(),
  /** Views that name no cacheable read, a patient or encounter this hospital cannot see, or an implausible time. */
  rejected: z.number().int(),
});
export type OfflineViewsResult = z.infer<typeof offlineViewsResultSchema>;
