import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * That `docs/configuration.md` still describes the configuration
 * (sp7-plan.md, T1).
 *
 * Documentation that drifts is worse than none: somebody sets a system up from
 * it, believes they are done, and finds out in production. This reads the
 * schema and the page and fails if either holds a variable the other does not.
 *
 * It matches on the variable names rather than the prose, so the page can be
 * rewritten freely — it only has to keep naming every variable, and no others.
 */

const HERE = __dirname;

const schemaSource = readFileSync(path.join(HERE, 'env.ts'), 'utf8');
const page = readFileSync(
  path.resolve(HERE, '..', '..', '..', '..', 'docs', 'configuration.md'),
  'utf8',
);

/** The keys declared in the Zod object, which are indented by four spaces. */
function variablesInSchema(): string[] {
  return [...schemaSource.matchAll(/^ {4}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]!);
}

/** The variables the page documents: the first cell of each table row. */
function variablesInPage(): string[] {
  return [...page.matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((match) => match[1]!);
}

describe('the configuration page', () => {
  it('reads both the schema and the page', () => {
    // A guard on the matching itself: a regex that stopped matching would
    // otherwise make every assertion below pass against nothing.
    expect(variablesInSchema().length).toBeGreaterThan(20);
    expect(variablesInPage().length).toBeGreaterThan(20);
  });

  it('documents every variable the system reads', () => {
    const documented = new Set(variablesInPage());
    const undocumented = variablesInSchema().filter((name) => !documented.has(name));

    expect(undocumented, 'variables in env.ts that docs/configuration.md does not mention').toEqual(
      [],
    );
  });

  it('documents nothing the system does not read', () => {
    const known = new Set(variablesInSchema());
    const invented = variablesInPage().filter((name) => !known.has(name));

    expect(invented, 'variables in docs/configuration.md that env.ts does not read').toEqual([]);
  });
});
