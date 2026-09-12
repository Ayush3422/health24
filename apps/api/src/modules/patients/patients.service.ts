import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type {
  PatientSummary,
  RegisterPatientInput,
  SearchPatientsInput,
  UpdatePatientInput,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import {
  patientDemographicChanges,
  patientHospitalLinks,
  patientMergeCandidates,
  patients,
} from '../../db/schema';
import { requireHospital, type Actor, type RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { MatchingService, type ScoredCandidate } from './matching.service';
import { MrnService } from './mrn.service';
import { deriveBirthYear, normalizeName, REVIEW_THRESHOLD } from './name-matching';

export interface RegistrationResult {
  patient: PatientSummary;
  /** True when an existing person was linked rather than a new record created. */
  linkedExisting: boolean;
  /** Populated when possible duplicates were queued for review. */
  queuedForReview: number;
}

@Injectable()
export class PatientsService {
  private readonly logger = new Logger(PatientsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly matching: MatchingService,
    private readonly mrn: MrnService,
  ) {}

  /**
   * Registers a patient at the caller's hospital.
   *
   * Three outcomes, in order of preference:
   *
   *   1. An existing person is identified confidently (ABHA, or overwhelming
   *      agreement) — the hospital is linked to that record and the patient's
   *      history follows them. This is the product working.
   *   2. Plausible matches exist — the request is refused with the candidates,
   *      and a human decides. Registration is exactly the moment a duplicate
   *      is cheapest to prevent.
   *   3. Nothing matches — a new record is created.
   */
  async register(
    actor: Actor,
    input: RegisterPatientInput & { forceCreate?: boolean },
    meta: RequestMeta,
  ): Promise<RegistrationResult> {
    const hospitalId = requireHospital(actor);
    const birthYear = deriveBirthYear(input.dateOfBirth, input.approximateAgeYears);

    const identity = {
      name: input.name,
      gender: input.gender,
      phone: input.phone ?? null,
      abhaNumber: input.abhaNumber ?? null,
      birthYear,
    };

    const candidates = await this.matching.findCandidates(identity);
    const autoLink = this.matching.pickAutoLink(candidates);

    if (autoLink) {
      return this.linkExisting(actor, hospitalId, autoLink.patientId, meta, {
        method: autoLink.method,
        score: autoLink.score,
      });
    }

    if (candidates.length > 0 && !input.forceCreate) {
      // Not an error so much as a question. The client shows the candidates
      // and the receptionist either links or confirms this is someone new.
      throw new ConflictException({
        message: 'Possible existing records found for this patient',
        code: 'POSSIBLE_DUPLICATE',
        candidates: candidates.map((candidate) => this.publicCandidate(candidate)),
      });
    }

    const patientId = uuidv7();
    const mrn = await this.mrn.allocate(hospitalId);

    await this.db.asTenant(hospitalId, async (tx) => {
      // Inserted without RETURNING deliberately: the row is not yet visible
      // under the SELECT policy, because visibility depends on the link that
      // does not exist until the next statement. The id is generated here
      // instead.
      await tx.insert(patients).values({
        id: patientId,
        name: input.name.trim(),
        nameNormalized: normalizeName(input.name),
        gender: input.gender,
        dateOfBirth: input.dateOfBirth ?? null,
        approximateAgeYears: input.approximateAgeYears ?? null,
        birthYear,
        phone: input.phone ?? null,
        abhaNumber: input.abhaNumber ?? null,
        abhaAddress: input.abhaAddress ?? null,
        bloodGroup: input.bloodGroup ?? null,
        address: input.address,
        emergencyContactName: input.emergencyContactName ?? null,
        emergencyContactPhone: input.emergencyContactPhone ?? null,
        createdByHospitalId: hospitalId,
      });

      await tx.insert(patientHospitalLinks).values({ patientId, hospitalId, mrn });
    });

    // The receptionist overrode the duplicate warning. They may well be right
    // — but the pairing is recorded so that records staff can reconcile it
    // later, rather than the duplicate silently becoming permanent.
    const queued = input.forceCreate
      ? await this.queueForReview(hospitalId, patientId, candidates)
      : 0;

    await this.audit.recordForActor(actor, {
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      action: 'create',
      meta,
    });

    const patient = await this.findById(actor, patientId, meta, { skipAudit: true });

    return { patient, linkedExisting: false, queuedForReview: queued };
  }

  /**
   * Attaches an existing person to the caller's hospital.
   *
   * Gated: the caller must supply identifying details that actually match the
   * target. Without that, this endpoint would be a way to attach yourself to
   * any patient id and read their history — the exact opposite of what the
   * consent model is for. You can only link to someone you could already
   * identify.
   */
  async linkByConfirmation(
    actor: Actor,
    patientId: string,
    identity: {
      name: string;
      gender?: string;
      dateOfBirth?: string;
      phone?: string;
      abhaNumber?: string;
    },
    meta: RequestMeta,
  ): Promise<RegistrationResult> {
    const hospitalId = requireHospital(actor);

    const candidates = await this.matching.findCandidates({
      ...identity,
      birthYear: deriveBirthYear(identity.dateOfBirth, null),
    });

    const confirmed = candidates.find((candidate) => candidate.patientId === patientId);

    if (!confirmed || confirmed.score < REVIEW_THRESHOLD) {
      await this.audit.recordForActor(actor, {
        resourceType: 'patient',
        resourceId: patientId,
        patientId,
        action: 'read',
        outcome: 'denied',
        meta,
      });

      // Deliberately indistinguishable from "no such patient".
      throw new NotFoundException('No matching patient found');
    }

    return this.linkExisting(actor, hospitalId, patientId, meta, {
      method: confirmed.method,
      score: confirmed.score,
    });
  }

  private async linkExisting(
    actor: Actor,
    hospitalId: string,
    patientId: string,
    meta: RequestMeta,
    match: { method: string; score: number },
  ): Promise<RegistrationResult> {
    const alreadyLinked = await this.db.asTenant(hospitalId, async (tx) => {
      const [existing] = await tx
        .select({ mrn: patientHospitalLinks.mrn })
        .from(patientHospitalLinks)
        .where(
          and(
            eq(patientHospitalLinks.patientId, patientId),
            eq(patientHospitalLinks.hospitalId, hospitalId),
          ),
        )
        .limit(1);

      return existing;
    });

    if (!alreadyLinked) {
      const mrn = await this.mrn.allocate(hospitalId);

      await this.db.asTenant(hospitalId, async (tx) => {
        await tx.insert(patientHospitalLinks).values({ patientId, hospitalId, mrn });
      });

      this.logger.log(
        `Linked existing patient ${patientId} to hospital ${hospitalId} (${match.method}, score ${match.score})`,
      );
    }

    await this.audit.recordForActor(actor, {
      resourceType: 'patient_hospital_link',
      resourceId: patientId,
      patientId,
      action: alreadyLinked ? 'read' : 'create',
      meta,
    });

    const patient = await this.findById(actor, patientId, meta, { skipAudit: true });

    return { patient, linkedExisting: true, queuedForReview: 0 };
  }

  /** Queues possible duplicates for records staff to reconcile. */
  private async queueForReview(
    hospitalId: string,
    newPatientId: string,
    candidates: ScoredCandidate[],
  ): Promise<number> {
    if (candidates.length === 0) return 0;

    return this.db.asTenant(hospitalId, async (tx) => {
      let queued = 0;

      for (const candidate of candidates) {
        // Ordered consistently so the same pair cannot be queued twice from
        // opposite directions.
        const [a, b] =
          newPatientId < candidate.patientId
            ? [newPatientId, candidate.patientId]
            : [candidate.patientId, newPatientId];

        const inserted = await tx
          .insert(patientMergeCandidates)
          .values({
            patientAId: a,
            patientBId: b,
            score: candidate.score,
            method: candidate.method,
            matchedOn: candidate.matchedOn,
            detectedByHospitalId: hospitalId,
          })
          .onConflictDoNothing()
          .returning({ id: patientMergeCandidates.id });

        queued += inserted.length;
      }

      return queued;
    });
  }

  /**
   * Searches within the caller's hospital.
   *
   * Tenant-scoped by row-level security, so this cannot return a patient the
   * hospital has never seen — which is the whole point. Finding people at
   * other hospitals is a separate, deliberately narrower operation.
   */
  async search(
    actor: Actor,
    input: SearchPatientsInput,
    meta: RequestMeta,
  ): Promise<{ results: PatientSummary[]; total: number }> {
    const hospitalId = requireHospital(actor);
    const term = input.q.trim();
    const offset = (input.page - 1) * input.limit;

    const rows = await this.db.asTenant(hospitalId, async (tx) =>
      tx.execute<{
        id: string;
        name: string;
        gender: string;
        date_of_birth: string | null;
        approximate_age_years: number | null;
        phone: string | null;
        abha_number: string | null;
        blood_group: string | null;
        mrn: string;
        created_at: string;
        total: string;
      }>(sql`
        SELECT p."id", p."name", p."gender", p."date_of_birth", p."approximate_age_years",
               p."phone", p."abha_number", p."blood_group", l."mrn", p."created_at",
               count(*) OVER () AS total
          FROM "patient" p
          JOIN "patient_hospital_link" l ON l."patient_id" = p."id"
         WHERE p."status" = 'active'
           AND (
                 l."mrn" ILIKE ${`%${term}%`}
              OR p."phone" ILIKE ${`%${term}%`}
              OR p."abha_number" ILIKE ${`%${term}%`}
              OR p."name_normalized" ILIKE ${`%${normalizeName(term)}%`}
              OR similarity(p."name_normalized", ${normalizeName(term)}) > 0.3
           )
      ORDER BY similarity(p."name_normalized", ${normalizeName(term)}) DESC, p."name" ASC
         LIMIT ${input.limit} OFFSET ${offset}
      `),
    );

    await this.audit.recordForActor(actor, {
      resourceType: 'patient',
      action: 'search',
      meta,
    });

    return {
      results: rows.map((row) => ({
        id: row.id,
        name: row.name,
        gender: row.gender as PatientSummary['gender'],
        dateOfBirth: row.date_of_birth,
        approximateAgeYears:
          row.approximate_age_years === null ? null : Number(row.approximate_age_years),
        phone: row.phone,
        abhaNumber: row.abha_number,
        bloodGroup: row.blood_group as PatientSummary['bloodGroup'],
        mrn: row.mrn,
        createdAt: new Date(row.created_at).toISOString(),
      })),
      total: rows.length > 0 ? Number(rows[0]?.total ?? 0) : 0,
    };
  }

  async findById(
    actor: Actor,
    patientId: string,
    meta: RequestMeta,
    options: { skipAudit?: boolean } = {},
  ): Promise<PatientSummary> {
    const hospitalId = requireHospital(actor);

    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx
        .select({
          id: patients.id,
          name: patients.name,
          gender: patients.gender,
          dateOfBirth: patients.dateOfBirth,
          approximateAgeYears: patients.approximateAgeYears,
          phone: patients.phone,
          abhaNumber: patients.abhaNumber,
          bloodGroup: patients.bloodGroup,
          createdAt: patients.createdAt,
          mrn: patientHospitalLinks.mrn,
        })
        .from(patients)
        .innerJoin(patientHospitalLinks, eq(patientHospitalLinks.patientId, patients.id))
        .where(and(eq(patients.id, patientId), eq(patientHospitalLinks.hospitalId, hospitalId)))
        .limit(1);

      return found;
    });

    if (!row) {
      throw new NotFoundException('Patient not found');
    }

    if (!options.skipAudit) {
      await this.audit.recordForActor(actor, {
        resourceType: 'patient',
        resourceId: patientId,
        patientId,
        action: 'read',
        meta,
      });
    }

    return {
      id: row.id,
      name: row.name,
      gender: row.gender,
      dateOfBirth: row.dateOfBirth,
      approximateAgeYears: row.approximateAgeYears,
      phone: row.phone,
      abhaNumber: row.abhaNumber,
      bloodGroup: row.bloodGroup,
      mrn: row.mrn,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Corrects demographic details, recording every field that changed.
   *
   * A patient's name and date of birth are identifiers, and changing one
   * quietly is how a record becomes untraceable. Every change is attributed,
   * reasoned and kept.
   */
  async update(
    actor: Actor,
    patientId: string,
    input: UpdatePatientInput,
    meta: RequestMeta,
  ): Promise<PatientSummary> {
    const hospitalId = requireHospital(actor);
    const before = await this.loadRow(hospitalId, patientId);

    const changes: Partial<typeof patients.$inferInsert> = { updatedAt: new Date() };
    const history: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];

    const track = (field: string, oldValue: unknown, newValue: unknown) => {
      const oldText = oldValue === null || oldValue === undefined ? null : String(oldValue);
      const newText = newValue === null || newValue === undefined ? null : String(newValue);

      if (oldText !== newText) {
        history.push({ field, oldValue: oldText, newValue: newText });
      }
    };

    if (input.name !== undefined) {
      track('name', before.name, input.name);
      changes.name = input.name.trim();
      changes.nameNormalized = normalizeName(input.name);
    }

    if (input.gender !== undefined) {
      track('gender', before.gender, input.gender);
      changes.gender = input.gender;
    }

    if (input.dateOfBirth !== undefined) {
      track('dateOfBirth', before.dateOfBirth, input.dateOfBirth);
      changes.dateOfBirth = input.dateOfBirth;
      changes.birthYear = deriveBirthYear(input.dateOfBirth, null);
    }

    if (input.phone !== undefined) {
      track('phone', before.phone, input.phone);
      changes.phone = input.phone;
    }

    if (input.abhaNumber !== undefined) {
      track('abhaNumber', before.abhaNumber, input.abhaNumber);
      changes.abhaNumber = input.abhaNumber;
    }

    if (input.abhaAddress !== undefined) {
      track('abhaAddress', before.abhaAddress, input.abhaAddress);
      changes.abhaAddress = input.abhaAddress;
    }

    if (input.bloodGroup !== undefined) {
      track('bloodGroup', before.bloodGroup, input.bloodGroup);
      changes.bloodGroup = input.bloodGroup;
    }

    if (input.address !== undefined) {
      track('address', JSON.stringify(before.address), JSON.stringify(input.address));
      changes.address = input.address;
    }

    if (input.emergencyContactName !== undefined) {
      track('emergencyContactName', before.emergencyContactName, input.emergencyContactName);
      changes.emergencyContactName = input.emergencyContactName;
    }

    if (input.emergencyContactPhone !== undefined) {
      track('emergencyContactPhone', before.emergencyContactPhone, input.emergencyContactPhone);
      changes.emergencyContactPhone = input.emergencyContactPhone;
    }

    if (history.length === 0) {
      return this.findById(actor, patientId, meta, { skipAudit: true });
    }

    await this.db.asTenant(hospitalId, async (tx) => {
      await tx.update(patients).set(changes).where(eq(patients.id, patientId));

      await tx.insert(patientDemographicChanges).values(
        history.map((entry) => ({
          patientId,
          changedByStaffId: actor.staffUserId,
          hospitalId,
          field: entry.field,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
          reason: input.reason,
        })),
      );
    });

    await this.audit.recordForActor(actor, {
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      action: 'update',
      meta,
    });

    return this.findById(actor, patientId, meta, { skipAudit: true });
  }

  private async loadRow(hospitalId: string, patientId: string) {
    const row = await this.db.asTenant(hospitalId, async (tx) => {
      const [found] = await tx.select().from(patients).where(eq(patients.id, patientId)).limit(1);
      return found;
    });

    if (!row) {
      throw new NotFoundException('Patient not found');
    }

    return row;
  }

  /** Strips a candidate down to what may safely cross to another hospital. */
  private publicCandidate(candidate: ScoredCandidate) {
    return {
      patientId: candidate.patientId,
      score: candidate.score,
      method: candidate.method,
      matchedOn: candidate.matchedOn,
      maskedName: candidate.maskedName,
      maskedPhone: candidate.maskedPhone,
      yearOfBirth: candidate.yearOfBirth,
      hospitalCount: candidate.hospitalCount,
    };
  }
}
