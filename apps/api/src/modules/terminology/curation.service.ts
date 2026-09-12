import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type {
  MapElementStatus,
  MapEquivalence,
  MapProvenance,
  ProposeMappingInput,
  ReviewMappingInput,
  ReviewQueueQuery,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { Db } from '../../db/client';
import { conceptMapElements, conceptMapReviews, conceptMaps, concepts } from '../../db/schema';
import type { Actor, RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const direct = (error as { code?: string } | null)?.code;
  const wrapped = (error as { cause?: { code?: string } } | null)?.cause?.code;
  return direct === UNIQUE_VIOLATION || wrapped === UNIQUE_VIOLATION;
}

/**
 * Mapping curation.
 *
 * The governance rules, each also enforced by the database as a backstop:
 *
 *   - Only proposed mappings can be reviewed; a decision is final.
 *   - The curator who proposed a mapping cannot approve or reject it.
 *   - A mapping's content never changes. A correction is a new proposal that
 *     supersedes the approved mapping, which is retired only when the
 *     correction itself is approved — so there is never a moment when the
 *     code has no approved mapping because a correction is pending.
 *   - Every decision is written to an append-only history and the audit trail.
 */
@Injectable()
export class CurationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Terminology is not tenant-scoped; see TerminologyService.reference. */
  private get reference(): Db {
    return this.database.raw;
  }

  async queue(actor: Actor, query: ReviewQueueQuery) {
    const offset = (query.page - 1) * query.limit;

    const rows = await this.reference.execute<{
      id: string;
      source_code: string;
      target_code: string | null;
      equivalence: MapEquivalence;
      confidence: number | null;
      comment: string | null;
      status: MapElementStatus;
      provenance: MapProvenance;
      proposed_by_staff_id: string | null;
      supersedes_element_id: string | null;
      created_at: string;
      map_id: string;
      map_key: string;
      map_version: string;
      map_name: string;
      experimental: boolean;
      source_key: string;
      target_key: string;
      source_display: string | null;
      target_display: string | null;
      proposed_by: string | null;
      total: string;
    }>(sql`
      SELECT e.id, e.source_code, e.target_code, e.equivalence, e.confidence, e.comment,
             e.status, e.provenance, e.proposed_by_staff_id, e.supersedes_element_id,
             e.created_at,
             m.id AS map_id, m.key AS map_key, m.version AS map_version, m.name AS map_name,
             (m.experimental OR s.experimental OR t.experimental) AS experimental,
             s.key AS source_key, t.key AS target_key,
             sc.display AS source_display, tc.display AS target_display,
             (SELECT r.actor_label FROM concept_map_review r
               WHERE r.element_id = e.id AND r.action IN ('import', 'propose')
            ORDER BY r.at ASC LIMIT 1) AS proposed_by,
             count(*) OVER () AS total
        FROM concept_map_element e
        JOIN concept_map m ON m.id = e.concept_map_id
        JOIN code_system s ON s.id = m.source_system_id
        JOIN code_system t ON t.id = m.target_system_id
   LEFT JOIN concept sc ON sc.code_system_id = s.id AND sc.code = e.source_code
   LEFT JOIN concept tc ON tc.code_system_id = t.id AND tc.code = e.target_code
       WHERE e.status = ${query.status}::map_element_status
         AND (${query.conceptMapId ?? null}::uuid IS NULL OR m.id = ${query.conceptMapId ?? null}::uuid)
    ORDER BY m.key, e.source_code, e.created_at
       LIMIT ${query.limit} OFFSET ${offset}
    `);

    return {
      total: rows.length > 0 ? Number(rows[0]?.total ?? 0) : 0,
      results: rows.map((row) => ({
        id: row.id,
        map: { id: row.map_id, key: row.map_key, version: row.map_version, name: row.map_name },
        source: { system: row.source_key, code: row.source_code, display: row.source_display },
        target: row.target_code
          ? { system: row.target_key, code: row.target_code, display: row.target_display }
          : null,
        equivalence: row.equivalence,
        confidence: row.confidence === null ? null : Number(row.confidence),
        comment: row.comment,
        status: row.status,
        provenance: row.provenance,
        proposedBy: row.proposed_by,
        supersedesElementId: row.supersedes_element_id,
        experimental: row.experimental,
        createdAt: new Date(row.created_at).toISOString(),
        // Computed for the interface, and enforced again on submission.
        canReview: row.status === 'proposed' && row.proposed_by_staff_id !== actor.staffUserId,
      })),
    };
  }

  async review(actor: Actor, elementId: string, input: ReviewMappingInput, meta: RequestMeta) {
    const label = `${actor.name} <${actor.email}>`;

    const result = await this.reference.transaction(async (tx) => {
      const [element] = await tx
        .select()
        .from(conceptMapElements)
        .where(eq(conceptMapElements.id, elementId))
        .for('update')
        .limit(1);

      if (!element) throw new NotFoundException('Mapping not found');

      if (element.status !== 'proposed') {
        throw new ConflictException(`This mapping has already been ${element.status}`);
      }

      if (element.proposedByStaffId === actor.staffUserId) {
        throw new ForbiddenException('You proposed this mapping. Another curator must review it.');
      }

      const now = new Date();

      if (input.decision === 'approve') {
        if (element.supersedesElementId) {
          const [previous] = await tx
            .select()
            .from(conceptMapElements)
            .where(eq(conceptMapElements.id, element.supersedesElementId))
            .for('update')
            .limit(1);

          if (!previous || previous.status !== 'approved') {
            throw new ConflictException(
              'The mapping this corrects is no longer approved. Propose the correction again against the current mapping.',
            );
          }

          await tx
            .update(conceptMapElements)
            .set({ status: 'retired', updatedAt: now })
            .where(eq(conceptMapElements.id, previous.id));

          await tx.insert(conceptMapReviews).values({
            elementId: previous.id,
            action: 'retire',
            staffId: actor.staffUserId,
            actorLabel: label,
            comment: `Superseded by an approved correction: ${input.comment}`,
          });
        }

        // Checked after any retirement above, so a correction of the same pair
        // does not collide with the mapping it is replacing.
        const [clash] = await tx
          .select({ id: conceptMapElements.id })
          .from(conceptMapElements)
          .where(
            and(
              eq(conceptMapElements.conceptMapId, element.conceptMapId),
              eq(conceptMapElements.sourceCode, element.sourceCode),
              element.targetCode === null
                ? isNull(conceptMapElements.targetCode)
                : eq(conceptMapElements.targetCode, element.targetCode),
              eq(conceptMapElements.status, 'approved'),
            ),
          )
          .limit(1);

        if (clash) {
          throw new ConflictException(
            'An approved mapping for this pair already exists. Propose the change as a correction that supersedes it.',
          );
        }
      }

      const status = input.decision === 'approve' ? ('approved' as const) : ('rejected' as const);

      await tx
        .update(conceptMapElements)
        .set({
          status,
          reviewedByStaffId: actor.staffUserId,
          reviewedAt: now,
          reviewComment: input.comment,
          updatedAt: now,
        })
        .where(eq(conceptMapElements.id, element.id));

      await tx.insert(conceptMapReviews).values({
        elementId: element.id,
        action: input.decision,
        staffId: actor.staffUserId,
        actorLabel: label,
        comment: input.comment,
      });

      return {
        id: element.id,
        status,
        retiredElementId: status === 'approved' ? element.supersedesElementId : null,
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'concept_map_element',
      resourceId: elementId,
      action: 'update',
      meta,
    });

    return result;
  }

  async propose(actor: Actor, input: ProposeMappingInput, meta: RequestMeta) {
    const label = `${actor.name} <${actor.email}>`;

    let created: { id: string };

    try {
      created = await this.reference.transaction(async (tx) => {
        const [map] = await tx
          .select()
          .from(conceptMaps)
          .where(eq(conceptMaps.id, input.conceptMapId))
          .limit(1);

        if (!map) throw new NotFoundException('Concept map not found');

        const [source] = await tx
          .select({ id: concepts.id })
          .from(concepts)
          .where(
            and(eq(concepts.codeSystemId, map.sourceSystemId), eq(concepts.code, input.sourceCode)),
          )
          .limit(1);

        if (!source) {
          throw new BadRequestException(
            `${input.sourceCode} is not in this map's source code system`,
          );
        }

        if (input.targetCode !== null) {
          const [target] = await tx
            .select({ id: concepts.id })
            .from(concepts)
            .where(
              and(
                eq(concepts.codeSystemId, map.targetSystemId),
                eq(concepts.code, input.targetCode),
              ),
            )
            .limit(1);

          if (!target) {
            throw new BadRequestException(
              `${input.targetCode} is not in this map's target code system`,
            );
          }
        }

        if (input.supersedesElementId) {
          const [previous] = await tx
            .select()
            .from(conceptMapElements)
            .where(eq(conceptMapElements.id, input.supersedesElementId))
            .limit(1);

          if (
            !previous ||
            previous.conceptMapId !== map.id ||
            previous.sourceCode !== input.sourceCode
          ) {
            throw new BadRequestException(
              'A correction must supersede a mapping for the same source code in the same map',
            );
          }

          if (previous.status !== 'approved') {
            throw new BadRequestException('Only an approved mapping can be superseded');
          }
        }

        const [row] = await tx
          .insert(conceptMapElements)
          .values({
            conceptMapId: map.id,
            sourceCode: input.sourceCode,
            targetCode: input.targetCode,
            equivalence: input.equivalence,
            confidence: input.confidence ?? null,
            comment: input.comment,
            status: 'proposed',
            provenance: 'curated',
            proposedByStaffId: actor.staffUserId,
            supersedesElementId: input.supersedesElementId ?? null,
          })
          .returning({ id: conceptMapElements.id });

        if (!row) throw new Error('Failed to record the proposal');

        await tx.insert(conceptMapReviews).values({
          elementId: row.id,
          action: 'propose',
          staffId: actor.staffUserId,
          actorLabel: label,
          comment: input.comment,
        });

        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('An identical mapping is already awaiting review');
      }
      throw error;
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'concept_map_element',
      resourceId: created.id,
      action: 'create',
      meta,
    });

    return { id: created.id, status: 'proposed' as const };
  }

  async history(elementId: string) {
    const [element] = await this.reference
      .select({ id: conceptMapElements.id })
      .from(conceptMapElements)
      .where(eq(conceptMapElements.id, elementId))
      .limit(1);

    if (!element) throw new NotFoundException('Mapping not found');

    const rows = await this.reference
      .select({
        action: conceptMapReviews.action,
        actorLabel: conceptMapReviews.actorLabel,
        comment: conceptMapReviews.comment,
        at: conceptMapReviews.at,
      })
      .from(conceptMapReviews)
      .where(eq(conceptMapReviews.elementId, elementId))
      .orderBy(asc(conceptMapReviews.at));

    return rows.map((row) => ({ ...row, at: row.at.toISOString() }));
  }

  /**
   * How much of each source vocabulary has been reviewed.
   *
   * `unreviewed` is the number that matters operationally: source codes with
   * no approved mapping of any kind, including no approved "unmatched". Those
   * are the codes for which auto-coding can only ever say "not yet reviewed".
   */
  async coverage() {
    const rows = await this.reference.execute<{
      id: string;
      key: string;
      version: string;
      name: string;
      experimental: boolean;
      review_policy: string;
      source_concepts: string;
      approved_sources: string;
      mapped: string;
      reviewed_unmatched: string;
      awaiting_review: string;
      rejected: string;
    }>(sql`
      SELECT m.id, m.key, m.version, m.name, m.experimental, m.review_policy,
             (SELECT count(*) FROM concept c WHERE c.code_system_id = m.source_system_id) AS source_concepts,
             count(DISTINCT e.source_code) FILTER (WHERE e.status = 'approved') AS approved_sources,
             count(DISTINCT e.source_code) FILTER (WHERE e.status = 'approved' AND e.equivalence <> 'unmatched') AS mapped,
             count(DISTINCT e.source_code) FILTER (WHERE e.status = 'approved' AND e.equivalence = 'unmatched') AS reviewed_unmatched,
             count(*) FILTER (WHERE e.status = 'proposed') AS awaiting_review,
             count(*) FILTER (WHERE e.status = 'rejected') AS rejected
        FROM concept_map m
   LEFT JOIN concept_map_element e ON e.concept_map_id = m.id
    GROUP BY m.id
    ORDER BY m.key, m.version
    `);

    return rows.map((row) => {
      const sourceConcepts = Number(row.source_concepts);
      const approvedSources = Number(row.approved_sources);

      return {
        conceptMap: { id: row.id, key: row.key, version: row.version, name: row.name },
        experimental: row.experimental,
        reviewPolicy: row.review_policy,
        sourceConcepts,
        mapped: Number(row.mapped),
        reviewedUnmatched: Number(row.reviewed_unmatched),
        unreviewed: Math.max(0, sourceConcepts - approvedSources),
        awaitingReview: Number(row.awaiting_review),
        rejected: Number(row.rejected),
      };
    });
  }
}
