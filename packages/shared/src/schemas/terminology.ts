import { z } from 'zod';
import {
  CODING_ROLES,
  DESIGNATION_USES,
  MAP_ELEMENT_STATUSES,
  MAP_EQUIVALENCES,
  MAP_REVIEW_POLICIES,
} from '../enums.js';
import { paginationSchema, uuidSchema } from '../primitives.js';

/**
 * Keys of the code systems the auto-coding rules depend on.
 *
 * Internal keys rather than publishers' URIs, so the rules survive a change of
 * canonical identifier between releases — and so demo releases, which use
 * obviously fake URIs, exercise exactly the same code path as real ones.
 */
export const TERMINOLOGY_KEYS = {
  namaste: 'namaste',
  tm2: 'icd11-tm2',
  mms: 'icd11-mms',
} as const;

/** Stable internal key for a code system or map: `namaste`, `icd11-tm2`. */
export const terminologyKeySchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Must be lowercase letters, digits and hyphens');

/**
 * A code, exactly as its publisher issued it.
 *
 * Not normalised in any way. ICD-11 is licensed CC BY-ND, which forbids adapting
 * the codes — and more to the point, a code that has been "tidied" is a code
 * that no longer matches the one on the source document.
 */
export const conceptCodeSchema = z.string().min(1).max(64);

/** BCP 47-style language tag: `en`, `sa-Deva`, `sa-Latn`, `hi`. */
const languageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z]{4})?$/, 'Expected a language tag such as en, hi or sa-Deva');

// ---------------------------------------------------------------------------
// Canonical release formats, consumed by the import CLI
// ---------------------------------------------------------------------------

/**
 * A terminology release in Health24's canonical import format.
 *
 * Real NAMASTE and ICD-11 distributions arrive in their publishers' own formats.
 * Rather than teach the importer every one of those, each gets a small converter
 * to this shape, and the importer validates exactly one format.
 */
export const terminologyReleaseSchema = z
  .object({
    codeSystem: z.object({
      key: terminologyKeySchema,
      /** The publisher's canonical identifier, recorded as issued. */
      uri: z.string().min(1).max(500),
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(64),
      publisher: z.string().min(1).max(200),
      releasedAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      /** True for anything that must never be used on a real patient record. */
      experimental: z.boolean().default(false),
      licence: z.string().max(500).optional(),
      /** Citation text the licence requires to be shown alongside the codes. */
      attribution: z.string().max(1000).optional(),
    }),
    concepts: z
      .array(
        z.object({
          code: conceptCodeSchema,
          display: z.string().min(1).max(500),
          definition: z.string().max(4000).optional(),
          parentCode: conceptCodeSchema.optional(),
          designations: z
            .array(
              z.object({
                language: languageTagSchema,
                use: z.enum(DESIGNATION_USES),
                value: z.string().min(1).max(500),
              }),
            )
            .default([]),
        }),
      )
      .min(1),
  })
  .superRefine((release, ctx) => {
    const codes = new Set<string>();

    release.concepts.forEach((concept, index) => {
      if (codes.has(concept.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['concepts', index, 'code'],
          message: `Duplicate code ${concept.code}`,
        });
      }
      codes.add(concept.code);
    });

    // A parent that is not in the release would leave the hierarchy with a
    // dangling branch that no browser can reach.
    release.concepts.forEach((concept, index) => {
      if (concept.parentCode !== undefined && !codes.has(concept.parentCode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['concepts', index, 'parentCode'],
          message: `Parent ${concept.parentCode} is not in this release`,
        });
      }
    });
  });
export type TerminologyRelease = z.infer<typeof terminologyReleaseSchema>;

const mapTargetSchema = z.object({ key: terminologyKeySchema, version: z.string().min(1).max(64) });

