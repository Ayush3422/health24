import { createHash } from 'node:crypto';
import type { ConceptMapRelease, TerminologyRelease } from '@health24/shared';

/**
 * Content hashes for terminology releases.
 *
 * The hash is what makes re-import safe. Importing the identical release twice
 * must be a no-op, and importing the same version with different content must
 * be refused — a published code set that silently changes underneath existing
 * patient records is a data-integrity failure, and CC BY-ND forbids adapting
 * ICD-11 content in any case.
 *
 * So the hash must depend on what a release says, not on how its file happens
 * to be laid out. Key order, concept order and designation order are all
 * normalised away. It is computed on the parsed release, after schema defaults
 * are applied, so an omitted `experimental` and an explicit `false` agree.
 */

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;

    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalise(record[key])]),
    );
  }

  return value;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalise(value)))
    .digest('hex');
}

export function hashCodeSystemRelease(release: TerminologyRelease): string {
  return sha256({
    codeSystem: release.codeSystem,
    concepts: [...release.concepts]
      .sort((a, b) => byText(a.code, b.code))
      .map((concept) => ({
        ...concept,
        designations: [...concept.designations].sort((a, b) =>
          byText(`${a.language}|${a.use}|${a.value}`, `${b.language}|${b.use}|${b.value}`),
        ),
      })),
  });
}

export function hashConceptMapRelease(release: ConceptMapRelease): string {
  return sha256({
    map: release.map,
    elements: [...release.elements].sort((a, b) =>
      byText(`${a.sourceCode}|${a.targetCode ?? ''}`, `${b.sourceCode}|${b.targetCode ?? ''}`),
    ),
  });
}
