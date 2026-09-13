import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  hasPermission,
  type ClinicalDataCategory,
  type EntrySource,
  type SystemOfMedicine,
} from '@health24/shared';
import type { Actor } from '../../common/actor';
import type { DbTransaction } from '../../db/client';
import { patientHospitalLinks, patients, staffUsers } from '../../db/schema';

/**
 * Access helpers shared by the clinical services. Each runs inside the
 * caller's tenant transaction, so row-level security still decides what they
 * can find.
 */

/**
 * Refuses a patient the caller's hospital is not linked to, or a record that
 * has been merged away.
 *
 * Deliberately a 404 either way: whether a person exists at another hospital
 * is not the caller's to learn from an error message.
 */
export async function requireLinkedPatient(
  tx: DbTransaction,
  hospitalId: string,
  patientId: string,
): Promise<void> {
  const [found] = await tx
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(
      patientHospitalLinks,
      and(
        eq(patientHospitalLinks.patientId, patients.id),
        eq(patientHospitalLinks.hospitalId, hospitalId),
      ),
    )
    .where(and(eq(patients.id, patientId), eq(patients.status, 'active')))
    .limit(1);

  if (!found) {
    throw new NotFoundException('Patient not found');
  }
}

/**
 * The consent artefact a read of another hospital's record rests on, for the
 * audit trail. Null when the caller holds none covering the category.
 *
 * Row-level security has already decided what the caller may see; this only
 * names the permission so the access log can record it.
 */
export async function coveringConsentId(
  tx: DbTransaction,
  patientId: string,
  category: ClinicalDataCategory,
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT ca."id"
      FROM "consent_artefact" ca
     WHERE ca."grantee_hospital_id" = app.current_hospital_id()
       AND ca."patient_id" = ANY (app.patient_record_ids(${patientId}::uuid))
       AND ca."status" = 'active'
       AND ca."expires_at" > now()
       AND ${category}::clinical_data_category = ANY (ca."data_categories")
  ORDER BY ca."granted_at" DESC
     LIMIT 1
  `);

  return rows[0]?.id ?? null;
}

/** Today's date in India Standard Time, as YYYY-MM-DD. */
export function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** An optional free-text field, stored as null rather than an empty string. */
export const blankToNull = (value: string | null | undefined): string | null =>
  value && value.trim() ? value.trim() : null;

export const toIso = (value: string | Date): string => new Date(value).toISOString();

/** The constraint a Postgres error names, when it names one. */
export function violatedConstraint(error: unknown): string | null {
  const failure = error as {
    constraint_name?: string;
    cause?: { constraint_name?: string };
  } | null;

  return failure?.constraint_name ?? failure?.cause?.constraint_name ?? null;
}

export interface Attribution {
  /** The clinician whose decision the entry records. */
  clinicianId: string;
  clinicianSystemOfMedicine: SystemOfMedicine | null;
  entrySource: EntrySource;
}

/**
 * Decides whose name a clinical entry goes in (Decision C).
 *
 * A clinician enters in their own name and may not name anyone else. Medical
 * records staff must name a clinician of their own hospital — any status, so
 * a file from a doctor who has since left can still be transcribed. The
 * database enforces the same rules; this turns a violation into a clear 400
 * instead of a constraint error.
 */
export async function resolveAttribution(
  tx: DbTransaction,
  actor: Actor,
  hospitalId: string,
  onBehalfOfClinicianId: string | undefined,
): Promise<Attribution> {
  if (hasPermission(actor.role, 'clinical:write')) {
    if (onBehalfOfClinicianId && onBehalfOfClinicianId !== actor.staffUserId) {
      throw new BadRequestException(
        'Clinicians record entries in their own name; only medical records staff transcribe for another clinician',
      );
    }

    const [self] = await tx
      .select({ systemOfMedicine: staffUsers.systemOfMedicine })
      .from(staffUsers)
      .where(eq(staffUsers.id, actor.staffUserId))
      .limit(1);

    return {
      clinicianId: actor.staffUserId,
      clinicianSystemOfMedicine: self?.systemOfMedicine ?? null,
      entrySource: 'direct',
    };
  }

  if (!hasPermission(actor.role, 'clinical:transcribe')) {
    throw new ForbiddenException('This account cannot record clinical entries');
  }

  if (!onBehalfOfClinicianId) {
    throw new BadRequestException(
      'Name the clinician this entry is transcribed for (onBehalfOfClinicianId)',
    );
  }

  const [clinician] = await tx
    .select({ systemOfMedicine: staffUsers.systemOfMedicine })
    .from(staffUsers)
    .where(
      and(
        eq(staffUsers.id, onBehalfOfClinicianId),
        eq(staffUsers.hospitalId, hospitalId),
        eq(staffUsers.role, 'clinician'),
      ),
    )
    .limit(1);

  if (!clinician) {
    throw new BadRequestException('onBehalfOfClinicianId must be a clinician at your hospital');
  }

  return {
    clinicianId: onBehalfOfClinicianId,
    clinicianSystemOfMedicine: clinician.systemOfMedicine,
    entrySource: 'transcribed',
  };
}