export const conceptMapReleaseSchema = z
  .object({
    map: z.object({
      key: terminologyKeySchema,
      name: z.string().min(1).max(200),
      version: z.string().min(1).max(64),
      publisher: z.string().min(1).max(200),
      source: mapTargetSchema,
      target: mapTargetSchema,
      experimental: z.boolean().default(false),
      /**
       * Whether elements arrive approved or must pass a curator. Defaults to
       * review, so that forgetting to set it can only ever make a map more
       * cautious, never less.
       */
      reviewPolicy: z.enum(MAP_REVIEW_POLICIES).default('requires_review'),
      licence: z.string().max(500).optional(),
      attribution: z.string().max(1000).optional(),
    }),
    elements: z
      .array(
        z.object({
          sourceCode: conceptCodeSchema,
          targetCode: conceptCodeSchema.nullable().default(null),
          equivalence: z.enum(MAP_EQUIVALENCES),
          confidence: z.number().min(0).max(1).optional(),
          comment: z.string().max(1000).optional(),
        }),
      )
      .min(1),
  })
  .superRefine((release, ctx) => {
    const seen = new Set<string>();

    release.elements.forEach((element, index) => {
      if ((element.equivalence === 'unmatched') !== (element.targetCode === null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['elements', index, 'targetCode'],
          message:
            'A target code is required unless the equivalence is unmatched, and forbidden if it is',
        });
      }

      const pair = `${element.sourceCode}→${element.targetCode ?? ''}`;
      if (seen.has(pair)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['elements', index],
          message: `Duplicate mapping ${pair}`,
        });
      }
      seen.add(pair);
    });
  });
export type ConceptMapRelease = z.infer<typeof conceptMapReleaseSchema>;

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

export const terminologySearchSchema = z.object({
  system: terminologyKeySchema,
  q: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type TerminologySearchInput = z.infer<typeof terminologySearchSchema>;

export const translateQuerySchema = z.object({
  system: terminologyKeySchema,
  code: conceptCodeSchema,
  /** Restrict to one target system. Omitted, every approved map is used. */
  target: terminologyKeySchema.optional(),
});
export type TranslateQueryInput = z.infer<typeof translateQuerySchema>;

export const autoCodeSchema = z.object({
  /** The vocabulary the clinician selected from, normally `namaste`. */
  system: terminologyKeySchema,
  code: conceptCodeSchema,
});
export type AutoCodeInput = z.infer<typeof autoCodeSchema>;

export const designationSchema = z.object({
  language: z.string(),
  use: z.enum(DESIGNATION_USES),
  value: z.string(),
});

export const conceptSummarySchema = z.object({
  system: z.string(),
  systemVersion: z.string(),
  code: z.string(),
  display: z.string(),
  designations: z.array(designationSchema),
  /** Present on search results only. */
  score: z.number().optional(),
  experimental: z.boolean(),
});
export type ConceptSummary = z.infer<typeof conceptSummarySchema>;

/** A coding as it would be attached to a diagnosis. */
export const codingSchema = z.object({
  system: z.string(),
  systemVersion: z.string(),
  code: z.string(),
  display: z.string(),
  role: z.enum(CODING_ROLES),
  equivalence: z.enum(MAP_EQUIVALENCES).nullable(),
  confidence: z.number().nullable(),
  /** The approved mapping this coding rests on, so the decision can be traced. */
  conceptMapElementId: uuidSchema.nullable(),
});
export type Coding = z.infer<typeof codingSchema>;

export const autoCodeResultSchema = z.object({
  primary: codingSchema,
  translated: codingSchema.nullable(),
  advisory: codingSchema.nullable(),
  /** Plain-language explanations for anything not attached. */
  notes: z.array(z.string()),
});
export type AutoCodeResult = z.infer<typeof autoCodeResultSchema>;

// ---------------------------------------------------------------------------
// Curation
// ---------------------------------------------------------------------------

export const reviewQueueQuerySchema = paginationSchema.extend({
  conceptMapId: uuidSchema.optional(),
  status: z.enum(MAP_ELEMENT_STATUSES).default('proposed'),
});
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

export const reviewMappingSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  /** Required: a mapping decision with no stated reason cannot be audited. */
  comment: z.string().trim().min(3).max(1000),
});
export type ReviewMappingInput = z.infer<typeof reviewMappingSchema>;

export const proposeMappingSchema = z
  .object({
    conceptMapId: uuidSchema,
    sourceCode: conceptCodeSchema,
    targetCode: conceptCodeSchema.nullable(),
    equivalence: z.enum(MAP_EQUIVALENCES),
    confidence: z.number().min(0).max(1).optional(),
    comment: z.string().trim().min(3).max(1000),
    /** The approved element this corrects, when it is a correction. */
    supersedesElementId: uuidSchema.optional(),
  })
  .refine((value) => (value.equivalence === 'unmatched') === (value.targetCode === null), {
    message:
      'A target code is required unless the equivalence is unmatched, and forbidden if it is',
    path: ['targetCode'],
  });
export type ProposeMappingInput = z.infer<typeof proposeMappingSchema>;
