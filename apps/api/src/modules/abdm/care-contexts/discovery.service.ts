import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../../db/database.service';
import { AuditService } from '../../audit/audit.service';
import { careContextDisplay } from './care-context-display';

/**
 * Answering the national network's "do you hold anything for this person?"
 * (sp8-plan.md, T11).
 *
 * This is the only endpoint in the system where an outside party asks about a
 * patient by name, and the answer either confirms that the patient exists
 * here or does not. That makes it an oracle if it is written carelessly, and
 * careless has a specific meaning: matching on anything the asker could have
 * guessed.
 *
 * So there is exactly one way to match — **a verified ABHA address equal to
 * the one the request carries** — and everything else is a reason to refuse:
 *
 * - an ABHA that was typed at a desk and never confirmed is not a match, for
 *   the same reason it is not certainty anywhere else in this system (T2);
 * - a name, a phone number or a date of birth on their own are not a match,
 *   ever, because those are what a stranger has;
 * - demographics that positively disagree refuse a match the ABHA would
 *   otherwise have made.
 *
 * And every refusal is the same refusal. "Not found", "found but the year of
 * birth disagrees" and "found at another facility" are three different
 * sentences that would each tell the asker something, so outwardly they are
 * one sentence.
 *
 * The defence that does the real work is not this endpoint's authentication,
 * which is weaker than one would like (`docs/abdm.md`): it is that a caller
 * has to **already know** a verified ABHA address to learn anything at all.
 */

export type DiscoveryRefusal =
  | 'unknown-facility'
  | 'no-abha-in-request'
  | 'no-match'
  | 'demographics-disagree';

export interface DiscoveryRequest {
  /** The facility the gateway named, from `X-HIP-ID`. */
  hipId: string;
  abhaAddress: string | null;
  name?: string | null;
  gender?: string | null;
  yearOfBirth?: number | null;
}

export interface DiscoveredCareContext {
  referenceNumber: string;
  display: string;
}

export interface DiscoveryMatch {
  patientReference: string;
  display: string;
  careContexts: DiscoveredCareContext[];
}

/** How far a year of birth may disagree before it is evidence of another person. */
const YEAR_TOLERANCE = 2;

@Injectable()
export class DiscoveryService {
  private readonly logger = new Logger(DiscoveryService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async discover(request: DiscoveryRequest): Promise<DiscoveryMatch | DiscoveryRefusal> {
    const abhaAddress = request.abhaAddress?.trim().toLowerCase();
    if (!abhaAddress) return 'no-abha-in-request';

    const hospital = await this.facility(request.hipId);
    if (!hospital) return 'unknown-facility';

    // Scoped to the facility the gateway named, by running as that hospital:
    // a patient this facility has never seen is invisible here for the same
    // reason they are invisible to its staff.
    const patients = await this.db.asTenant(hospital.id, async (tx) =>
      tx.execute<{ id: string; name: string; birth_year: number | null }>(sql`
        SELECT "id", "name", "birth_year"
          FROM "patient"
         WHERE lower("abha_address") = ${abhaAddress}
           AND "abha_address_verified_at" IS NOT NULL
           AND "status" = 'active'
      `),
    );

    const patient = patients[0];
    if (!patient) return 'no-match';

    // Positive disagreement, not a missing field: a request that says nothing
    // about the year of birth has not contradicted anything.
    if (
      request.yearOfBirth != null &&
      patient.birth_year != null &&
      Math.abs(Number(patient.birth_year) - request.yearOfBirth) > YEAR_TOLERANCE
    ) {
      return 'demographics-disagree';
    }

    const careContexts = await this.unlinkedVisits(hospital.id, patient.id, hospital.name);

    // The patient is entitled to know their identity was used to find them,
    // whether or not they go on to link anything.
    await this.audit.record({
      actorId: null,
      actorType: 'system',
      actorLabel: `ABDM discovery (${request.hipId})`,
      hospitalId: hospital.id,
      patientId: patient.id,
      resourceType: 'abdm_care_context',
      action: 'search',
    });

    return {
      patientReference: patient.id,
      display: patient.name,
      careContexts,
    };
  }

  /** The hospital ABDM knows by that registry id, or nothing. */
  private async facility(hipId: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{ id: string; name: string }>(sql`
        SELECT "id", "name" FROM "hospital"
         WHERE "hfr_id" = ${hipId} AND "status" = 'active'
      `),
    );

    if (rows.length === 0) {
      // Worth a log line: it means a facility is registered with ABDM and
      // not with us, which is a configuration mistake somebody must fix.
      this.logger.warn(`ABDM named a facility this deployment does not know: ${hipId}`);
    }

    return rows[0] ?? null;
  }

  /**
   * The visits this patient could still choose to share.
   *
   * Already-linked ones are left out: the patient's own app knows about them
   * and offering them again would put duplicates in front of somebody who is
   * trying to decide. Cancelled visits never appear at all.
   */
  private async unlinkedVisits(
    hospitalId: string,
    patientId: string,
    hospitalName: string,
  ): Promise<DiscoveredCareContext[]> {
    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{ id: string; started_at: string; class: string }>(sql`
        SELECT e."id", e."started_at", e."class"::text AS class
          FROM "encounter" e
         WHERE e."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
           AND e."hospital_id" = ${hospitalId}
           AND e."status" <> 'cancelled'
           AND NOT EXISTS (
                 SELECT 1 FROM "abdm_care_context" c
                  WHERE c."encounter_id" = e."id" AND c."status" = 'linked'
               )
      ORDER BY e."started_at" DESC
         LIMIT 100
      `),
    );

    return rows.map((row) => ({
      referenceNumber: row.id,
      display: careContextDisplay({
        startedAt: row.started_at,
        class: row.class,
        hospitalName,
      }),
    }));
  }
}
