import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  AcknowledgeCodingReviewInput,
  AutoCodeResult,
  Coding,
  CodingReviewItem,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { codingReviewAcknowledgements } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { TerminologyService } from '../terminology/terminology.service';
import { toIso, violatedConstraint } from './clinical-access';

type ReviewRow = {
  condition_id: string;
  encounter_id: string;
  patient_id: string;
  patient_name: string | null;
  mrn: string | null;
  recorded_at: string | Date;
  mapping_status: string;
  flagged_role: Coding['role'];
  flagged_system: string;
  flagged_version: string;
  flagged_code: string;
  flagged_display: string;
  flagged_equivalence: Coding['equivalence'];
  flagged_confidence: number | null;
  flagged_element_id: string;
  primary_system: string;
  primary_version: string;
  primary_code: string;
  primary_display: string;
};

/**
 * Diagnoses whose attached codes rest on mappings that have since been retired
 * or rejected — the follow-up sp2-plan.md deferred to SP3.
 *
 * Worked out by query rather than by a background job: the question "which
 * current diagnoses rest on a mapping that is no longer approved" has one
 * answer at any moment, and computing it when asked cannot fall behind the way
 * a job's copy can. A clinician either keeps the code as recorded, with a note,
 * or corrects the diagnosis, which re-codes it and takes it off the list.
 */
@Injectable()
export class CodingReviewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly terminology: TerminologyService,
  ) {}

  async queue(actor: Actor, meta: RequestMeta): Promise<CodingReviewItem[]> {
    const hospitalId = requireHospital(actor);

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      const found = await tx.execute<ReviewRow>(sql`
        SELECT c."id" AS condition_id, c."encounter_id", c."patient_id",
               p."name" AS patient_name, l."mrn", c."recorded_at",
               e."status"::text AS mapping_status,
               cc."role" AS flagged_role, cc."code_system_key" AS flagged_system,
               cc."code_system_version" AS flagged_version, cc."code" AS flagged_code,
               cc."display" AS flagged_display, cc."equivalence" AS flagged_equivalence,
               cc."confidence" AS flagged_confidence,
               cc."concept_map_element_id" AS flagged_element_id,
               pr."code_system_key" AS primary_system, pr."code_system_version" AS primary_version,
               pr."code" AS primary_code, pr."display" AS primary_display
          FROM "condition" c
          JOIN "condition_coding" cc
            ON cc."condition_id" = c."id" AND cc."concept_map_element_id" IS NOT NULL
          JOIN "concept_map_element" e ON e."id" = cc."concept_map_element_id"
          JOIN "condition_coding" pr ON pr."condition_id" = c."id" AND pr."role" = 'primary'
          LEFT JOIN "patient" p ON p."id" = c."patient_id"
          LEFT JOIN "patient_hospital_link" l
                 ON l."patient_id" = c."patient_id" AND l."hospital_id" = ${hospitalId}::uuid
         WHERE c."hospital_id" = ${hospitalId}::uuid
           AND c."version_status" = 'current'
           AND e."status" IN ('retired', 'rejected')
           AND NOT EXISTS (
             SELECT 1 FROM "coding_review_acknowledgement" a
              WHERE a."condition_id" = c."id"
                AND a."concept_map_element_id" = cc."concept_map_element_id"
           )
      ORDER BY c."recorded_at" DESC
         LIMIT 200
      `);

      return [...found];
    });

    // Today's auto-coding for each distinct term, looked up once.
    const suggestions = new Map<string, AutoCodeResult | null>();

    for (const row of rows) {
      const key = `${row.primary_system}|${row.primary_code}`;
      if (suggestions.has(key)) continue;

      try {
        suggestions.set(
          key,
          await this.terminology.autoCode({ system: row.primary_system, code: row.primary_code }),
        );
      } catch {
        // The term's vocabulary may have no active release any more.
        suggestions.set(key, null);
      }
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'coding_review',
      action: 'search',
      meta,
    });

    return rows.map((row) => ({
      conditionId: row.condition_id,
      encounterId: row.encounter_id,
      patient: { id: row.patient_id, name: row.patient_name, mrn: row.mrn },
      recordedAt: toIso(row.recorded_at),
      primary: {
        system: row.primary_system,
        systemVersion: row.primary_version,
        code: row.primary_code,
        display: row.primary_display,
        role: 'primary',
        equivalence: null,
        confidence: null,
        conceptMapElementId: null,
      },
      flagged: {
        system: row.flagged_system,
        systemVersion: row.flagged_version,
        code: row.flagged_code,
        display: row.flagged_display,
        role: row.flagged_role,
        equivalence: row.flagged_equivalence,
        confidence: row.flagged_confidence,
        conceptMapElementId: row.flagged_element_id,
        mappingStatus: row.mapping_status,
      },
      suggestion: suggestions.get(`${row.primary_system}|${row.primary_code}`) ?? null,
    }));
  }

  /** Keeps the diagnosis's code as recorded, with the reason, and takes it off the list. */
  async acknowledge(
    actor: Actor,
    conditionId: string,
    input: AcknowledgeCodingReviewInput,
    meta: RequestMeta,
  ): Promise<{ conditionId: string; conceptMapElementId: string }> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const [flagged] = await tx.execute<{ patient_id: string }>(sql`
        SELECT c."patient_id"
          FROM "condition" c
          JOIN "condition_coding" cc ON cc."condition_id" = c."id"
          JOIN "concept_map_element" e ON e."id" = cc."concept_map_element_id"
         WHERE c."id" = ${conditionId}::uuid
           AND c."hospital_id" = ${hospitalId}::uuid
           AND c."version_status" = 'current'
           AND cc."concept_map_element_id" = ${input.conceptMapElementId}::uuid
           AND e."status" IN ('retired', 'rejected')
      `);

      if (!flagged) {
        throw new NotFoundException('That diagnosis is not awaiting coding review');
      }

      try {
        await tx.insert(codingReviewAcknowledgements).values({
          conditionId,
          hospitalId,
          conceptMapElementId: input.conceptMapElementId,
          note: input.note,
          acknowledgedByStaffId: actor.staffUserId,
        });
      } catch (error) {
        if (violatedConstraint(error) === 'coding_review_acknowledgement_once') {
          throw new ConflictException('This coding has already been reviewed');
        }
        throw error;
      }

      return flagged.patient_id;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'coding_review',
      resourceId: conditionId,
      patientId,
      action: 'create',
      meta,
    });

    return { conditionId, conceptMapElementId: input.conceptMapElementId };
  }
}
