import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AbnormalResult, ClinicalDataCategory, PatientSummaryCard } from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AllergiesService } from './allergies.service';
import { requireLinkedPatient, toIso } from './clinical-access';
import { DiagnosesService } from './diagnoses.service';
import { EncountersService } from './encounters.service';
import { PrescriptionsService } from './prescriptions.service';
import { ResultsService } from './results.service';
import { VitalsService } from './vitals.service';

/** How many abnormal lab values the card carries. */
const ABNORMAL_RESULTS_SHOWN = 5;

/**
 * The patient summary card: the thirty-second view.
 *
 * Composed from the same services the full screens use, so the card can never
 * show something the lists would not — and each part is audited as the read it
 * is. Recent abnormal lab results come from the results list, under the same
 * consent for observations.
 */
@Injectable()
export class SummaryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly allergies: AllergiesService,
    private readonly diagnoses: DiagnosesService,
    private readonly prescriptions: PrescriptionsService,
    private readonly vitals: VitalsService,
    private readonly encounters: EncountersService,
    private readonly results: ResultsService,
  ) {}

  async forPatient(
    actor: Actor,
    patientId: string,
    meta: RequestMeta,
  ): Promise<PatientSummaryCard> {
    const hospitalId = requireHospital(actor);

    // The patient check first, so a patient the hospital does not know is a
    // single 404 rather than five audited refusals.
    const sharing = await this.db.asTenant(hospitalId, async (tx) => {
      await requireLinkedPatient(tx, hospitalId, patientId);

      const rows = await tx.execute<{
        categories: ClinicalDataCategory[] | null;
        expires_at: string | Date | null;
        break_glass_until: string | Date | null;
      }>(sql`
        SELECT array(
                 SELECT DISTINCT unnest(ca2."data_categories")::text
                   FROM "consent_artefact" ca2
                  WHERE ca2."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
                    AND ca2."status" = 'active' AND ca2."expires_at" > now()
                  ORDER BY 1
               ) AS categories,
               min(ca."expires_at") FILTER (WHERE ca."capture_method"::text <> 'break_glass') AS expires_at,
               max(ca."expires_at") FILTER (WHERE ca."capture_method"::text = 'break_glass') AS break_glass_until
          FROM "consent_artefact" ca
         WHERE ca."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
           AND ca."status" = 'active' AND ca."expires_at" > now()
      `);

      const [row] = [...rows];

      return {
        categories: row?.categories ?? [],
        expiresAt: row?.expires_at ? toIso(row.expires_at) : null,
        breakGlassUntil: row?.break_glass_until ? toIso(row.break_glass_until) : null,
      };
    });

    const [allergies, problems, medications, vitals, encounters, results] = await Promise.all([
      this.allergies.banner(actor, patientId, meta),
      this.diagnoses.problemList(actor, patientId, meta),
      this.prescriptions.current(actor, patientId, meta),
      this.vitals.forPatient(actor, patientId, meta),
      this.encounters.list(actor, { patientId, page: 1, limit: 3 }, meta),
      this.results.forPatient(actor, patientId, {}, meta),
    ]);

    // Sets arrive newest first; within a set, in panel order.
    const recentAbnormalResults: AbnormalResult[] = results.sets
      .flatMap((set) =>
        set.results.flatMap((result) =>
          result.interpretation && result.interpretation !== 'normal'
            ? [
                {
                  setId: set.id,
                  observationId: result.observationId,
                  collectedAt: set.collectedAt,
                  label: result.label,
                  value: result.value,
                  unit: result.unit,
                  referenceLow: result.referenceLow,
                  referenceHigh: result.referenceHigh,
                  interpretation: result.interpretation,
                  hospital: set.hospital,
                },
              ]
            : [],
        ),
      )
      .slice(0, ABNORMAL_RESULTS_SHOWN);

    return {
      allergies,
      problems,
      medications,
      latestVitals: vitals.sets[0] ?? null,
      recentEncounters: encounters.results,
      recentAbnormalResults,
      sharing,
    };
  }
}
