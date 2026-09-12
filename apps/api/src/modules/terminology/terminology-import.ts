import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  foldTerm,
  type ConceptMapRelease,
  type DesignationUse,
  type TerminologyRelease,
} from '@health24/shared';
import type { Db, DbTransaction } from '../../db/client';
import {
  codeSystems,
  conceptDesignations,
  conceptMapElements,
  conceptMapReviews,
  conceptMaps,
  concepts,
} from '../../db/schema';
import { hashCodeSystemRelease, hashConceptMapRelease } from './release-hash';

/**
 * Terminology ingestion.
 *
 * Plain functions over a database handle rather than a Nest service, because
 * releases are imported from the CLI, outside the running application. A real
 * NAMASTE or ICD-11 release is large, rare and operated by the platform — an
 * HTTP endpoint for it would be attack surface with no user.
 */

export class ReleaseImportError extends Error {
  override name = 'ReleaseImportError';
}

export interface ImportOutcome {
  kind: 'code_system' | 'concept_map';
  key: string;
  version: string;
  id: string;
  result: 'imported' | 'unchanged';
  counts: Record<string, number>;
}

/**
 * Postgres caps a statement at 65,535 parameters. A designation row binds five,
 * so a single insert of a full release would fail on a real NAMASTE file while
 * passing every test run against a handful of demo concepts.
 */
const BATCH = 1000;

function batches<T>(items: readonly T[], size = BATCH): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

