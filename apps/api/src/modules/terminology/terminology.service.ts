import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import {
  foldTerm,
  type AutoCodeInput,
  type AutoCodeResult,
  type Coding,
  type ConceptSummary,
  type MapElementStatus,
  type MapEquivalence,
  type TerminologySearchInput,
  type TranslateQueryInput,
} from '@health24/shared';
import { DatabaseService } from '../../db/database.service';
import type { Db } from '../../db/client';
import {
  codeSystems,
  conceptDesignations,
  conceptMapElements,
  conceptMaps,
  concepts,
} from '../../db/schema';
import type { Actor, RequestMeta } from '../../common/actor';
import { AuditService } from '../audit/audit.service';
import { byStrength, decideAutoCode, type CandidateMapping } from './auto-code-rules';
import { activateCodeSystem, ReleaseImportError } from './terminology-import';

type CodeSystemRow = typeof codeSystems.$inferSelect;

@Injectable()
export class TerminologyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Terminology has no tenant dimension and no row-level security: every
   * hospital reads the same vocabulary. So these queries use the pool
   * directly rather than a tenant or system context. That is safe precisely
   * because nothing here joins to a tenant-scoped table.
   */
  private get reference(): Db {
    return this.database.raw;
  }

  /** The active version of a code system, or a named version for old records. */
  private async resolveSystem(key: string, version?: string): Promise<CodeSystemRow> {
    const [system] = await this.reference
      .select()
      .from(codeSystems)
      .where(
        version
          ? and(eq(codeSystems.key, key), eq(codeSystems.version, version))
          : and(eq(codeSystems.key, key), eq(codeSystems.status, 'active')),
      )
      .limit(1);

    if (!system) {
      throw new NotFoundException(
        version ? `${key} ${version} is not available` : `No active version of ${key}`,
      );
    }

    return system;
  }

  private async requireConcept(system: CodeSystemRow, code: string) {
    const [concept] = await this.reference
      .select()
      .from(concepts)
      .where(and(eq(concepts.codeSystemId, system.id), eq(concepts.code, code)))
      .limit(1);

    if (!concept) {
      throw new NotFoundException(`${code} is not in ${system.key} ${system.version}`);
    }

    return concept;
  }

  private async designationsFor(conceptIds: string[]) {
    const byConcept = new Map<string, ConceptSummary['designations']>();
    if (conceptIds.length === 0) return byConcept;

    const rows = await this.reference
      .select({
        conceptId: conceptDesignations.conceptId,
        language: conceptDesignations.language,
        use: conceptDesignations.use,
        value: conceptDesignations.value,
      })
      .from(conceptDesignations)
      // The display is already on the concept; repeating it as a designation
      // would only add noise to the response.
      .where(
        and(
          inArray(conceptDesignations.conceptId, conceptIds),
          ne(conceptDesignations.use, 'display'),
        ),
      )
      .orderBy(asc(conceptDesignations.language), asc(conceptDesignations.value));

    for (const row of rows) {
      const list = byConcept.get(row.conceptId) ?? [];
      list.push({ language: row.language, use: row.use, value: row.value });
      byConcept.set(row.conceptId, list);
    }

    return byConcept;
  }

  async listSystems() {
    const rows = await this.reference.execute<{
      id: string;
      key: string;
      name: string;
      version: string;
      publisher: string;
      status: string;
      experimental: boolean;
      licence: string | null;
      attribution: string | null;
      released_at: string | null;
      imported_at: string;
      activated_at: string | null;
      retired_at: string | null;
      concept_count: string;
    }>(sql`
      SELECT cs.id, cs.key, cs.name, cs.version, cs.publisher, cs.status, cs.experimental,
             cs.licence, cs.attribution, cs.released_at, cs.imported_at, cs.activated_at,
             cs.retired_at,
             (SELECT count(*) FROM concept c WHERE c.code_system_id = cs.id) AS concept_count
        FROM code_system cs
    ORDER BY cs.key, cs.imported_at DESC
    `);

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.name,
      version: row.version,
      publisher: row.publisher,
      status: row.status,
      experimental: row.experimental,
      licence: row.licence,
      // Shown alongside the codes wherever they appear. ICD-11's licence
      // requires attribution; this is where the interface gets it from.
      attribution: row.attribution,
      releasedAt: row.released_at,
      importedAt: new Date(row.imported_at).toISOString(),
      activatedAt: row.activated_at ? new Date(row.activated_at).toISOString() : null,
      retiredAt: row.retired_at ? new Date(row.retired_at).toISOString() : null,
      conceptCount: Number(row.concept_count),
    }));
  }

  /**
   * Search within the active version of one code system.
   *
   * Ranked in three tiers — exact folded match, then a prefix of the whole
   * term or of any word in it, then trigram similarity — and by similarity
   * within each tier. Exact and prefix come first because autocomplete is the
   * main use: a clinician who has typed "amla" wants Amlapitta above anything
   * that merely shares letters with it.
   */
  async search(input: TerminologySearchInput): Promise<ConceptSummary[]> {
    const system = await this.resolveSystem(input.system);

    // foldTerm emits only [a-z0-9 ], so the value is safe inside LIKE with no
    // escaping: it cannot contain a wildcard.
    const folded = foldTerm(input.q);
    if (!folded) return [];

    const prefix = `${folded}%`;
    const wordPrefix = `% ${folded}%`;

    const rows = await this.reference.execute<{
      id: string;
      code: string;
      display: string;
      tier: number;
      sim: number;
    }>(sql`
      SELECT c.id, c.code, c.display,
             max(CASE
                   WHEN d.value_folded = ${folded} THEN 3
                   WHEN d.value_folded LIKE ${prefix} OR d.value_folded LIKE ${wordPrefix} THEN 2
                   ELSE 1
                 END) AS tier,
             max(similarity(d.value_folded, ${folded})) AS sim
        FROM concept_designation d
        JOIN concept c ON c.id = d.concept_id
       WHERE c.code_system_id = ${system.id}
         AND (d.value_folded = ${folded}
              OR d.value_folded LIKE ${prefix}
              OR d.value_folded LIKE ${wordPrefix}
              OR d.value_folded % ${folded})
    GROUP BY c.id
    ORDER BY tier DESC, sim DESC, c.display ASC
       LIMIT ${input.limit}
    `);

    const designations = await this.designationsFor(rows.map((row) => row.id));

    return rows.map((row) => ({
      system: system.key,
      systemVersion: system.version,
      code: row.code,
      display: row.display,
      designations: designations.get(row.id) ?? [],
      score: Number(Number(row.sim).toFixed(3)),
      experimental: system.experimental,
    }));
  }

  async lookup(key: string, code: string, version?: string) {
    const system = await this.resolveSystem(key, version);
    const concept = await this.requireConcept(system, code);

    const [parent] = concept.parentCode
      ? await this.reference
          .select({ code: concepts.code, display: concepts.display })
          .from(concepts)
          .where(and(eq(concepts.codeSystemId, system.id), eq(concepts.code, concept.parentCode)))
          .limit(1)
      : [];

    const children = await this.reference
      .select({ code: concepts.code, display: concepts.display })
      .from(concepts)
      .where(and(eq(concepts.codeSystemId, system.id), eq(concepts.parentCode, concept.code)))
      .orderBy(asc(concepts.code));

    const designations = await this.designationsFor([concept.id]);

    return {
      concept: {
        system: system.key,
        systemVersion: system.version,
        code: concept.code,
        display: concept.display,
        definition: concept.definition,
        designations: designations.get(concept.id) ?? [],
        experimental: system.experimental,
      },
      parent: parent ?? null,
      children,
      codeSystem: {
        name: system.name,
        version: system.version,
        status: system.status,
        publisher: system.publisher,
        licence: system.licence,
        attribution: system.attribution,
        experimental: system.experimental,
      },
    };
  }

  /**
   * Proposed and approved mappings out of one concept, in the given source
   * system version. Rejected and retired mappings are left out at the query:
   * nothing downstream has any use for them here.
   */
  private async candidateMappings(
    sourceSystemId: string,
    code: string,
    targetKey?: string,
  ): Promise<CandidateMapping[]> {
    const rows = await this.reference.execute<{
      id: string;
      status: MapElementStatus;
      equivalence: MapEquivalence;
      confidence: number | null;
      target_code: string | null;
      target_display: string | null;
      target_key: string;
      target_version: string;
      experimental: boolean;
    }>(sql`
      SELECT e.id, e.status, e.equivalence, e.confidence, e.target_code,
             tc.display AS target_display,
             t.key AS target_key, t.version AS target_version,
             (m.experimental OR t.experimental) AS experimental
        FROM concept_map_element e
        JOIN concept_map m ON m.id = e.concept_map_id
        JOIN code_system t ON t.id = m.target_system_id
   LEFT JOIN concept tc ON tc.code_system_id = t.id AND tc.code = e.target_code
       WHERE m.source_system_id = ${sourceSystemId}
         AND e.source_code = ${code}
         AND e.status IN ('approved', 'proposed')
         AND (${targetKey ?? null}::text IS NULL OR t.key = ${targetKey ?? null})
    `);

    return rows.map((row) => ({
      elementId: row.id,
      status: row.status,
      equivalence: row.equivalence,
      confidence: row.confidence === null ? null : Number(row.confidence),
      targetKey: row.target_key,
      targetVersion: row.target_version,
      targetCode: row.target_code,
      targetDisplay: row.target_display,
      experimental: row.experimental,
    }));
  }

  /** Approved correspondences only. A proposed mapping is not a translation. */
  async translate(input: TranslateQueryInput) {
    const system = await this.resolveSystem(input.system);
    const concept = await this.requireConcept(system, input.code);
    const mappings = await this.candidateMappings(system.id, concept.code, input.target);

    return {
      source: {
        system: system.key,
        systemVersion: system.version,
        code: concept.code,
        display: concept.display,
      },
      translations: mappings
        .filter((mapping) => mapping.status === 'approved')
        .sort(byStrength)
        .map((mapping) => ({
          system: mapping.targetKey,
          systemVersion: mapping.targetVersion,
          code: mapping.targetCode,
          display: mapping.targetDisplay,
          equivalence: mapping.equivalence,
          confidence: mapping.confidence,
          conceptMapElementId: mapping.elementId,
          experimental: mapping.experimental,
        })),
    };
  }

  async autoCode(input: AutoCodeInput): Promise<AutoCodeResult> {
    const system = await this.resolveSystem(input.system);
    const concept = await this.requireConcept(system, input.code);
    const mappings = await this.candidateMappings(system.id, concept.code);

    return decideAutoCode({
      primary: {
        system: system.key,
        systemVersion: system.version,
        code: concept.code,
        display: concept.display,
        role: 'primary',
        equivalence: null,
        confidence: null,
        conceptMapElementId: null,
      },
      primaryExperimental: system.experimental,
      mappings,
    });
  }

  /**
   * Whether any coding in an auto-code result rests on demo data: a demo
   * release, or a demo map. Used to keep synthetic codes off real patient
   * records.
   */
  async usesExperimentalTerminology(result: AutoCodeResult): Promise<boolean> {
    const codings = [result.primary, result.translated, result.advisory].filter(
      (coding): coding is Coding => coding !== null,
    );

    const [system] = await this.reference
      .select({ id: codeSystems.id })
      .from(codeSystems)
      .where(
        and(
          eq(codeSystems.experimental, true),
          or(
            ...codings.map((coding) =>
              and(
                eq(codeSystems.key, coding.system),
                eq(codeSystems.version, coding.systemVersion),
              ),
            ),
          ),
        ),
      )
      .limit(1);

    if (system) return true;

    const elementIds = codings
      .map((coding) => coding.conceptMapElementId)
      .filter((id): id is string => id !== null);

    if (elementIds.length === 0) return false;

    const [map] = await this.reference
      .select({ id: conceptMaps.id })
      .from(conceptMapElements)
      .innerJoin(conceptMaps, eq(conceptMaps.id, conceptMapElements.conceptMapId))
      .where(and(eq(conceptMaps.experimental, true), inArray(conceptMapElements.id, elementIds)))
      .limit(1);

    return Boolean(map);
  }

  async activate(actor: Actor, codeSystemId: string, meta: RequestMeta) {
    const [system] = await this.reference
      .select({ id: codeSystems.id, key: codeSystems.key, version: codeSystems.version })
      .from(codeSystems)
      .where(eq(codeSystems.id, codeSystemId))
      .limit(1);

    if (!system) throw new NotFoundException('Code system not found');

    let changed: boolean;

    try {
      changed = await activateCodeSystem(this.reference, codeSystemId, actor.staffUserId);
    } catch (error) {
      if (error instanceof ReleaseImportError) throw new BadRequestException(error.message);
      throw error;
    }

    if (changed) {
      await this.audit.recordForActor(actor, {
        resourceType: 'code_system',
        resourceId: codeSystemId,
        action: 'update',
        meta,
      });
    }

    return { id: system.id, key: system.key, version: system.version, status: 'active', changed };
  }
}
