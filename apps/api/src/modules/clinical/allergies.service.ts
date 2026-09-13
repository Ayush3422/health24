import { BadRequestException, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type {
  AllergyBanner,
  AllergySummary,
  CorrectAllergyInput,
  RecordAllergyInput,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { DbTransaction } from '../../db/client';
import { allergyIntolerances, encounters } from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  blankToNull,
  coveringConsentId,
  requireLinkedPatient,
  resolveAttribution,
  toIso,
} from './clinical-access';
import type { Attribution } from './clinical-access';
import { attributionForCorrection, loadForChange, retire } from './corrections.service';

type AllergyRow = {
  id: string;
  patient_id: string;
  hospital_id: string;
  hospital_name: string | null;
  substance: string;
  category: AllergySummary['category'];
  criticality: AllergySummary['criticality'];
  clinical_status: AllergySummary['clinicalStatus'];
  reaction: string | null;
  note: string | null;
  recorded_at: string | Date;
  recorded_by_staff_id: string;
  recorded_by_name: string | null;
  entry_source: AllergySummary['entry']['source'];
  supersedes_id: string | null;
  entered_by_staff_id: string;
  entered_by_name: string | null;
};

const ALLERGY_SELECT = sql`
  SELECT a."id", a."patient_id", a."hospital_id", d."name" AS hospital_name,
         a."substance", a."category", a."criticality", a."clinical_status",
         a."reaction", a."note", a."recorded_at",
         a."attributed_clinician_id" AS recorded_by_staff_id, s."name" AS recorded_by_name,
         a."entry_source", a."supersedes_id", a."recorded_by_staff_id" AS entered_by_staff_id,
         eb."name" AS entered_by_name
    FROM "allergy_intolerance" a
    LEFT JOIN "hospital_directory" d ON d."id" = a."hospital_id"
    LEFT JOIN "staff_user" s ON s."id" = a."attributed_clinician_id"
    LEFT JOIN "staff_user" eb ON eb."id" = a."recorded_by_staff_id"
`;

/**
 * Allergies, and the banner that puts them in front of every clinician who
 * opens the patient.
 *
 * The banner is the first place the product's promise matters for safety: a
 * penicillin allergy recorded at an Ayurvedic hospital should be on screen
 * when an allopathic doctor prescribes. It shows the caller's own records and
 * any other hospital's shared under consent, most dangerous first.
 */
@Injectable()
export class AllergiesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async record(
    actor: Actor,
    input: RecordAllergyInput,
    meta: RequestMeta,
  ): Promise<AllergySummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, input.patientId);

      const attribution = await resolveAttribution(
        tx,
        actor,
        hospitalId,
        input.onBehalfOfClinicianId,
      );

      if (input.encounterId) {
        const [encounter] = await tx
          .select({ id: encounters.id })
          .from(encounters)
          .where(
            and(
              eq(encounters.id, input.encounterId),
              eq(encounters.patientId, input.patientId),
              eq(encounters.hospitalId, hospitalId),
            ),
          )
          .limit(1);

        if (!encounter) {
          throw new BadRequestException(
            'That encounter is not one of this patient’s encounters at your hospital',
          );
        }
      }

      const created = await this.insertAllergy(tx, {
        input,
        patientId: input.patientId,
        hospitalId,
        encounterId: input.encounterId ?? null,
        actor,
        attribution,
        supersedesId: null,
      });

      const [inserted] = await tx.execute<AllergyRow>(sql`
        ${ALLERGY_SELECT}
         WHERE a."id" = ${created.id}::uuid
      `);

      if (!inserted) throw new Error('Recorded allergy is not readable');

      return inserted;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'allergy_intolerance',
      resourceId: row.id,
      patientId: input.patientId,
      action: 'create',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  async banner(actor: Actor, patientId: string, meta: RequestMeta): Promise<AllergyBanner> {
    const hospitalId = requireHospital(actor);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const found = await tx.execute<AllergyRow>(sql`
        ${ALLERGY_SELECT}
         WHERE a."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
           AND a."version_status" = 'current'
           AND a."clinical_status" = 'active'
      ORDER BY CASE a."criticality"
                 WHEN 'high' THEN 0
                 WHEN 'unable_to_assess' THEN 1
                 ELSE 2
               END,
               a."recorded_at" DESC
      `);

      return {
        rows: [...found],
        consentArtefactId: await coveringConsentId(tx, patientId, 'allergies'),
      };
    });

    const sharedRows = rows.some((row) => row.hospital_id !== hospitalId);

    await this.audit.recordForActor(actor, {
      resourceType: 'allergy_intolerance',
      patientId,
      action: 'read',
      consentArtefactId: sharedRows ? consentArtefactId : null,
      meta,
    });

    return {
      allergies: rows.map((row) => this.toSummary(row, hospitalId)),
      sharedFromOtherHospitals: consentArtefactId !== null,
    };
  }

  /**
   * Corrects an allergy — including resolving it, which is a correction with a
   * new clinical status. A resolved allergy leaves the banner; its history
   * still shows that it was recorded, by whom, and why it was resolved.
   */
  async correct(
    actor: Actor,
    allergyId: string,
    input: CorrectAllergyInput,
    meta: RequestMeta,
  ): Promise<AllergySummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const original = await loadForChange(tx, 'allergies', allergyId, actor, hospitalId);
      const attribution = await attributionForCorrection(tx, actor, hospitalId, original);

      await retire(tx, 'allergies', allergyId, actor, input.reason, 'superseded');

      const created = await this.insertAllergy(tx, {
        input,
        patientId: original.patient_id,
        hospitalId,
        encounterId: original.encounter_id,
        actor,
        attribution,
        supersedesId: allergyId,
      });

      const [inserted] = await tx.execute<AllergyRow>(sql`
        ${ALLERGY_SELECT}
         WHERE a."id" = ${created.id}::uuid
      `);

      if (!inserted) throw new Error('Corrected allergy is not readable');

      return inserted;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'allergy_intolerance',
      resourceId: allergyId,
      patientId: row.patient_id,
      action: 'update',
      meta,
    });

    return this.toSummary(row, hospitalId);
  }

  /** Writes an allergy in the caller's transaction. */
  private async insertAllergy(
    tx: DbTransaction,
    args: {
      input: Pick<
        RecordAllergyInput,
        'substance' | 'category' | 'criticality' | 'reaction' | 'note'
      > & {
        clinicalStatus?: AllergySummary['clinicalStatus'];
      };
      patientId: string;
      hospitalId: string;
      encounterId: string | null;
      actor: Actor;
      attribution: Attribution;
      supersedesId: string | null;
    },
  ): Promise<{ id: string }> {
    const { input } = args;

    const [created] = await tx
      .insert(allergyIntolerances)
      .values({
        patientId: args.patientId,
        hospitalId: args.hospitalId,
        encounterId: args.encounterId,
        substance: input.substance.trim(),
        category: input.category,
        criticality: input.criticality,
        clinicalStatus: input.clinicalStatus ?? 'active',
        reaction: blankToNull(input.reaction),
        note: blankToNull(input.note),
        recordedByStaffId: args.actor.staffUserId,
        attributedClinicianId: args.attribution.clinicianId,
        entrySource: args.attribution.entrySource,
        supersedesId: args.supersedesId,
      })
      .returning({ id: allergyIntolerances.id });

    if (!created) throw new Error('Failed to record the allergy');

    return created;
  }

  private toSummary(row: AllergyRow, hospitalId: string): AllergySummary {
    return {
      id: row.id,
      patientId: row.patient_id,
      hospital: {
        id: row.hospital_id,
        name: row.hospital_name ?? 'Unknown hospital',
        isOwn: row.hospital_id === hospitalId,
      },
      substance: row.substance,
      category: row.category,
      criticality: row.criticality,
      clinicalStatus: row.clinical_status,
      supersedesId: row.supersedes_id,
      reaction: row.reaction,
      note: row.note,
      recordedAt: toIso(row.recorded_at),
      recordedBy: { id: row.recorded_by_staff_id, name: row.recorded_by_name },
      entry: {
        source: row.entry_source,
        enteredBy: { id: row.entered_by_staff_id, name: row.entered_by_name },
      },
    };
  }
}
