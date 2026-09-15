import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  resetDatabase,
  seedHospital,
  seedPlatformAdmin,
  seedPlatformUser,
  signIn,
  type SeededStaff,
  type TestContext,
} from './harness';

/**
 * The authorisation suite.
 *
 * Two jobs. First, assert that every role gets the access it should and none
 * that it should not. Second — and this is the part still working after
 * everyone has forgotten this file exists — fail the build when a route is
 * added that nobody has classified. A new endpoint cannot ship without someone
 * deciding who may call it.
 */

type RoleKey =
  | 'platformAdmin'
  | 'admin'
  | 'clinician'
  | 'frontDesk'
  | 'records'
  | 'otherHospitalAdmin'
  | 'curator';

const ALL_ROLES: RoleKey[] = [
  'platformAdmin',
  'admin',
  'clinician',
  'frontDesk',
  'records',
  'otherHospitalAdmin',
  'curator',
];

/**
 * What to substitute for a route's `:id`.
 *
 * This matters more than it looks. Probing `PATCH /hospitals/:id` with a
 * foreign id gets a hospital admin a 403 — correctly, since they may only edit
 * their own — which would read as a permission failure when it is actually the
 * service doing its job. The probe has to ask the question it means to ask.
 */
type ParamStrategy =
  | 'absent' // an id that will never exist
  | 'ownHospital' // the calling role's own hospital
  | 'disposableStaff'; // a staff account created solely to be poked at

interface RouteExpectation {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  /** Roles that must get past the authentication and permission guards. */
  allow: RoleKey[];
  body?: Record<string, unknown>;
  param?: ParamStrategy;
  public?: boolean;
  /**
   * Excluded from the role probe because calling it destroys the credentials
   * the probe is using. Still classified, still required to reject
   * unauthenticated callers, and covered by dedicated tests below.
   */
  selfDestructive?: boolean;
  /**
   * A patient portal route (SP5): reached only with a patient session, so every
   * staff token is refused with 401. Probed separately from the role matrix.
   */
  portal?: boolean;
}

const EVERY_ROLE = ALL_ROLES;

/** Terminology is reference data, read by those who code diagnoses or curate mappings. */
const TERMINOLOGY_READERS: RoleKey[] = ['platformAdmin', 'clinician', 'records', 'curator'];

