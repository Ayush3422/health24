import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import {
  LAB_PANELS,
  LOINC_SYSTEM,
  findAnalyte,
  interpretResult,
  toCanonicalValue,
  type LabAnalyte,
  type LabPanelKey,
  type ListResultsQuery,
  type RecordResultsInput,
  type ResultInterpretation,
  type ResultSet,
  type ResultSetList,
  type ResultTrend,
} from '@health24/shared';
import type { DbTransaction } from '../../db/client';
import { DatabaseService } from '../../db/database.service';
import { observations } from '../../db/schema';
import {
  requireHospital,
  type Actor,
  type PatientActor,
  type RequestMeta,
} from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import {
  coveringConsentId,
  requireLinkedPatient,
  requireWritableEncounter,
  toIso,
} from './clinical-access';
import { staffName, type ReaderContext } from './staff-names';

type ResultRow = {
  id: string;
  group_id: string;
  patient_id: string;
  encounter_id: string | null;
  document_id: string | null;
  hospital_id: string;
  hospital_name: string | null;
  panel_code: LabPanelKey;
  code: string;
  display: string;
  value: string;
  unit: string;
  value_canonical: string;
  unit_canonical: string;
  reference_low: string | null;
  reference_high: string | null;
  reference_text: string | null;
  lab_flag: string | null;
  interpretation: ResultInterpretation | null;
  performing_facility: string | null;
  source: 'entered' | 'extracted';
  effective_at: string | Date;
  recorded_at: string | Date;
  recorded_by_staff_id: string;
  recorded_by_name: string | null;
};

const resultSelect = (context: ReaderContext): SQL => sql`
  SELECT o."id", o."group_id", o."patient_id", o."encounter_id", o."document_id", o."hospital_id",
         d."name" AS hospital_name, o."panel_code", o."code", o."display",
         o."value_quantity"::text AS value, o."unit", o."value_canonical"::text AS value_canonical,
         o."unit_canonical", o."reference_low"::text AS reference_low,
         o."reference_high"::text AS reference_high, o."reference_text", o."lab_flag",
         o."interpretation", o."performing_facility", o."source", o."effective_at", o."recorded_at",
         o."recorded_by_staff_id",
         ${staffName(context, sql`eb."name"`, sql`o."recorded_by_staff_id"`)} AS recorded_by_name
    FROM "observation" o
    LEFT JOIN "hospital_directory" d ON d."id" = o."hospital_id"
    LEFT JOIN "staff_user" eb ON eb."id" = o."recorded_by_staff_id"
`;

const numberOrNull = (value: string | null) => (value === null ? null : Number(value));

/**
 * Lab results (sp4-plan.md, Phase 4): values typed from a report against a
 * curated panel, as LOINC-coded observations in the `laboratory` category.
 *
 * Shared under consent for observations, like vitals (Decision G1); the report
 * they were typed from is shared separately, under documents. Every value is
 * kept as entered and in its analyte's canonical unit, so a trend can span
 * laboratories that report differently.
 */
@Injectable()
export class ResultsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async record(actor: Actor, input: RecordResultsInput, meta: RequestMeta): Promise<ResultSet> {
    const hospitalId = requireHospital(actor);
    const panel = LAB_PANELS[input.panel];
    const analytes = panel.analytes as readonly LabAnalyte[];
    const groupId = uuidv7();

