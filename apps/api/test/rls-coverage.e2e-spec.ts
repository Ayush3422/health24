import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { resetDatabase, testDb } from './harness';

/**
 * That every table is protected at all (sp6-plan.md, T23).
 *
 * The other row-level security tests prove that the policies on the tables
 * they name behave correctly. This one proves there is no table without them:
 * it sweeps the whole schema and fails on anything new that is not either
 * protected or deliberately listed below.
 *
 * It exists because the failure it catches is silent. A table added without
 * `ENABLE ROW LEVEL SECURITY` works perfectly in every test — the application
 * scopes its own queries — and leaks every hospital's rows to any query that
 * forgets to. The list beneath is the only way past it, and adding a name to
 * it is a decision somebody has to write down.
 */

/** The shared vocabularies: one copy for the platform, read by everybody. */
const SHARED_VOCABULARY = [
  'code_system',
  'concept',
  'concept_designation',
  'concept_map',
  'concept_map_element',
  'concept_map_review',
];

/**
 * The directory of hospitals, which is a public list by design: a patient
 * looking for their old hospital has to be able to find it. Row-level security
 * is enabled but not forced, because the table is written only by a trigger
 * running as its owner — the application role holds no write grant on it at
 * all, which is the stronger statement.
 */
const NOT_FORCED = ['hospital_directory'];

/** Tables SP6 added, and what each must not lose. */
const SP6_TABLES = [
  'service_request',
  'ward',
  'bed',
  'bed_stay',
  'implant_device',
  'discharge_summary',
  'service_catalogue_item',
  'charge',
  'invoice',
  'invoice_line',
  'invoice_insurance',
  'invoice_number_series',
  'payment_entry',
  'daily_summary',
  'statutory_return',
];

/**
 * The SP6 tables that hold a record rather than the hospital's own furniture.
 * A ward is renamed and a bed is blocked; a charge, a stay or a return is
 * never quietly rewritten, so each of these carries the guard trigger.
 */
const SP6_GUARDED = SP6_TABLES.filter((table) => !['ward', 'bed'].includes(table));

/** The functions that refuse a rewrite, whichever table they sit on. */
const GUARD_FUNCTIONS = [
  'guard_clinical_row',
  'guard_discharge_summary',
  'guard_invoice_counter',
];

type TableRow = {
  name: string;
  rls: boolean;
  forced: boolean;
  policies: number;
  tenanted: boolean;
};

describe('row-level security across the whole schema', () => {
  let owner: postgres.Sql;
  let close: () => Promise<void>;
  let tables: TableRow[];

  beforeAll(async () => {
    await resetDatabase();

    const connection = testDb();
    owner = connection.client;
    close = connection.close;

    tables = [
      ...(await owner<TableRow[]>`
        SELECT c.relname AS name,
               c.relrowsecurity AS rls,
               c.relforcerowsecurity AS forced,
               (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
               EXISTS (
                 SELECT 1 FROM information_schema.columns col
                  WHERE col.table_schema = 'public'
                    AND col.table_name = c.relname
                    AND col.column_name IN ('hospital_id', 'patient_id')
               ) AS tenanted
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname
      `),
    ];
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it('leaves no table unprotected', () => {
    const unprotected = tables
      .filter((table) => !table.rls && !SHARED_VOCABULARY.includes(table.name))
      .map((table) => table.name);

    expect(unprotected, 'these tables have no row-level security').toEqual([]);
  });

  it('forces it, so that owning a table is not a way past it', () => {
    const unforced = tables
      .filter(
        (table) =>
          table.rls &&
          !table.forced &&
          !SHARED_VOCABULARY.includes(table.name) &&
          !NOT_FORCED.includes(table.name),
      )
      .map((table) => table.name);

    expect(unforced, 'these tables enable row-level security without forcing it').toEqual([]);
  });

  it('gives every protected table at least one policy, rather than denying everything', () => {
    const policyless = tables
      .filter((table) => table.rls && table.policies === 0)
      .map((table) => table.name);

    expect(policyless).toEqual([]);
  });

  it('protects every table that holds a hospital’s or a patient’s rows', () => {
    const tenanted = tables.filter((table) => table.tenanted);

    // A sanity check on the sweep itself: if this ever found nothing, the
    // three tests above would pass against an empty schema.
    expect(tenanted.length).toBeGreaterThan(20);
    expect(tenanted.every((table) => table.rls && table.forced)).toBe(true);
  });

  it('protects everything SP6 added', () => {
    const found = new Map(tables.map((table) => [table.name, table]));
    const missing = SP6_TABLES.filter((name) => !found.has(name));

    expect(missing, 'SP6 tables that are not in the database').toEqual([]);

    const leaky = SP6_TABLES.filter((name) => {
      const table = found.get(name)!;
      return !table.rls || !table.forced || table.policies === 0;
    });

    expect(leaky).toEqual([]);
  });

  it('keeps every SP6 record under the guard that refuses a rewrite', async () => {
    const guarded = await owner<Array<{ table_name: string }>>`
      SELECT DISTINCT c.relname AS table_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE n.nspname = 'public'
         AND NOT t.tgisinternal
         AND p.proname = ANY (${GUARD_FUNCTIONS})
    `;

    const names = new Set(guarded.map((row) => row.table_name));
    const unguarded = SP6_GUARDED.filter((table) => !names.has(table));

    expect(unguarded, 'these SP6 tables can be rewritten in place').toEqual([]);
  });
});