const ROUTES: RouteExpectation[] = [
  { method: 'get', path: '/health', allow: [], public: true },

  { method: 'post', path: '/api/v1/auth/login', allow: [], public: true },
  { method: 'post', path: '/api/v1/auth/mfa/verify', allow: [], public: true },
  { method: 'post', path: '/api/v1/auth/mfa/enrol', allow: [], public: true },
  { method: 'post', path: '/api/v1/auth/invite/accept', allow: [], public: true },
  { method: 'post', path: '/api/v1/auth/refresh', allow: [], public: true },

  // Authenticated but unrestricted: everyone may read their own profile and
  // manage their own sessions.
  { method: 'get', path: '/api/v1/auth/me', allow: EVERY_ROLE },
  { method: 'get', path: '/api/v1/auth/sessions', allow: EVERY_ROLE },
  {
    method: 'delete',
    path: '/api/v1/auth/sessions/:id',
    allow: EVERY_ROLE,
    selfDestructive: true,
  },
  { method: 'post', path: '/api/v1/auth/logout', allow: EVERY_ROLE, selfDestructive: true },
  { method: 'post', path: '/api/v1/auth/logout-all', allow: EVERY_ROLE, selfDestructive: true },

  {
    method: 'post',
    path: '/api/v1/hospitals',
    allow: ['platformAdmin'],
    body: {
      name: 'Probe Hospital',
      facilityType: 'ayush',
      contactEmail: 'probe@example.in',
      contactPhone: '9812345670',
      address: {},
      mrnPrefix: 'PRB',
    },
  },
  { method: 'get', path: '/api/v1/hospitals', allow: ['platformAdmin'] },
  {
    method: 'get',
    path: '/api/v1/hospitals/me',
    allow: ['admin', 'clinician', 'frontDesk', 'records', 'otherHospitalAdmin'],
  },
  { method: 'get', path: '/api/v1/hospitals/:id', allow: ['platformAdmin'], param: 'ownHospital' },
  {
    method: 'patch',
    path: '/api/v1/hospitals/:id',
    allow: ['platformAdmin', 'admin', 'otherHospitalAdmin'],
    body: { contactPhone: '9812345699' },
    param: 'ownHospital',
  },

  {
    method: 'post',
    path: '/api/v1/staff/invite',
    allow: ['admin', 'otherHospitalAdmin'],
    body: { name: 'Probe Person', email: 'probe.invite@example.in', role: 'front_desk' },
  },
  { method: 'get', path: '/api/v1/staff', allow: ['admin', 'otherHospitalAdmin'] },
  {
    method: 'get',
    path: '/api/v1/staff/:id',
    allow: ['admin', 'otherHospitalAdmin'],
    param: 'disposableStaff',
  },
  {
    method: 'patch',
    path: '/api/v1/staff/:id',
    allow: ['admin', 'otherHospitalAdmin'],
    body: { name: 'Renamed By Probe' },
    param: 'disposableStaff',
  },
  {
    method: 'post',
    path: '/api/v1/staff/:id/deactivate',
    allow: ['admin', 'otherHospitalAdmin'],
    body: { reason: 'authorisation probe' },
    param: 'disposableStaff',
  },
  {
    method: 'post',
    path: '/api/v1/staff/:id/reinstate',
    allow: ['admin', 'otherHospitalAdmin'],
    param: 'disposableStaff',
  },

  {
    method: 'post',
    path: '/api/v1/patients',
    allow: ['clinician', 'frontDesk', 'records'],
    body: { name: 'Probe Patient', gender: 'male', approximateAgeYears: 30, forceCreate: true },
  },
  { method: 'get', path: '/api/v1/patients', allow: ['clinician', 'frontDesk', 'records'] },
  {
    method: 'post',
    path: '/api/v1/patients/lookup',
    allow: ['clinician', 'frontDesk', 'records'],
    body: { name: 'Probe Patient' },
  },
  {
    method: 'get',
    path: '/api/v1/patients/merge-queue',
    allow: ['admin', 'frontDesk', 'records', 'otherHospitalAdmin'],
  },
  {
    method: 'post',
    path: '/api/v1/patients/merge-queue/:id/resolve',
    allow: ['admin', 'frontDesk', 'records', 'otherHospitalAdmin'],
    body: { decision: 'reject', reason: 'authorisation probe' },
  },
  {
    method: 'post',
    path: '/api/v1/patients/merges/:id/revert',
    allow: ['admin', 'frontDesk', 'records', 'otherHospitalAdmin'],
    body: { reason: 'authorisation probe' },
  },
  { method: 'get', path: '/api/v1/patients/:id', allow: ['clinician', 'frontDesk', 'records'] },
  {
    method: 'patch',
    path: '/api/v1/patients/:id',
    allow: ['clinician', 'frontDesk', 'records'],
    body: { bloodGroup: 'O+', reason: 'authorisation probe' },
  },
  {
    method: 'post',
    path: '/api/v1/patients/:id/link',
    allow: ['clinician', 'frontDesk', 'records'],
    body: { name: 'Probe Patient' },
  },

  // Terminology
  { method: 'get', path: '/api/v1/terminology/systems', allow: TERMINOLOGY_READERS },
  { method: 'get', path: '/api/v1/terminology/search', allow: TERMINOLOGY_READERS },
  {
    method: 'get',
    path: '/api/v1/terminology/systems/:key/concepts/:code',
    allow: TERMINOLOGY_READERS,
  },
  { method: 'get', path: '/api/v1/terminology/translate', allow: TERMINOLOGY_READERS },
  { method: 'get', path: '/api/v1/terminology/auto-code', allow: TERMINOLOGY_READERS },
  // Activating a release is platform operation, not clinical judgement.
  { method: 'post', path: '/api/v1/terminology/systems/:id/activate', allow: ['platformAdmin'] },
  // Reviewing mappings is clinical judgement: curators only, and pointedly not
  // platform admins.
  { method: 'get', path: '/api/v1/terminology/review-queue', allow: ['curator'] },
  { method: 'post', path: '/api/v1/terminology/map-elements', allow: ['curator'] },
  {
    method: 'post',
    path: '/api/v1/terminology/map-elements/:id/review',
    allow: ['curator'],
    body: { decision: 'reject', comment: 'authorisation probe' },
  },
  { method: 'get', path: '/api/v1/terminology/map-elements/:id/history', allow: ['curator'] },
  { method: 'get', path: '/api/v1/terminology/coverage', allow: ['curator', 'platformAdmin'] },

  // Clinical record: clinicians only. Front desk, hospital admins, platform
  // admins and curators never read or write clinical entries.
  {
    method: 'post',
    path: '/api/v1/encounters',
    allow: ['clinician', 'records'],
    body: { patientId: '00000000-0000-4000-8000-000000000000', class: 'outpatient' },
  },
  { method: 'get', path: '/api/v1/encounters', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/encounters/:id', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/encounters/:id/finish', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/encounters/:id/cancel',
    allow: ['clinician', 'records'],
    body: { reason: 'authorisation probe' },
  },
  {
    method: 'post',
    path: '/api/v1/allergies',
    allow: ['clinician', 'records'],
    body: {
      patientId: '00000000-0000-4000-8000-000000000000',
      substance: 'Probe',
      category: 'food',
    },
  },
  { method: 'get', path: '/api/v1/patients/:patientId/allergies', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/diagnoses',
    allow: ['clinician', 'records'],
    body: { encounterId: '00000000-0000-4000-8000-000000000000', code: 'DEMO-NAM-001' },
  },
  { method: 'get', path: '/api/v1/encounters/:id/diagnoses', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/patients/:patientId/problems', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/prescriptions',
    allow: ['clinician', 'records'],
    body: {
      encounterId: '00000000-0000-4000-8000-000000000000',
      medicineName: 'Probe',
      frequency: '1-0-1',
      route: 'oral',
    },
  },
  {
    method: 'post',
    path: '/api/v1/prescriptions/:id/stop',
    // A new clinical decision, not transcription.
    allow: ['clinician'],
    body: { reason: 'authorisation probe' },
  },
  { method: 'get', path: '/api/v1/encounters/:id/prescriptions', allow: ['clinician', 'records'] },
  {
    method: 'get',
    path: '/api/v1/patients/:patientId/medications',
    allow: ['clinician', 'records'],
  },
  { method: 'get', path: '/api/v1/clinicians', allow: ['clinician', 'records'] },
  // Documentation and corrections (Phase 7). Records staff may correct only
  // what they typed; the service enforces that beyond the permission guard.
  { method: 'post', path: '/api/v1/vitals', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/vitals/:groupId/entered-in-error',
    allow: ['clinician', 'records'],
  },
  { method: 'post', path: '/api/v1/notes', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/notes/:id/correct', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/notes/:id/entered-in-error', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/procedures', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/procedures/:id/correct', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/procedures/:id/entered-in-error',
    allow: ['clinician', 'records'],
  },
  { method: 'post', path: '/api/v1/diagnoses/:id/correct', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/diagnoses/:id/entered-in-error',
    allow: ['clinician', 'records'],
  },
  { method: 'post', path: '/api/v1/prescriptions/:id/correct', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/prescriptions/:id/entered-in-error',
    allow: ['clinician', 'records'],
  },
  { method: 'post', path: '/api/v1/allergies/:id/correct', allow: ['clinician', 'records'] },
  {
    method: 'post',
    path: '/api/v1/allergies/:id/entered-in-error',
    allow: ['clinician', 'records'],
  },
  { method: 'get', path: '/api/v1/patients/:patientId/vitals', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/encounters/:id/vitals', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/encounters/:id/notes', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/encounters/:id/procedures', allow: ['clinician', 'records'] },
  {
    method: 'get',
    path: '/api/v1/patients/:patientId/procedures',
    allow: ['clinician', 'records'],
  },
  { method: 'get', path: '/api/v1/clinical-history/:kind/:id', allow: ['clinician', 'records'] },
  // Consent, emergency access, timeline and coding review (Phase 8). Consent is
  // recorded where the patient stands; emergency access is a clinician's; its
  // review is the hospital admin's; coding review is clinical judgement.
  {
    method: 'post',
    path: '/api/v1/patients/:patientId/consents',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  {
    method: 'get',
    path: '/api/v1/patients/:patientId/consents',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  {
    method: 'post',
    path: '/api/v1/consents/:id/revoke',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  { method: 'post', path: '/api/v1/patients/:patientId/break-glass', allow: ['clinician'] },
  { method: 'get', path: '/api/v1/break-glass/reviews', allow: ['admin', 'otherHospitalAdmin'] },
  { method: 'post', path: '/api/v1/consents/:id/review', allow: ['admin', 'otherHospitalAdmin'] },
  { method: 'get', path: '/api/v1/patients/:patientId/timeline', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/patients/:patientId/summary', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/coding-reviews', allow: ['clinician'] },
  // Views made offline, uploaded on reconnection: whoever can open a patient's record.
  {
    method: 'post',
    path: '/api/v1/audit/offline-views',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  // Documents (SP4 Phase 3). Uploading and correcting for whoever handles the paper
  // file; opening a report only for roles that read clinical records (Decision H1).
  { method: 'post', path: '/api/v1/documents', allow: ['clinician', 'frontDesk', 'records'] },
  {
    method: 'post',
    path: '/api/v1/documents/:id/complete',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  {
    method: 'get',
    path: '/api/v1/patients/:patientId/documents',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  { method: 'get', path: '/api/v1/documents/:id', allow: ['clinician', 'frontDesk', 'records'] },
  {
    method: 'get',
    path: '/api/v1/documents/:id/files/:fileId/url',
    allow: ['clinician', 'records'],
  },
  {
    method: 'post',
    path: '/api/v1/documents/:id/correct',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  {
    method: 'post',
    path: '/api/v1/documents/:id/entered-in-error',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  // Lab results (SP4 Phase 4): typed by whoever holds the report; read by roles
  // that read clinical records (Decision H1).
  { method: 'post', path: '/api/v1/results', allow: ['clinician', 'frontDesk', 'records'] },
  {
    method: 'get',
    path: '/api/v1/patients/:patientId/results',
    allow: ['clinician', 'records'],
  },
  {
    method: 'get',
    path: '/api/v1/patients/:patientId/results/trends',
    allow: ['clinician', 'records'],
  },
  {
    method: 'post',
    path: '/api/v1/results/:setId/entered-in-error',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  { method: 'post', path: '/api/v1/coding-reviews/:conditionId/acknowledge', allow: ['clinician'] },
  // Legacy paper files (SP4 Phase 6): classifying means reading every page, so
  // only roles that read clinical records import (Decision E1).
  { method: 'post', path: '/api/v1/imports', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/patients/:patientId/imports', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/imports/:id', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/imports/:id/files', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/imports/:id/files/complete', allow: ['clinician', 'records'] },
  { method: 'get', path: '/api/v1/imports/:id/pages/:pageId/url', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/imports/:id/documents', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/imports/:id/exclusions', allow: ['clinician', 'records'] },
  { method: 'post', path: '/api/v1/imports/:id/finish', allow: ['clinician', 'records'] },
  // Doctors without an account, named alike on every document (T20).
  {
    method: 'get',
    path: '/api/v1/external-clinicians',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  // Patient portal sign-in (SP5 Phase 1): public until a code is spent, then
  // patient sessions only.
  { method: 'post', path: '/api/v1/portal/auth/otp', allow: [], public: true },
  { method: 'post', path: '/api/v1/portal/auth/verify', allow: [], public: true },
  { method: 'post', path: '/api/v1/portal/auth/session', allow: [], public: true },
  { method: 'post', path: '/api/v1/portal/auth/refresh', allow: [], public: true },
  { method: 'get', path: '/api/v1/portal/auth/me', allow: [], portal: true },
  { method: 'post', path: '/api/v1/portal/auth/switch', allow: [], portal: true },
  { method: 'get', path: '/api/v1/portal/auth/sessions', allow: [], portal: true },
  { method: 'delete', path: '/api/v1/portal/auth/sessions/:id', allow: [], portal: true },
  { method: 'post', path: '/api/v1/portal/auth/logout', allow: [], portal: true },
  // The patient's own record (SP5 Phase 2).
  { method: 'get', path: '/api/v1/portal/summary', allow: [], portal: true },
  { method: 'get', path: '/api/v1/portal/timeline', allow: [], portal: true },
  { method: 'get', path: '/api/v1/portal/documents', allow: [], portal: true },
  { method: 'get', path: '/api/v1/portal/documents/:id/files/:fileId/url', allow: [], portal: true },
  { method: 'get', path: '/api/v1/portal/results', allow: [], portal: true },
  { method: 'get', path: '/api/v1/portal/results/trends', allow: [], portal: true },
  // Consent from the portal (SP5 Phase 4).
  { method: 'get', path: '/api/v1/portal/consents', allow: [], portal: true },
  { method: 'post', path: '/api/v1/portal/consents', allow: [], portal: true },
  { method: 'post', path: '/api/v1/portal/consents/:id/revoke', allow: [], portal: true },
  // Portal access is activated by those who see the patient in person (Decision J1).
  {
    method: 'post',
    path: '/api/v1/patients/:id/portal-access',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  {
    method: 'get',
    path: '/api/v1/patients/:id/portal-access',
    allow: ['clinician', 'frontDesk', 'records'],
  },
  {
    method: 'post',
    path: '/api/v1/portal-access/:id/revoke',
    allow: ['clinician', 'frontDesk', 'records'],
  },
];

const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Reads the routes Express actually registered.
 *
 * Introspecting the router is unlovely, but the alternative is trusting a
 * hand-written list to stay complete — and a list nobody is forced to update
 * is the exact failure this suite exists to prevent.
 */
function registeredRoutes(server: unknown): Array<{ method: string; path: string }> {
  const found: Array<{ method: string; path: string }> = [];

  const stack =
    (server as { _router?: { stack?: unknown[] } })._router?.stack ??
    (server as { router?: { stack?: unknown[] } }).router?.stack ??
    [];

  const walk = (layers: unknown[]): void => {
    for (const layer of layers) {
      const entry = layer as {
        route?: { path?: string | string[]; methods?: Record<string, boolean> };
        name?: string;
        handle?: { stack?: unknown[] };
      };

      if (entry.route?.path) {
        const paths = Array.isArray(entry.route.path) ? entry.route.path : [entry.route.path];

        for (const routePath of paths) {
          for (const [method, enabled] of Object.entries(entry.route.methods ?? {})) {
            if (enabled && method !== '_all') found.push({ method, path: routePath });
          }
        }
      } else if (entry.name === 'router' && entry.handle?.stack) {
        walk(entry.handle.stack);
      }
    }
  };

  walk(stack as unknown[]);
  return found;
}

describe('authorization', () => {
  let ctx: TestContext;
  const tokens: Record<RoleKey, string> = {} as Record<RoleKey, string>;
  const hospitalFor: Partial<Record<RoleKey, string>> = {};
  let disposableStaffId: string;

  beforeAll(async () => {
    await resetDatabase();
    ctx = await createTestApp();

    const primary = await seedHospital({ name: 'Primary Ayush Hospital', mrnPrefix: 'PAH' });
    const secondary = await seedHospital({
      name: 'Secondary General Hospital',
      mrnPrefix: 'SGH',
      facilityType: 'allopathic',
    });
    const platformAdmin = await seedPlatformAdmin();

    tokens.platformAdmin = await signIn(ctx, platformAdmin);
    tokens.admin = await signIn(ctx, primary.staff.admin as SeededStaff);
    tokens.clinician = await signIn(ctx, primary.staff.clinician as SeededStaff);
    tokens.frontDesk = await signIn(ctx, primary.staff.frontDesk as SeededStaff);
    tokens.records = await signIn(ctx, primary.staff.records as SeededStaff);
    tokens.otherHospitalAdmin = await signIn(ctx, secondary.staff.admin as SeededStaff);
    tokens.curator = await signIn(
      ctx,
      await seedPlatformUser({
        role: 'terminology_curator',
        email: 'probe.curator@example.in',
        name: 'Probe Curator',
      }),
    );

    hospitalFor.admin = primary.hospital.id;
    hospitalFor.clinician = primary.hospital.id;
    hospitalFor.frontDesk = primary.hospital.id;
    hospitalFor.records = primary.hospital.id;
    hospitalFor.otherHospitalAdmin = secondary.hospital.id;

    // A staff account that exists only to be deactivated and reinstated by the
    // probe. Targeting a fixture the suite also signs in as would revoke its
    // sessions mid-run, and every later assertion would fail as 401 — which
    // reads as a permission bug rather than a test bug.
    const invite = await ctx
      .http()
      .post('/api/v1/staff/invite')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        name: 'Disposable Target',
        email: 'disposable.target@example.in',
        role: 'front_desk',
      });

    disposableStaffId = invite.body.staff.id as string;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  function pathFor(route: RouteExpectation, role: RoleKey): string {
    const id =
      route.param === 'ownHospital'
        ? (hospitalFor[role] ?? ABSENT_ID)
        : route.param === 'disposableStaff'
          ? disposableStaffId
          : ABSENT_ID;

    return route.path.replace(/:[A-Za-z]+/g, id);
  }

  it('classifies every registered route', () => {
    const registered = registeredRoutes(ctx.app.getHttpAdapter().getInstance());

    expect(registered.length).toBeGreaterThan(0);

    const declared = new Set(ROUTES.map((route) => `${route.method} ${route.path}`));
    const unclassified = registered
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !declared.has(key));

    // A new endpoint with no entry above fails here. That is the point: it
    // forces a decision about who may call it, when it is written.
    expect(unclassified, 'routes with no authorization expectation').toEqual([]);
  });

  it('rejects unauthenticated callers on every non-public route', async () => {
    const failures: string[] = [];

    for (const route of ROUTES) {
      if (route.public) continue;

      const agent = ctx.http();
      const response = await agent[route.method](route.path.replace(/:[A-Za-z]+/g, ABSENT_ID)).send(
        route.body ?? {},
      );

      if (response.status !== 401) {
        failures.push(`${route.method} ${route.path} returned ${response.status}, expected 401`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('permits exactly the roles that should reach each route', async () => {
    const failures: string[] = [];

    for (const route of ROUTES) {
      if (route.public || route.selfDestructive || route.portal) continue;

      for (const role of ALL_ROLES) {
        const agent = ctx.http();
        const response = await agent[route.method](pathFor(route, role))
          .set('Authorization', `Bearer ${tokens[role]}`)
          .send(route.body ?? {});

        const shouldAllow = route.allow.includes(role);
        const forbidden = response.status === 403;

        if (shouldAllow && forbidden) {
          failures.push(`${role} was forbidden from ${route.method} ${route.path}`);
        }

        if (!shouldAllow && !forbidden) {
          failures.push(
            `${role} reached ${route.method} ${route.path} (status ${response.status}) but should be forbidden`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('refuses every staff token on every patient portal route', async () => {
    const failures: string[] = [];

    for (const route of ROUTES.filter((candidate) => candidate.portal)) {
      for (const role of ALL_ROLES) {
        const agent = ctx.http();
        const response = await agent[route.method](route.path.replace(/:[A-Za-z]+/g, ABSENT_ID))
          .set('Authorization', `Bearer ${tokens[role]}`)
          .send(route.body ?? {});

        if (response.status !== 401) {
          failures.push(`${role} got ${response.status} from ${route.method} ${route.path}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('refuses a revoked session immediately', async () => {
    const secondary = await seedHospital({ name: 'Revocation Test', mrnPrefix: 'RVT' });
    const token = await signIn(ctx, secondary.staff.frontDesk as SeededStaff);

    const before = await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(before.status).toBe(200);

    await ctx.http().post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`);

    const after = await ctx.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.status, 'a revoked session must not survive until token expiry').toBe(401);
  });

  it('rejects a token signed with the wrong key', async () => {
    // A forged token must fail on its signature, not merely on a session
    // lookup — otherwise learning a session id would be enough to mint access.
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDAiLCJzaWQiOiJ4Iiwicm9sZSI6InBsYXRmb3JtX2FkbWluIiwiaGlkIjpudWxsfQ.' +
      'not-a-valid-signature';

    const response = await ctx
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${forged}`);

    expect(response.status).toBe(401);
  });
});