export async function importCodeSystemRelease(
  db: Db,
  release: TerminologyRelease,
  importedBy: string,
): Promise<ImportOutcome> {
  const { codeSystem } = release;
  const contentHash = hashCodeSystemRelease(release);

  return db.transaction(async (tx): Promise<ImportOutcome> => {
    const [existing] = await tx
      .select({ id: codeSystems.id, contentHash: codeSystems.contentHash })
      .from(codeSystems)
      .where(and(eq(codeSystems.key, codeSystem.key), eq(codeSystems.version, codeSystem.version)))
      .limit(1);

    if (existing) {
      if (existing.contentHash === contentHash) {
        return {
          kind: 'code_system',
          key: codeSystem.key,
          version: codeSystem.version,
          id: existing.id,
          result: 'unchanged',
          counts: {},
        };
      }

      throw new ReleaseImportError(
        `${codeSystem.key} ${codeSystem.version} has already been imported with different content. ` +
          'A published release must never change underneath existing records — issue a new version instead.',
      );
    }

    const [created] = await tx
      .insert(codeSystems)
      .values({
        key: codeSystem.key,
        uri: codeSystem.uri,
        name: codeSystem.name,
        version: codeSystem.version,
        publisher: codeSystem.publisher,
        experimental: codeSystem.experimental,
        licence: codeSystem.licence ?? null,
        attribution: codeSystem.attribution ?? null,
        releasedAt: codeSystem.releasedAt ?? null,
        contentHash,
        importedBy,
      })
      .returning({ id: codeSystems.id });

    if (!created) throw new ReleaseImportError('Failed to create the code system');

    const idByCode = new Map<string, string>();

    for (const batch of batches(release.concepts)) {
      const inserted = await tx
        .insert(concepts)
        .values(
          batch.map((concept) => ({
            codeSystemId: created.id,
            code: concept.code,
            display: concept.display,
            definition: concept.definition ?? null,
            parentCode: concept.parentCode ?? null,
          })),
        )
        .returning({ id: concepts.id, code: concepts.code });

      for (const row of inserted) idByCode.set(row.code, row.id);
    }

    const designationRows = release.concepts.flatMap((concept) => {
      const conceptId = idByCode.get(concept.code) as string;

      // The display is searchable too. Its language is recorded as `und`
      // (undetermined) rather than guessed: a release does not state it, and a
      // wrong language tag is worse than an honest unknown.
      const all = [
        { language: 'und', use: 'display' as DesignationUse, value: concept.display },
        ...concept.designations,
      ];

      const seen = new Set<string>();

      return all
        .filter((designation) => {
          const key = `${designation.language}|${designation.use}|${designation.value}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((designation) => ({
          conceptId,
          language: designation.language,
          use: designation.use,
          value: designation.value,
          valueFolded: foldTerm(designation.value),
        }));
    });

    for (const batch of batches(designationRows)) {
      await tx.insert(conceptDesignations).values(batch);
    }

    return {
      kind: 'code_system',
      key: codeSystem.key,
      version: codeSystem.version,
      id: created.id,
      result: 'imported',
      counts: { concepts: release.concepts.length, designations: designationRows.length },
    };
  });
}

/**
 * Makes one version of a code system the active one, retiring whichever was
 * active before. Retired versions stay resolvable, so diagnoses coded against
 * them keep their meaning.
 *
 * Returns whether anything changed, so callers can say "already active"
 * instead of reporting an activation that did not happen.
 */
export async function activateCodeSystem(
  db: Db | DbTransaction,
  codeSystemId: string,
  activatedByStaffId: string | null,
): Promise<boolean> {
  // On a transaction handle this nests as a savepoint, so the retire-then-
  // activate pair is atomic either way.
  return (db as Db).transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(codeSystems)
      .where(eq(codeSystems.id, codeSystemId))
      .limit(1);

    if (!target) throw new ReleaseImportError('Code system not found');

    if (target.experimental && process.env.NODE_ENV === 'production') {
      throw new ReleaseImportError(
        `${target.key} ${target.version} is experimental and cannot be activated in production`,
      );
    }

    if (target.status === 'active') return false;

    // Retire first: the partial unique index allows only one active version
    // per key, so activating before retiring would violate it.
    await tx
      .update(codeSystems)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(
        and(
          eq(codeSystems.key, target.key),
          eq(codeSystems.status, 'active'),
          ne(codeSystems.id, target.id),
        ),
      );

    await tx
      .update(codeSystems)
      .set({
        status: 'active',
        activatedAt: new Date(),
        activatedByStaffId,
        retiredAt: null,
      })
      .where(eq(codeSystems.id, target.id));

    return true;
  });
}

async function findSystem(tx: DbTransaction, key: string, version: string) {
  const [row] = await tx
    .select()
    .from(codeSystems)
    .where(and(eq(codeSystems.key, key), eq(codeSystems.version, version)))
    .limit(1);

  if (!row) {
    throw new ReleaseImportError(
      `Code system ${key} ${version} is not imported. Import it before a map that references it.`,
    );
  }

  return row;
}

async function unknownCodes(
  tx: DbTransaction,
  codeSystemId: string,
  codes: readonly string[],
): Promise<string[]> {
  const known = new Set<string>();

  for (const batch of batches(codes)) {
    const rows = await tx
      .select({ code: concepts.code })
      .from(concepts)
      .where(and(eq(concepts.codeSystemId, codeSystemId), inArray(concepts.code, batch)));

    for (const row of rows) known.add(row.code);
  }

  return codes.filter((code) => !known.has(code));
}

export async function importConceptMapRelease(
  db: Db,
  release: ConceptMapRelease,
  importedBy: string,
): Promise<ImportOutcome> {
  const { map } = release;
  const contentHash = hashConceptMapRelease(release);

  return db.transaction(async (tx): Promise<ImportOutcome> => {
    const [existing] = await tx
      .select({ id: conceptMaps.id, contentHash: conceptMaps.contentHash })
      .from(conceptMaps)
      .where(and(eq(conceptMaps.key, map.key), eq(conceptMaps.version, map.version)))
      .limit(1);

    if (existing) {
      if (existing.contentHash === contentHash) {
        return {
          kind: 'concept_map',
          key: map.key,
          version: map.version,
          id: existing.id,
          result: 'unchanged',
          counts: {},
        };
      }

      throw new ReleaseImportError(
        `Map ${map.key} ${map.version} has already been imported with different content. Issue a new version instead.`,
      );
    }

    const source = await findSystem(tx, map.source.key, map.source.version);
    const target = await findSystem(tx, map.target.key, map.target.version);

    // Demo data must never be able to pass for real data by being wired into
    // a map that is not itself marked experimental.
    if (!map.experimental && (source.experimental || target.experimental)) {
      throw new ReleaseImportError(
        'A non-experimental map cannot reference an experimental code system',
      );
    }

    // A map pointing at codes that do not exist is corrupt, and would surface
    // later as a translation to nothing on a patient's record.
    const missingSource = await unknownCodes(tx, source.id, [
      ...new Set(release.elements.map((element) => element.sourceCode)),
    ]);
    const missingTarget = await unknownCodes(tx, target.id, [
      ...new Set(
        release.elements
          .map((element) => element.targetCode)
          .filter((code): code is string => code !== null),
      ),
    ]);

    if (missingSource.length > 0 || missingTarget.length > 0) {
      const describe = (label: string, codes: string[]) =>
        codes.length === 0
          ? ''
          : `${codes.length} ${label} code(s) not found, e.g. ${codes.slice(0, 10).join(', ')}. `;

      throw new ReleaseImportError(
        `Map ${map.key} ${map.version} references unknown codes. ` +
          describe(`${map.source.key} source`, missingSource) +
          describe(`${map.target.key} target`, missingTarget),
      );
    }

    const [created] = await tx
      .insert(conceptMaps)
      .values({
        key: map.key,
        name: map.name,
        version: map.version,
        publisher: map.publisher,
        sourceSystemId: source.id,
        targetSystemId: target.id,
        experimental: map.experimental,
        reviewPolicy: map.reviewPolicy,
        licence: map.licence ?? null,
        attribution: map.attribution ?? null,
        contentHash,
        importedBy,
      })
      .returning({ id: conceptMaps.id });

    if (!created) throw new ReleaseImportError('Failed to create the concept map');

    const authoritative = map.reviewPolicy === 'authoritative';
    const now = new Date();
    let approved = 0;

    for (const batch of batches(release.elements)) {
      const inserted = await tx
        .insert(conceptMapElements)
        .values(
          batch.map((element) => ({
            conceptMapId: created.id,
            sourceCode: element.sourceCode,
            targetCode: element.targetCode,
            equivalence: element.equivalence,
            confidence: element.confidence ?? null,
            comment: element.comment ?? null,
            status: authoritative ? ('approved' as const) : ('proposed' as const),
            provenance: 'imported' as const,
            reviewedAt: authoritative ? now : null,
            reviewComment: authoritative
              ? `Approved on import: ${map.publisher} release marked authoritative`
              : null,
          })),
        )
        .returning({ id: conceptMapElements.id });

      if (authoritative) approved += inserted.length;

      await tx.insert(conceptMapReviews).values(
        inserted.map((row) => ({
          elementId: row.id,
          action: 'import' as const,
          staffId: null,
          actorLabel: importedBy,
          comment: authoritative
            ? 'Imported from an authoritative release and approved on import'
            : 'Imported; awaiting curator review',
        })),
      );
    }

    return {
      kind: 'concept_map',
      key: map.key,
      version: map.version,
      id: created.id,
      result: 'imported',
      counts: {
        elements: release.elements.length,
        approved,
        awaitingReview: release.elements.length - approved,
      },
    };
  });
}
