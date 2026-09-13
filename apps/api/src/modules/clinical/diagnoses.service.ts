import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import type {
  AutoCodeResult,
  Coding,
  ConditionSummary,
  ProblemList,
  RecordDiagnosisInput,
  RecordedDiagnosis,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { conditionCodings, conditions, encounters } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { TerminologyService } from '../terminology/terminology.service';
import {
  blankToNull,
  coveringConsentId,
  requireLinkedPatient,
  resolveAttribution,
  toIso,
  violatedConstraint,
} from './clinical-access';
import { demoTerminologyAllowed } from './demo-terminology';

type ConditionRow = {
  id: string;
  patient_id: string;
  encounter_id: string;
  hospital_id: string;
  hospital_name: string | null;
  clinical_status: ConditionSummary['clinicalStatus'];
  verification_status: ConditionSummary['verificationStatus'];
  is_primary: boolean;
  onset_date: string | null;
  note: string | null;
  recorded_at: string | Date;
  recorded_by_staff_id: string;
  recorded_by_name: string | null;
  entry_source: ConditionSummary['entry']['source'];
  entered_by_staff_id: string;
  entered_by_name: string | null;
  codings: Coding[];
};

/**
 * A diagnosis with its codings, gathered in one query. The codings subquery
 * is subject to row-level security like everything else: a coding is visible
 * exactly when its diagnosis is.
 */
const CONDITION_SELECT = sql`
  SELECT c."id", c."patient_id", c."encounter_id", c."hospital_id",
         d."name" AS hospital_name, c."clinical_status", c."verification_status",
         c."is_primary", to_char(c."onset_date", 'YYYY-MM-DD') AS onset_date, c."note",
         c."recorded_at",
         c."attributed_clinician_id" AS recorded_by_staff_id, s."name" AS recorded_by_name,
         c."entry_source", c."recorded_by_staff_id" AS entered_by_staff_id,
         eb."name" AS entered_by_name,
         coalesce((
           SELECT json_agg(json_build_object(
                    'role', cc."role",
                    'system', cc."code_system_key",
                    'systemVersion', cc."code_system_version",
                    'code', cc."code",
                    'display', cc."display",
                    'equivalence', cc."equivalence",
                    'confidence', cc."confidence",
                    'conceptMapElementId', cc."concept_map_element_id"
                  ))
             FROM "condition_coding" cc
            WHERE cc."condition_id" = c."id"
         ), '[]'::json) AS codings
    FROM "condition" c
    LEFT JOIN "hospital_directory" d ON d."id" = c."hospital_id"
    LEFT JOIN "staff_user" s ON s."id" = c."attributed_clinician_id"
    LEFT JOIN "staff_user" eb ON eb."id" = c."recorded_by_staff_id"
`;

/**
 * Diagnoses: the product's differentiator reaching a patient's record.
 *
 * A vaidya selects a NAMASTE term; the diagnosis stores that selection, its
 * approved TM2 translation, and any approved advisory biomedical code — as
 * they stood at that moment. The codings are written once, in the same
 * transaction as the diagnosis, and never re-derived: when a mapping is later
 * corrected, the record still shows what the clinician was shown.
 */
@Injectable()
export class DiagnosesService {
  private readonly allowDemoTerminology: boolean;

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly terminology: TerminologyService,
    config: ConfigService,
  ) {
    this.allowDemoTerminology = demoTerminologyAllowed({
      NODE_ENV: config.get<string>('NODE_ENV'),
      ALLOW_DEMO_TERMINOLOGY: config.get<string>('ALLOW_DEMO_TERMINOLOGY'),
    });
  }

  async record(
    actor: Actor,
    input: RecordDiagnosisInput,
    meta: RequestMeta,
  ): Promise<RecordedDiagnosis> {
    const hospitalId = requireHospital(actor);

    const encounter = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx
        .select({
          hospitalId: encounters.hospitalId,
          patientId: encounters.patientId,
          status: encounters.status,
        })
        .from(encounters)
        .where(eq(encounters.id, input.encounterId))
        .limit(1);

      return found;
    });

    if (!encounter) throw new NotFoundException('Encounter not found');

    if (encounter.hospitalId !== hospitalId) {
      throw new ForbiddenException(
        'A diagnosis is recorded against one of your own hospital’s encounters',
      );
    }

    if (encounter.status === 'cancelled') {
      throw new ConflictException('This encounter was cancelled; open a new one');
    }

    const coded = await this.autoCode(input.system, input.code);

    if (!this.allowDemoTerminology && (await this.terminology.usesExperimentalTerminology(coded))) {
      throw new UnprocessableEntityException(
        'Demo terminology cannot be used on a patient record. Load a licensed release.',
      );
    }

    let conditionId: string;

    try {
      conditionId = await this.db.asTenant(hospitalId, async (tx) => {
        const attribution = await resolveAttribution(
          tx,
          actor,
          hospitalId,
          input.onBehalfOfClinicianId,
        );

        const [created] = await tx
          .insert(conditions)
          .values({
            patientId: encounter.patientId,
            hospitalId,
            encounterId: input.encounterId,
            clinicalStatus: input.clinicalStatus,
            verificationStatus: input.verificationStatus,
            isPrimary: input.isPrimary,
            onsetDate: input.onsetDate ?? null,
            note: blankToNull(input.note),
            recordedByStaffId: actor.staffUserId,
            attributedClinicianId: attribution.clinicianId,
            entrySource: attribution.entrySource,
          })
          .returning({ id: conditions.id });

        if (!created) throw new Error('Failed to record the diagnosis');

        const attached = [coded.primary, coded.translated, coded.advisory].filter(
          (coding): coding is Coding => coding !== null,
        );

        await tx.insert(conditionCodings).values(
          attached.map((coding) => ({
            conditionId: created.id,
            role: coding.role,
            codeSystemKey: coding.system,
            codeSystemVersion: coding.systemVersion,
            code: coding.code,
            display: coding.display,
            equivalence: coding.equivalence,
            confidence: coding.confidence,
            conceptMapElementId: coding.conceptMapElementId,
          })),
        );

        return created.id;
      });
    } catch (error) {
      if (violatedConstraint(error) === 'condition_one_primary_per_encounter') {
        throw new ConflictException('This encounter already has a primary diagnosis');
      }

      throw error;
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'condition',
      resourceId: conditionId,
      patientId: encounter.patientId,
      action: 'create',
      meta,
    });

    const [row] = await this.db.asTenant(hospitalId, (tx) =>
      this.query(tx, sql`WHERE c."id" = ${conditionId}::uuid`),
    );

    if (!row) throw new Error('Recorded diagnosis is not readable');

    return { ...this.toSummary(row, hospitalId), codingNotes: coded.notes };
  }

  /** Every current diagnosis on one encounter the caller may see. */
  async forEncounter(
    actor: Actor,
    encounterId: string,
    meta: RequestMeta,
  ): Promise<ConditionSummary[]> {
    const hospitalId = requireHospital(actor);

    const { rows, patientId, consentArtefactId } = await this.db.asTenant(
      hospitalId,
      async (tx) => {
        const [encounter] = await tx
          .select({ patientId: encounters.patientId, hospitalId: encounters.hospitalId })
          .from(encounters)
          .where(eq(encounters.id, encounterId))
          .limit(1);

        if (!encounter) throw new NotFoundException('Encounter not found');

        const found = await this.query(
          tx,
          sql`WHERE c."encounter_id" = ${encounterId}::uuid AND c."version_status" = 'current'
           ORDER BY c."is_primary" DESC, c."recorded_at" ASC`,
        );

        return {
          rows: found,
          patientId: encounter.patientId,
          consentArtefactId:
            encounter.hospitalId !== hospitalId && found.length > 0
              ? await coveringConsentId(tx, encounter.patientId, 'diagnoses')
              : null,
        };
      },
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'condition',
      resourceId: encounterId,
      patientId,
      action: 'read',
      consentArtefactId,
      meta,
    });

    return rows.map((row) => this.toSummary(row, hospitalId));
  }

  /** The problem list: active diagnoses from every record the caller may see. */
  async problemList(actor: Actor, patientId: string, meta: RequestMeta): Promise<ProblemList> {
    const hospitalId = requireHospital(actor);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await this.query(
        tx,
        sql`WHERE c."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
             AND c."version_status" = 'current'
             AND c."clinical_status" = 'active'
        ORDER BY c."recorded_at" DESC`,
      );

      return {
        rows: found,
        consentArtefactId: await coveringConsentId(tx, patientId, 'diagnoses'),
      };
    });

    const sharedRows = rows.some((row) => row.hospital_id !== hospitalId);

    await this.audit.recordForActor(actor, {
      resourceType: 'condition',
      patientId,
      action: 'read',
      consentArtefactId: sharedRows ? consentArtefactId : null,
      meta,
    });

    return {
      problems: rows.map((row) => this.toSummary(row, hospitalId)),
      sharedFromOtherHospitals: consentArtefactId !== null,
    };
  }

  /**
   * A code the terminology service cannot resolve is the client's mistake —
   * a wrong code or an inactive system — so it is a 400 here, not a 404.
   */
  private async autoCode(system: string, code: string): Promise<AutoCodeResult> {
    try {
      return await this.terminology.autoCode({ system, code });
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new BadRequestException(error.message);
      }

      throw error;
    }
  }

  private async query(tx: DbTransaction, tail: ReturnType<typeof sql>): Promise<ConditionRow[]> {
    const rows = await tx.execute<ConditionRow>(sql`${CONDITION_SELECT} ${tail}`);
    return [...rows];
  }

  private toSummary(row: ConditionRow, hospitalId: string): ConditionSummary {
    const byRole = (role: Coding['role']) =>
      row.codings.find((coding) => coding.role === role) ?? null;

    const primary = byRole('primary');

    if (!primary) {
      // The primary coding is written in the same transaction as the
      // diagnosis; its absence means the record is corrupt, not incomplete.
      throw new Error(`Diagnosis ${row.id} has no primary coding`);
    }

    return {
      id: row.id,
      patientId: row.patient_id,
      encounterId: row.encounter_id,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      clinicalStatus: row.clinical_status,
      verificationStatus: row.verification_status,
      isPrimary: row.is_primary,
      onsetDate: row.onset_date,
      note: row.note,
      recordedAt: toIso(row.recorded_at),
      recordedBy: { id: row.recorded_by_staff_id, name: row.recorded_by_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.entered_by_staff_id, name: row.entered_by_name },
      },
      codings: {
        primary,
        translated: byRole('translated'),
        advisory: byRole('advisory'),
      },
    };
  }
}
