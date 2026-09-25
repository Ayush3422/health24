import postgres from 'postgres';
import { decryptWithAnyKey, encryptSecret } from '../common/crypto';
import { loadEnv } from '../config/load-env';

loadEnv();

/**
 * Rewrites every encrypted secret under the current key (sp7-plan.md, T4).
 *
 * Run in the middle of a key rotation, while both `TOTP_ENCRYPTION_KEY` and
 * `TOTP_ENCRYPTION_KEY_PREVIOUS` are set: the application already reads under
 * either key, and this moves the rows across so the old key can be withdrawn.
 * The procedure around it is `docs/runbooks/key-rotation.md`.
 *
 * Runs as the owner, because it touches every hospital's rows and belongs to
 * nobody's tenant context. It reads and writes nothing but ciphertext — no
 * secret is logged, and the counts below are all it prints.
 */

type Target = {
  table: string;
  idColumn: string;
  column: string;
  /** What this holds, for the summary line. */
  what: string;
};

const TARGETS: Target[] = [
  {
    table: 'staff_user',
    idColumn: 'id',
    column: 'totp_secret_encrypted',
    what: 'second-factor secrets',
  },
  {
    table: 'emergency_card',
    idColumn: 'id',
    column: 'token_encrypted',
    what: 'emergency card tokens',
  },
];

export type Counts = { total: number; rewritten: number; unreadable: number };

export async function rewrap(
  sql: postgres.Sql,
  target: Target,
  keys: string[],
): Promise<Counts> {
  const counts: Counts = { total: 0, rewritten: 0, unreadable: 0 };

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.system_context', 'on', true)`;

    const rows = await tx<Array<{ id: string; value: string }>>`
      SELECT ${tx(target.idColumn)} AS id, ${tx(target.column)} AS value
        FROM ${tx(target.table)}
       WHERE ${tx(target.column)} IS NOT NULL
    `;

    for (const row of rows) {
      counts.total += 1;

      let read: { plaintext: string; keyIndex: number };

      try {
        read = decryptWithAnyKey(row.value, keys);
      } catch {
        // Neither key opens it. Left exactly as it is: a row nobody can read
        // is a problem to investigate, not one to overwrite.
        counts.unreadable += 1;
        continue;
      }

      // Already under the current key.
      if (read.keyIndex === 0) continue;

      await tx`
        UPDATE ${tx(target.table)}
           SET ${tx(target.column)} = ${encryptSecret(read.plaintext, keys[0]!)}
         WHERE ${tx(target.idColumn)} = ${row.id}
      `;

      counts.rewritten += 1;
    }
  });

  return counts;
}

/** Every target, under the given keys. Exported so a test can prove it works. */
export async function rewrapAll(
  sql: postgres.Sql,
  keys: string[],
): Promise<Record<string, Counts>> {
  const counted: Record<string, Counts> = {};

  for (const target of TARGETS) {
    counted[target.table] = await rewrap(sql, target, keys);
  }

  return counted;
}

async function main(): Promise<void> {
  const current = process.env.TOTP_ENCRYPTION_KEY;
  const previous = process.env.TOTP_ENCRYPTION_KEY_PREVIOUS;

  if (!current) throw new Error('TOTP_ENCRYPTION_KEY is not set');
  if (!previous) {
    throw new Error(
      'TOTP_ENCRYPTION_KEY_PREVIOUS is not set. Set both keys while rotating; ' +
        'without the old key there is nothing to rewrite from.',
    );
  }

  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Neither DATABASE_ADMIN_URL nor DATABASE_URL is set');

  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    const counted = await rewrapAll(sql, [current, previous]);
    let unreadable = 0;

    for (const target of TARGETS) {
      const counts = counted[target.table]!;
      unreadable += counts.unreadable;

      console.log(
        `${target.what}: ${counts.rewritten} rewritten, ` +
          `${counts.total - counts.rewritten - counts.unreadable} already current, ` +
          `${counts.unreadable} unreadable`,
      );
    }

    if (unreadable > 0) {
      throw new Error(
        `${unreadable} secrets could not be read with either key. ` +
          'Do not withdraw the old key: find out what wrote them first.',
      );
    }

    console.log('Every secret is now under the current key. The old one can be withdrawn.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only when run as a script: importing this module must not touch a database.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
