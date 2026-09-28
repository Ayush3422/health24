import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * That the documentation still points at things that exist (sp7-plan.md, T30).
 *
 * A runbook is read once, at three in the morning, by somebody who did not
 * write it. Every wrong path and every command that no longer exists costs them
 * minutes they do not have — and the failure is silent, because nothing runs a
 * runbook until it is needed.
 *
 * The walk-through that produced this found a query in the breach runbook
 * naming a column the table does not have (`actor_kind`, for `actor_type`). A
 * person had to run it to find that. These checks are the part that can be
 * automated: links, and the commands the runbooks tell somebody to type.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const DOCS = path.join(REPO, 'docs');

/** Every markdown file under `docs/`, and the plans beside them. */
function markdownFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = path.join(directory, entry);

      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) found.push(full);
    }
  };

  walk(DOCS);

  for (const entry of readdirSync(REPO)) {
    if (entry.endsWith('-plan.md') || entry === 'planning.md' || entry === 'features.md') {
      found.push(path.join(REPO, entry));
    }
  }

  return found;
}

/**
 * What a page tells somebody to type: fenced blocks and inline code.
 *
 * Prose mentioning pnpm workspaces is not an instruction, and treating it as
 * one is how a useful check becomes a check somebody disables.
 */
function typedCommands(text: string): string {
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((block) => block[1] ?? '');
  const inline = [...text.matchAll(/`([^`\n]+)`/g)].map((span) => span[1] ?? '');

  return [...fenced, ...inline].join('\n');
}

const files = markdownFiles();

describe('the documentation', () => {
  it('is where this test thinks it is', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => file.endsWith('restore.md'))).toBe(true);
  });

  it('links only to files that exist', () => {
    const broken: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf8');

      // `[something](a/relative/path.md)` — not URLs, not anchors.
      for (const match of text.matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
        const target = match[1]!;
        if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;

        const resolved = path.resolve(path.dirname(file), target);
        if (!existsSync(resolved)) {
          broken.push(`${path.relative(REPO, file)} -> ${target}`);
        }
      }
    }

    expect(broken, 'links in the documentation that point at nothing').toEqual([]);
  });

  it('tells people to run commands that exist', () => {
    const scripts = new Set<string>();

    for (const manifest of [
      path.join(REPO, 'package.json'),
      path.join(REPO, 'apps', 'api', 'package.json'),
      path.join(REPO, 'apps', 'clinical', 'package.json'),
      path.join(REPO, 'apps', 'portal', 'package.json'),
      path.join(REPO, 'packages', 'shared', 'package.json'),
    ]) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        scripts?: Record<string, string>;
      };

      for (const name of Object.keys(parsed.scripts ?? {})) scripts.add(name);
    }

    // pnpm's own verbs, not ours.
    const pnpmVerbs = new Set([
      'install',
      'add',
      'exec',
      'why',
      'audit',
      'dlx',
      'deploy',
      'approve-builds',
      'run',
    ]);

    const missing: string[] = [];

    for (const file of files) {
      const commands = typedCommands(readFileSync(file, 'utf8'));

      // `pnpm --filter @health24/api db:restore-drill`, and `pnpm lint`.
      for (const match of commands.matchAll(
        /pnpm(?:\s+(?:--filter|-C)\s+\S+)?\s+(?:run\s+)?([a-z][a-z0-9:-]*)/g,
      )) {
        const script = match[1]!;
        if (pnpmVerbs.has(script)) continue;

        if (!scripts.has(script)) missing.push(`${path.relative(REPO, file)} -> pnpm ${script}`);
      }
    }

    expect(missing, 'commands the documentation names that no package defines').toEqual([]);
  });

  it('keeps every runbook in one place, so that one of them can be found', () => {
    const runbooks = readdirSync(path.join(DOCS, 'runbooks')).filter((file) =>
      file.endsWith('.md'),
    );

    expect(runbooks.sort()).toEqual([
      'breach-notification.md',
      'incident-response.md',
      'key-rotation.md',
      'migrations.md',
      'on-call.md',
      'restore.md',
    ]);
  });
});
