import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  conceptMapReleaseSchema,
  terminologyReleaseSchema,
  type TerminologyRelease,
} from '@health24/shared';
import {
  activateCodeSystem,
  importCodeSystemRelease,
  importConceptMapRelease,
  ReleaseImportError,
} from '../src/modules/terminology/terminology-import';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  seedPlatformAdmin,
  seedPlatformUser,
  signIn,
  testDb,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * The terminology service, end to end.
 *
 * Runs against the synthetic demo releases that ship with the repository, so
 * it exercises the same files a developer loads with `pnpm terminology:load-demo`.
 * The demo TM2 map is authoritative and the demo biomedical map requires
 * review — mirroring the real situation, in which an official NAMASTE → TM2
 * mapping exists and no official biomedical one was found.
 *
 * Tests run in order and build on one another: approvals made in the curation
 * block are what the coverage assertions count.
 */

const DEMO_DIR = path.resolve(__dirname, '..', 'data', 'terminology', 'demo');
const load = (file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(DEMO_DIR, file), 'utf8'));

describe('terminology', () => {
  let ctx: TestContext;
  let owner: ReturnType<typeof testDb>;

  let clinician: string;
  let frontDesk: string;
  let platformAdmin: string;
  let curatorA: string;
  let curatorB: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();
    owner = testDb();

    for (const file of ['demo-namaste.json', 'demo-icd11-tm2.json', 'demo-icd11-mms.json']) {
      const outcome = await importCodeSystemRelease(
        owner.db,
        terminologyReleaseSchema.parse(load(file)),
        'test',
      );
      await activateCodeSystem(owner.db, outcome.id, null);
    }

    for (const file of ['map-namaste-icd11-tm2.json', 'map-namaste-icd11-mms.json']) {
      await importConceptMapRelease(owner.db, conceptMapReleaseSchema.parse(load(file)), 'test');
    }

    const hospital = await seedHospital({ name: 'Terminology Test Hospital', mrnPrefix: 'TTH' });
    clinician = await signIn(ctx, hospital.staff.clinician as SeededStaff);
    frontDesk = await signIn(ctx, hospital.staff.frontDesk as SeededStaff);
    platformAdmin = await signIn(ctx, await seedPlatformAdmin());
    curatorA = await signIn(
      ctx,
      await seedPlatformUser({
        role: 'terminology_curator',
        email: 'curator.a@example.in',
        name: 'Curator A',
      }),
    );
    curatorB = await signIn(
      ctx,
      await seedPlatformUser({
        role: 'terminology_curator',
        email: 'curator.b@example.in',
        name: 'Curator B',
      }),
    );
  });

  afterAll(async () => {
    await owner?.close();
    await ctx?.close();
  });

  const get = (url: string, token: string) =>
    ctx.http().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`);

  const post = (url: string, token: string, body: object) =>
    ctx.http().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`).send(body);

  async function elementId(mapKey: string, sourceCode: string, status: string): Promise<string> {
    const rows = (await owner.db.execute(sql`
      SELECT e.id
        FROM concept_map_element e
        JOIN concept_map m ON m.id = e.concept_map_id
       WHERE m.key = ${mapKey}
         AND e.source_code = ${sourceCode}
         AND e.status = ${status}::map_element_status
    ORDER BY e.created_at DESC
       LIMIT 1
    `)) as unknown as Array<{ id: string }>;

    if (!rows[0]) throw new Error(`No ${status} element for ${mapKey} ${sourceCode}`);
    return rows[0].id;
  }

  async function mapId(key: string): Promise<string> {
    const rows = (await owner.db.execute(
      sql`SELECT id FROM concept_map WHERE key = ${key}`,
    )) as unknown as Array<{ id: string }>;

    if (!rows[0]) throw new Error(`No map ${key}`);
    return rows[0].id;
  }

  // -------------------------------------------------------------------------

  describe('ingestion', () => {
    it('treats re-importing an identical release as a no-op', async () => {
      const outcome = await importCodeSystemRelease(
        owner.db,
        terminologyReleaseSchema.parse(load('demo-namaste.json')),
        'test',
      );

      expect(outcome.result).toBe('unchanged');
    });

    it('refuses the same version with different content', async () => {
      // A published release that silently changes underneath records already
      // coded against it is the failure this whole design exists to prevent.
      const release = terminologyReleaseSchema.parse(load('demo-namaste.json'));
      const tampered: TerminologyRelease = {
        ...release,
        concepts: release.concepts.map((concept) =>
          concept.code === 'DEMO-NAM-001'
            ? { ...concept, display: 'Amlapitta (silently edited)' }
            : concept,
        ),
      };

      await expect(importCodeSystemRelease(owner.db, tampered, 'test')).rejects.toThrow(
        ReleaseImportError,
      );
    });

    it('refuses a map that references codes the code system does not contain', async () => {
      const release = conceptMapReleaseSchema.parse({
        map: {
          key: 'probe-unknown-codes',
          name: 'Probe',
          version: 'v1',
          publisher: 'Test',
          source: { key: 'namaste', version: 'demo-1' },
          target: { key: 'icd11-tm2', version: 'demo-1' },
          experimental: true,
        },
        elements: [
          {
            sourceCode: 'DEMO-NAM-001',
            targetCode: 'DEMO-TM2-NOT-REAL',
            equivalence: 'equivalent',
          },
        ],
      });

      await expect(importConceptMapRelease(owner.db, release, 'test')).rejects.toThrow(
        /unknown codes/,
      );
    });

    it('refuses to let demo code systems sit behind a map not marked experimental', async () => {
      const release = conceptMapReleaseSchema.parse({
        map: {
          key: 'probe-not-experimental',
          name: 'Probe',
          version: 'v1',
          publisher: 'Test',
          source: { key: 'namaste', version: 'demo-1' },
          target: { key: 'icd11-tm2', version: 'demo-1' },
          experimental: false,
        },
        elements: [
          { sourceCode: 'DEMO-NAM-001', targetCode: 'DEMO-TM2-01', equivalence: 'equivalent' },
        ],
      });

      await expect(importConceptMapRelease(owner.db, release, 'test')).rejects.toThrow(
        /experimental/,
      );
    });

    it('lands an authoritative map approved and a review-required map proposed', async () => {
      const rows = (await owner.db.execute(sql`
        SELECT m.key, e.status, count(*)::int AS n
          FROM concept_map_element e
          JOIN concept_map m ON m.id = e.concept_map_id
      GROUP BY 1, 2
      ORDER BY 1, 2
      `)) as unknown as Array<{ key: string; status: string; n: number }>;

      expect(rows).toEqual([
        { key: 'namaste-to-icd11-mms', status: 'proposed', n: 6 },
        { key: 'namaste-to-icd11-tm2', status: 'approved', n: 9 },
      ]);
    });
  });

  // -------------------------------------------------------------------------

  describe('search', () => {
    it.each(['अम्लपित्त', 'amlapitta', 'Amlapitta', 'AMLAPITTA'])(
      'reaches Amlapitta from "%s"',
      async (query) => {
        const response = await get(
          `/terminology/search?system=namaste&q=${encodeURIComponent(query)}`,
          clinician,
        );

        expect(response.status).toBe(200);
        expect(response.body[0]?.code).toBe('DEMO-NAM-001');
      },
    );

    it('ranks a prefix first while the clinician is still typing', async () => {
      const response = await get('/terminology/search?system=namaste&q=amla', clinician);
      expect(response.body[0]?.code).toBe('DEMO-NAM-001');
    });

    it('matches the start of any word in a multi-word term', async () => {
      const response = await get('/terminology/search?system=namaste&q=vata', clinician);
      expect(response.body.map((result: { code: string }) => result.code)).toContain(
        'DEMO-NAM-008',
      );
    });

    it('tolerates a typo', async () => {
      const response = await get('/terminology/search?system=namaste&q=amlapita', clinician);
      expect(response.body[0]?.code).toBe('DEMO-NAM-001');
    });

    it('returns the term in its original scripts, never the folded form', async () => {
      const response = await get('/terminology/search?system=namaste&q=amlapitta', clinician);
      const values = response.body[0].designations.map((d: { value: string }) => d.value);

      expect(values).toContain('अम्लपित्त');
      expect(values).not.toContain('amlapitt');
    });

    it('flags demo terminology as experimental', async () => {
      const response = await get('/terminology/search?system=namaste&q=jvara', clinician);
      expect(response.body[0]?.experimental).toBe(true);
    });

    it('returns nothing for input that folds to nothing', async () => {
      const response = await get('/terminology/search?system=namaste&q=--', clinician);

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });

    it('refuses a role with no terminology access', async () => {
      const response = await get('/terminology/search?system=namaste&q=jvara', frontDesk);
      expect(response.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------

  describe('lookup', () => {
    it('resolves a concept with its parent and attribution', async () => {
      const response = await get('/terminology/systems/namaste/concepts/DEMO-NAM-001', clinician);

      expect(response.status).toBe(200);
      expect(response.body.parent?.code).toBe('DEMO-NAM-GRP-1');
      expect(response.body.codeSystem.attribution).toBeTruthy();
    });

    it('lists the children of a group', async () => {
      const response = await get('/terminology/systems/namaste/concepts/DEMO-NAM-GRP-1', clinician);

      expect(response.body.children.map((child: { code: string }) => child.code)).toEqual([
        'DEMO-NAM-001',
        'DEMO-NAM-002',
        'DEMO-NAM-003',
      ]);
    });

    it('returns 404 for a code that does not exist', async () => {
      const response = await get('/terminology/systems/namaste/concepts/DEMO-NAM-999', clinician);
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------

  describe('translation and auto-coding', () => {
    it('translates using approved mappings only', async () => {
      // DEMO-NAM-001 also has a biomedical mapping, but it is only proposed.
      const response = await get(
        '/terminology/translate?system=namaste&code=DEMO-NAM-001',
        clinician,
      );

      expect(response.status).toBe(200);
      expect(response.body.translations.map((t: { code: string }) => t.code)).toEqual([
        'DEMO-TM2-01',
      ]);
    });

    it('attaches the TM2 translation and withholds an unreviewed biomedical code', async () => {
      const response = await get(
        '/terminology/auto-code?system=namaste&code=DEMO-NAM-001',
        clinician,
      );

      expect(response.status).toBe(200);
      expect(response.body.primary.code).toBe('DEMO-NAM-001');
      expect(response.body.translated).toMatchObject({ code: 'DEMO-TM2-01', role: 'translated' });
      expect(response.body.advisory).toBeNull();
      expect(response.body.notes[0]).toBe(
        'Demo terminology — not for use on a real patient record.',
      );
      expect(response.body.notes).toContain(
        'A biomedical mapping for this code is awaiting curator review and is not attached.',
      );
    });

    it('explains a reviewed code with no TM2 correspondence', async () => {
      const response = await get(
        '/terminology/auto-code?system=namaste&code=DEMO-NAM-009',
        clinician,
      );

      expect(response.body.translated).toBeNull();
      expect(response.body.notes).toContain('Reviewed: this code has no TM2 correspondence.');
    });

    it('explains a code nobody has mapped yet, rather than failing', async () => {
      const response = await get(
        '/terminology/auto-code?system=namaste&code=DEMO-NAM-010',
        clinician,
      );

      expect(response.status).toBe(200);
      expect(response.body.translated).toBeNull();
      expect(response.body.advisory).toBeNull();
      expect(response.body.notes).toContain('No reviewed TM2 mapping exists for this code yet.');
    });
  });

  // -------------------------------------------------------------------------

  describe('curation', () => {
    let supersededId: string;
    let correctionId: string;

    it('lists imported proposals, all reviewable', async () => {
      const response = await get('/terminology/review-queue', curatorA);

      expect(response.status).toBe(200);
      expect(response.body.total).toBe(6);
      expect(
        response.body.results.every(
          (item: { status: string; canReview: boolean }) =>
            item.status === 'proposed' && item.canReview,
        ),
      ).toBe(true);
    });

    it('turns an approved wider biomedical mapping into an advisory code', async () => {
      const id = await elementId('namaste-to-icd11-mms', 'DEMO-NAM-001', 'proposed');

      const review = await post(`/terminology/map-elements/${id}/review`, curatorA, {
        decision: 'approve',
        comment: 'Checked against the demo source',
      });
      expect(review.status).toBe(200);
      expect(review.body.status).toBe('approved');

      const coded = await get('/terminology/auto-code?system=namaste&code=DEMO-NAM-001', clinician);
      expect(coded.body.advisory).toMatchObject({
        code: 'DEMO-MMS-01',
        role: 'advisory',
        equivalence: 'wider',
        conceptMapElementId: id,
      });
    });

    it('still withholds an approved inexact biomedical mapping', async () => {
      const id = await elementId('namaste-to-icd11-mms', 'DEMO-NAM-002', 'proposed');

      await post(`/terminology/map-elements/${id}/review`, curatorA, {
        decision: 'approve',
        comment: 'Recorded as inexact',
      });

      const coded = await get('/terminology/auto-code?system=namaste&code=DEMO-NAM-002', clinician);
      expect(coded.body.advisory).toBeNull();
      expect(coded.body.notes.join(' ')).toContain('inexact');
    });

    it('refuses a second decision on the same mapping', async () => {
      const id = await elementId('namaste-to-icd11-mms', 'DEMO-NAM-001', 'approved');

      const again = await post(`/terminology/map-elements/${id}/review`, curatorB, {
        decision: 'reject',
        comment: 'Trying to overturn',
      });

      expect(again.status).toBe(409);
    });

    it('refuses a proposal pointing at a code the target system lacks', async () => {
      const response = await post('/terminology/map-elements', curatorA, {
        conceptMapId: await mapId('namaste-to-icd11-mms'),
        sourceCode: 'DEMO-NAM-003',
        targetCode: 'DEMO-MMS-NOT-REAL',
        equivalence: 'wider',
        comment: 'Probe',
      });

      expect(response.status).toBe(400);
    });

    it('stops a curator approving their own correction', async () => {
      supersededId = await elementId('namaste-to-icd11-tm2', 'DEMO-NAM-004', 'approved');

      const proposal = await post('/terminology/map-elements', curatorA, {
        conceptMapId: await mapId('namaste-to-icd11-tm2'),
        sourceCode: 'DEMO-NAM-004',
        targetCode: 'DEMO-TM2-04',
        equivalence: 'wider',
        comment: 'The correspondence is broader than recorded',
        supersedesElementId: supersededId,
      });

      expect(proposal.status).toBe(201);
      correctionId = proposal.body.id;

      const ownReview = await post(`/terminology/map-elements/${correctionId}/review`, curatorA, {
        decision: 'approve',
        comment: 'Approving my own work',
      });
      expect(ownReview.status).toBe(403);

      const queue = await get('/terminology/review-queue', curatorA);
      const item = queue.body.results.find((entry: { id: string }) => entry.id === correctionId);
      expect(item?.canReview).toBe(false);
    });

    it('keeps the original mapping approved until the correction is approved', async () => {
      // There must never be a gap in which the code has no approved mapping
      // merely because a correction is pending.
      const translated = await get(
        '/terminology/translate?system=namaste&code=DEMO-NAM-004',
        clinician,
      );
      expect(translated.body.translations).toMatchObject([
        { code: 'DEMO-TM2-04', equivalence: 'equivalent', conceptMapElementId: supersededId },
      ]);
    });

    it('lets a second curator approve the correction, retiring the original', async () => {
      const review = await post(`/terminology/map-elements/${correctionId}/review`, curatorB, {
        decision: 'approve',
        comment: 'Agreed',
      });

      expect(review.status).toBe(200);
      expect(review.body.retiredElementId).toBe(supersededId);

      const translated = await get(
        '/terminology/translate?system=namaste&code=DEMO-NAM-004',
        clinician,
      );
      expect(translated.body.translations).toMatchObject([
        { code: 'DEMO-TM2-04', equivalence: 'wider', conceptMapElementId: correctionId },
      ]);
    });

    it('keeps the history of both the original and its correction', async () => {
      const original = await get(`/terminology/map-elements/${supersededId}/history`, curatorB);
      expect(original.body.map((entry: { action: string }) => entry.action)).toEqual([
        'import',
        'retire',
      ]);

      const correction = await get(`/terminology/map-elements/${correctionId}/history`, curatorB);
      expect(
        correction.body.map((entry: { action: string; actorLabel: string }) => [
          entry.action,
          entry.actorLabel.split(' <')[0],
        ]),
      ).toEqual([
        ['propose', 'Curator A'],
        ['approve', 'Curator B'],
      ]);
    });

    it('refuses an identical proposal while one is already waiting', async () => {
      const body = {
        conceptMapId: await mapId('namaste-to-icd11-mms'),
        sourceCode: 'DEMO-NAM-003',
        targetCode: 'DEMO-MMS-01',
        equivalence: 'wider',
        comment: 'Proposed once',
      };

      expect((await post('/terminology/map-elements', curatorA, body)).status).toBe(201);
      expect((await post('/terminology/map-elements', curatorB, body)).status).toBe(409);
    });

    it('reports coverage per map', async () => {
      const response = await get('/terminology/coverage', platformAdmin);
      expect(response.status).toBe(200);

      const byKey = Object.fromEntries(
        response.body.map((entry: { conceptMap: { key: string } }) => [
          entry.conceptMap.key,
          entry,
        ]),
      );

      // 12 NAMASTE concepts. TM2: 8 mapped, 1 reviewed as unmatched, and the
      // two groups plus DEMO-NAM-010 never mapped.
      expect(byKey['namaste-to-icd11-tm2']).toMatchObject({
        sourceConcepts: 12,
        mapped: 8,
        reviewedUnmatched: 1,
        unreviewed: 3,
        awaitingReview: 0,
      });

      // Biomedical: two approved above; four imported proposals remain, plus
      // the one new proposal for DEMO-NAM-003.
      expect(byKey['namaste-to-icd11-mms']).toMatchObject({
        sourceConcepts: 12,
        mapped: 2,
        reviewedUnmatched: 0,
        unreviewed: 10,
        awaitingReview: 5,
      });
    });

    it('audits curation decisions and proposals', async () => {
      const rows = (await owner.db.execute(sql`
        SELECT action, count(*)::int AS n
          FROM access_log
         WHERE resource_type = 'concept_map_element'
      GROUP BY action
      `)) as unknown as Array<{ action: string; n: number }>;

      const counts = Object.fromEntries(rows.map((row) => [row.action, row.n]));

      // Three approvals (two by A, one by B) and two accepted proposals. The
      // refused self-approval and the duplicate proposal wrote nothing.
      expect(counts.update).toBe(3);
      expect(counts.create).toBe(2);
    });
  });

  // -------------------------------------------------------------------------

  describe('release lifecycle', () => {
    it('does not let a curator activate a release', async () => {
      const systems = await get('/terminology/systems', curatorA);
      const namaste = systems.body.find((system: { key: string }) => system.key === 'namaste');

      const response = await post(`/terminology/systems/${namaste.id}/activate`, curatorA, {});
      expect(response.status).toBe(403);
    });

    it('activates a new version, retiring the old, while old codes stay resolvable', async () => {
      const base = terminologyReleaseSchema.parse(load('demo-namaste.json'));
      const next = terminologyReleaseSchema.parse({
        ...base,
        codeSystem: { ...base.codeSystem, version: 'demo-2' },
        concepts: [
          ...base.concepts,
          {
            code: 'DEMO-NAM-011',
            display: 'Pandu',
            designations: [{ language: 'sa-Deva', use: 'transliteration', value: 'पाण्डु' }],
          },
        ],
      });

      const outcome = await importCodeSystemRelease(owner.db, next, 'test');
      expect(outcome.result).toBe('imported');

      const activation = await post(
        `/terminology/systems/${outcome.id}/activate`,
        platformAdmin,
        {},
      );
      expect(activation.status).toBe(200);
      expect(activation.body.changed).toBe(true);

      const repeated = await post(`/terminology/systems/${outcome.id}/activate`, platformAdmin, {});
      expect(repeated.body.changed).toBe(false);

      const systems = await get('/terminology/systems', platformAdmin);
      const namaste = systems.body
        .filter((system: { key: string }) => system.key === 'namaste')
        .map((system: { version: string; status: string }) => [system.version, system.status]);

      expect(namaste).toEqual(
        expect.arrayContaining([
          ['demo-2', 'active'],
          ['demo-1', 'retired'],
        ]),
      );

      // Search now runs against demo-2.
      const found = await get('/terminology/search?system=namaste&q=pandu', clinician);
      expect(found.body[0]?.code).toBe('DEMO-NAM-011');
      expect(found.body[0]?.systemVersion).toBe('demo-2');

      // A code on a record made under demo-1 still resolves against demo-1.
      const old = await get(
        '/terminology/systems/namaste/concepts/DEMO-NAM-001?version=demo-1',
        clinician,
      );
      expect(old.status).toBe(200);
      expect(old.body.concept.systemVersion).toBe('demo-1');
    });
  });
});