    const rows = await this.db.asTenant(hospitalId, async (tx) => {
      if (input.encounterId) {
        const encounter = await requireWritableEncounter(
          tx,
          hospitalId,
          input.encounterId,
          'Results are',
        );
        if (encounter.patientId !== input.patientId) {
          throw new BadRequestException('That encounter belongs to a different patient');
        }
      } else {
        await requireLinkedPatient(tx, hospitalId, input.patientId);
      }

      if (input.documentId)
        await this.requireReport(tx, hospitalId, input.patientId, input.documentId);

      await tx.insert(observations).values(
        input.results.map((result) => {
          const analyte = analytes.find((candidate) => candidate.code === result.code)!;

          return {
            patientId: input.patientId,
            hospitalId,
            encounterId: input.encounterId ?? null,
            category: 'laboratory' as const,
            source: 'entered' as const,
            codeSystem: LOINC_SYSTEM,
            code: analyte.code,
            display: analyte.display,
            valueQuantity: String(result.value),
            unit: result.unit,
            valueCanonical: String(toCanonicalValue(analyte, result.value, result.unit)),
            unitCanonical: analyte.units[0].code,
            referenceLow: result.referenceLow === undefined ? null : String(result.referenceLow),
            referenceHigh: result.referenceHigh === undefined ? null : String(result.referenceHigh),
            referenceText: result.referenceText ?? null,
            labFlag: result.labFlag ?? null,
            interpretation: interpretResult({
              value: result.value,
              low: result.referenceLow,
              high: result.referenceHigh,
              labFlag: result.labFlag,
            }),
            panelCode: input.panel,
            documentId: input.documentId ?? null,
            performingFacility: input.performingFacility ?? null,
            groupId,
            effectiveAt: new Date(input.collectedAt),
            recordedByStaffId: actor.staffUserId,
            attributedClinicianId: null,
            entrySource: 'direct' as const,
          };
        }),
      );

      return this.query(tx, sql`WHERE o."group_id" = ${groupId}::uuid`);
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      resourceId: groupId,
      patientId: input.patientId,
      action: 'create',
      meta,
    });

