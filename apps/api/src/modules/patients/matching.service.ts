import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../../db/database.service';
import {
  AUTO_LINK_THRESHOLD,
  REVIEW_THRESHOLD,
  maskName,
  maskPhone,
  normalizeName,
  scoreIdentities,
  type MatchScore,
} from './name-matching';

export interface CandidateIdentity {
  name: string;
  gender?: string | null;
  phone?: string | null;
  abhaNumber?: string | null;
  birthYear?: number | null;
}

export interface ScoredCandidate {
  patientId: string;
  score: number;
  method: MatchScore['method'];
  matchedOn: string[];
  maskedName: string;
  maskedPhone: string | null;
  yearOfBirth: number | null;
  hospitalCount: number;
  /** True only for an ABHA match, or an overwhelming probabilistic one. */
  autoLinkable: boolean;
}

/**
 * Finds existing records that may be the same person.
 *
 * Runs in system context by necessity: the entire point is to look across
 * hospitals, and a tenant-scoped query by definition cannot. This is one of
 * the four documented system-context call sites. What crosses the boundary is
 * tightly limited — scores and masked identifiers, never clinical data and
 * never an unmasked name — so a receptionist at one hospital learns that a
 * possible match exists without learning who the other hospital's patients
 * are.
 */
@Injectable()
export class MatchingService {
  /**
   * Trigram floor for pulling rows out of the database. Deliberately loose:
   * this stage is a cheap filter, and the real scoring happens afterwards in
   * `scoreIdentities`. Tightening it here would silently drop pairs the
   * scorer would have caught.
   */
  private static readonly TRIGRAM_FLOOR = 0.25;

  constructor(private readonly db: DatabaseService) {}

  async findCandidates(
    identity: CandidateIdentity,
    options: { excludePatientId?: string; limit?: number } = {},
  ): Promise<ScoredCandidate[]> {
    const normalized = normalizeName(identity.name);
    const limit = options.limit ?? 25;

    const rows = await this.db.asSystem(async (tx) =>
      tx.execute<{
        id: string;
        name: string;
        gender: string;
        phone: string | null;
        abha_number: string | null;
        birth_year: number | null;
        hospital_count: string;
      }>(sql`
        SELECT p."id",
               p."name",
               p."gender",
               p."phone",
               p."abha_number",
               p."birth_year",
               (SELECT count(*) FROM "patient_hospital_link" l WHERE l."patient_id" = p."id")
                 AS hospital_count
          FROM "patient" p
         WHERE p."status" = 'active'
           AND (
                 (${identity.abhaNumber ?? null}::text IS NOT NULL
                   AND p."abha_number" = ${identity.abhaNumber ?? null})
              OR (${identity.phone ?? null}::text IS NOT NULL
                   AND p."phone" = ${identity.phone ?? null})
              OR similarity(p."name_normalized", ${normalized}) > ${MatchingService.TRIGRAM_FLOOR}
           )
           AND (${options.excludePatientId ?? null}::uuid IS NULL
                 OR p."id" <> ${options.excludePatientId ?? null}::uuid)
         ORDER BY similarity(p."name_normalized", ${normalized}) DESC
         LIMIT ${limit}
      `),
    );

    return rows
      .map((row) => {
        const scored = scoreIdentities(identity, {
          name: row.name,
          gender: row.gender,
          phone: row.phone,
          abhaNumber: row.abha_number,
          birthYear: row.birth_year === null ? null : Number(row.birth_year),
        });

        return {
          patientId: row.id,
          score: scored.score,
          method: scored.method,
          matchedOn: scored.matchedOn,
          maskedName: maskName(row.name),
          maskedPhone: maskPhone(row.phone),
          yearOfBirth: row.birth_year === null ? null : Number(row.birth_year),
          hospitalCount: Number(row.hospital_count),
          autoLinkable: scored.method === 'abha_exact' || scored.score >= AUTO_LINK_THRESHOLD,
        } satisfies ScoredCandidate;
      })
      .filter((candidate) => candidate.score >= REVIEW_THRESHOLD)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * The one candidate confident enough to link to without asking anyone.
   *
   * Returns nothing when several candidates clear the bar: two records that
   * both look like this person means the duplicates are already there, and
   * picking one arbitrarily would compound the problem silently. That goes to
   * a human.
   */
  pickAutoLink(candidates: ScoredCandidate[]): ScoredCandidate | null {
    const linkable = candidates.filter((candidate) => candidate.autoLinkable);
    return linkable.length === 1 ? (linkable[0] ?? null) : null;
  }
}