    const [set] = this.toSets(rows, hospitalId);
    if (!set) throw new Error('Recorded results are not readable');
    return set;
  }

  async forPatient(
    actor: Actor,
    patientId: string,
    query: ListResultsQuery,
    meta: RequestMeta,
  ): Promise<ResultSetList> {
    const hospitalId = requireHospital(actor);

    const where = this.listWhere(patientId, query);

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      return {
        rows: await this.query(
          tx,
          sql`WHERE ${where}
          ORDER BY o."effective_at" DESC, o."group_id"
             LIMIT 1000`,
        ),
        consentArtefactId: await coveringConsentId(tx, patientId, 'observations'),
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      resourceId: 'laboratory',
      patientId,
      action: 'read',
      consentArtefactId: rows.some((row) => row.hospital_id !== hospitalId)
        ? consentArtefactId
        : null,
      meta,
    });

    return {
      sets: this.toSets(rows, hospitalId),
      sharedFromOtherHospitals: consentArtefactId !== null,
    };
  }

  /** One analyte over time, across every hospital the caller may see, in one unit. */
  async trend(
    actor: Actor,
    patientId: string,
    code: string,
    meta: RequestMeta,
  ): Promise<ResultTrend> {
    const hospitalId = requireHospital(actor);
    const found = findAnalyte(code);

    if (!found) throw new BadRequestException('Not an analyte of any lab panel');

    const { analyte } = found;

    const { rows, consentArtefactId } = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      return {
        rows: await this.query(
          tx,
          sql`WHERE ${this.currentResultsOf(patientId)} AND o."code" = ${code}
          ORDER BY o."effective_at" ASC, o."id"`,
        ),
        consentArtefactId: await coveringConsentId(tx, patientId, 'observations'),
      };
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      resourceId: code,
      patientId,
      action: 'read',
      consentArtefactId: rows.some((row) => row.hospital_id !== hospitalId)
        ? consentArtefactId
        : null,
      meta,
    });

    return this.toTrend(analyte, rows, hospitalId, consentArtefactId !== null);
  }

  /**
   * The patient's own results in the portal (SP5): every hospital, with no
   * consent involved, audited as the patient (sp5-plan.md, DF6).
   */
  async forOwnRecord(
    patient: PatientActor,
    query: ListResultsQuery,
    meta: RequestMeta,
  ): Promise<ResultSetList> {
    const where = this.listWhere(patient.patientId, query);

    const rows = await this.db.asPatient(patient.patientId, (tx) =>
      this.query(
        tx,
        sql`WHERE ${where}
        ORDER BY o."effective_at" DESC, o."group_id"
           LIMIT 1000`,
        'patient',
      ),
    );

    await this.audit.recordForPatient(patient, {
      resourceType: 'observation',
      resourceId: 'laboratory',
      action: 'read',
      meta,
    });

    return { sets: this.toSets(rows, null), sharedFromOtherHospitals: false };
  }

  /** One analyte over time from the patient's own record, in one unit (SP5). */
  async trendForOwnRecord(
    patient: PatientActor,
    code: string,
    meta: RequestMeta,
  ): Promise<ResultTrend> {
    const found = findAnalyte(code);

    if (!found) throw new BadRequestException('Not an analyte of any lab panel');

    const rows = await this.db.asPatient(patient.patientId, (tx) =>
      this.query(
        tx,
        sql`WHERE ${this.currentResultsOf(patient.patientId)} AND o."code" = ${code}
        ORDER BY o."effective_at" ASC, o."id"`,
        'patient',
      ),
    );

    await this.audit.recordForPatient(patient, {
      resourceType: 'observation',
      resourceId: code,
      action: 'read',
      meta,
    });

    return this.toTrend(found.analyte, rows, null, false);
  }

  /** A mistyped set is withdrawn whole, then typed again. */
  async markEnteredInError(
    actor: Actor,
    groupId: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<{ id: string; versionStatus: 'entered_in_error' }> {
    const hospitalId = requireHospital(actor);

    const patientId = await this.db.asTenant(hospitalId, async (tx) => {
      const members = await tx.execute<{
        patient_id: string;
        hospital_id: string;
        version_status: string;
      }>(sql`
        SELECT "patient_id", "hospital_id", "version_status" FROM "observation"
         WHERE "group_id" = ${groupId}::uuid AND "category" = 'laboratory'
      `);

      const list = [...members];
      if (list.length === 0) throw new NotFoundException('Results not found');

      if (list[0]!.hospital_id !== hospitalId) {
        throw new ForbiddenException(
          'Only the hospital that recorded these results can withdraw them',
        );
      }

      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE "observation"
           SET "version_status" = 'entered_in_error', "status_changed_at" = now(),
               "status_changed_by_staff_id" = ${actor.staffUserId}, "status_reason" = ${reason}
         WHERE "group_id" = ${groupId}::uuid AND "category" = 'laboratory'
           AND "version_status" = 'current'
     RETURNING "id"
      `);

      if ([...updated].length === 0) {
        throw new ConflictException('These results have already been marked entered in error');
      }

      return list[0]!.patient_id;
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'observation',
      resourceId: groupId,
      patientId,
      action: 'update',
      meta,
    });

    return { id: groupId, versionStatus: 'entered_in_error' };
  }

  private currentResultsOf(patientId: string): SQL {
    return sql`o."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
      AND o."category" = 'laboratory' AND o."version_status" = 'current'`;
  }

  /** A report of this hospital, for this patient, that has not been withdrawn. */
  private async requireReport(
    tx: DbTransaction,
    hospitalId: string,
    patientId: string,
    documentId: string,
  ): Promise<void> {
    const [found] = await tx.execute<{ id: string }>(sql`
      SELECT "id" FROM "document_reference"
       WHERE "id" = ${documentId}::uuid AND "hospital_id" = ${hospitalId}::uuid
         AND "patient_id" = ${patientId}::uuid AND "version_status" <> 'entered_in_error'
    `);

    if (!found) {
      throw new BadRequestException(
        'Results are attached to one of your hospital’s reports for this patient',
      );
    }
  }

  private async query(
    tx: DbTransaction,
    tail: SQL,
    context: ReaderContext = 'hospital',
  ): Promise<ResultRow[]> {
    return [...(await tx.execute<ResultRow>(sql`${resultSelect(context)} ${tail}`))];
  }

  private listWhere(patientId: string, query: ListResultsQuery): SQL {
    const filters: SQL[] = [this.currentResultsOf(patientId)];
    if (query.panel) filters.push(sql`o."panel_code" = ${query.panel}`);
    if (query.from) filters.push(sql`app.ist_date(o."effective_at") >= ${query.from}::date`);
    if (query.to) filters.push(sql`app.ist_date(o."effective_at") <= ${query.to}::date`);
    return sql.join(filters, sql` AND `);
  }

  /**
   * One analyte's rows as a trend, every value and range in its canonical unit.
   * `hospitalId` is the reading hospital; null for a patient.
   */
  private toTrend(
    analyte: LabAnalyte,
    rows: ResultRow[],
    hospitalId: string | null,
    sharedFromOtherHospitals: boolean,
  ): ResultTrend {
    const canonical = analyte.units[0];
    const inCanonical = (value: string | null, unit: string) =>
      value === null ? null : toCanonicalValue(analyte, Number(value), unit);

    return {
      analyte: {
        code: analyte.code,
        display: analyte.display,
        label: analyte.label,
        unit: canonical.code,
      },
      points: rows.map((row) => ({
        observationId: row.id,
        setId: row.group_id,
        collectedAt: toIso(row.effective_at),
        value: Number(row.value_canonical),
        referenceLow: inCanonical(row.reference_low, row.unit),
        referenceHigh: inCanonical(row.reference_high, row.unit),
        interpretation: row.interpretation,
        hospital: {
          id: row.hospital_id,
          name: row.hospital_name ?? 'Unknown hospital',
          isOwn: hospitalId !== null && row.hospital_id === hospitalId,
        },
        valueAsEntered: Number(row.value),
        unitAsEntered: row.unit,
      })),
      sharedFromOtherHospitals,
    };
  }

  /** Groups rows into sets in the order they arrived, each set's results in panel order. */
  private toSets(rows: ResultRow[], hospitalId: string | null): ResultSet[] {
    const sets = new Map<string, ResultSet>();

    for (const row of rows) {
      const panel = LAB_PANELS[row.panel_code];
      const analytes = panel.analytes as readonly LabAnalyte[];
      const analyte = analytes.find((candidate) => candidate.code === row.code);

      let set = sets.get(row.group_id);
      if (!set) {
        set = {
          id: row.group_id,
          patientId: row.patient_id,
          encounterId: row.encounter_id,
          documentId: row.document_id,
          hospital: {
            id: row.hospital_id,
            name: row.hospital_name ?? 'Unknown hospital',
            isOwn: hospitalId !== null && row.hospital_id === hospitalId,
          },
          panel: row.panel_code,
          panelLabel: panel.label,
          collectedAt: toIso(row.effective_at),
          performingFacility: row.performing_facility,
          source: row.source,
          results: [],
          recordedBy: { id: row.recorded_by_staff_id, name: row.recorded_by_name },
          recordedAt: toIso(row.recorded_at),
        };
        sets.set(row.group_id, set);
      }

      set.results.push({
        observationId: row.id,
        code: row.code,
        display: row.display,
        label: analyte?.label ?? row.display,
        value: Number(row.value),
        unit: row.unit,
        valueCanonical: Number(row.value_canonical),
        unitCanonical: row.unit_canonical,
        referenceLow: numberOrNull(row.reference_low),
        referenceHigh: numberOrNull(row.reference_high),
        referenceText: row.reference_text,
        labFlag: row.lab_flag,
        interpretation: row.interpretation,
      });
    }

    for (const set of sets.values()) {
      const order = (LAB_PANELS[set.panel].analytes as readonly LabAnalyte[]).map((a) => a.code);
      set.results.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));
    }

    return [...sets.values()];
  }
}
