/**
 * End-to-end smoke test of the SP2 terminology service, over real HTTP against
 * the compiled server and the demo releases.
 *
 * Re-runnable against the same development database: the one mapping it
 * proposes is rejected at the end, so the approved state the demo relies on
 * never drifts between runs.
 *
 *   pnpm db:reset            (migrates, seeds, loads the demo terminology)
 *   pnpm --filter @health24/api build && pnpm --filter @health24/api start
 *   pnpm smoke:terminology
 */
import { call, createStaff, reporter, signIn } from './lib/smoke-client.mjs';

const { check, section, finish } = reporter();

section('Setup');
const hospitalAdmin = await signIn('admin@sanjeevani.example.in');
const clinicianAccount = await createStaff(hospitalAdmin.token, {
  role: 'clinician',
  systemOfMedicine: 'ayurveda',
});
const clinician = await signIn(clinicianAccount.email, clinicianAccount.password);
const frontDesk = await signIn('reception@sanjeevani.example.in');
const platformAdmin = await signIn('admin@health24.example.in');
const curatorA = await signIn('curator.anjali@health24.example.in');
const curatorB = await signIn('curator.rohan@health24.example.in');
check(
  'clinician, front desk, platform admin and two curators signed in',
  [clinician, frontDesk, platformAdmin, curatorA, curatorB].every((session) => !!session.token),
);

section('1. The demo releases are loaded and active');
const systems = await call('GET', '/terminology/systems', { token: clinician.token });
check('returns 200', systems.status === 200, `got ${systems.status}`);
const active = Object.fromEntries(
  (systems.body ?? []).filter((s) => s.status === 'active').map((s) => [s.key, s]),
);
check(
  'namaste, icd11-tm2 and icd11-mms are all active',
  ['namaste', 'icd11-tm2', 'icd11-mms'].every((key) => active[key]),
  Object.keys(active).join(', ') || 'none — run pnpm terminology:load-demo',
);
check(
  'every one is flagged experimental',
  Object.values(active).every((s) => s.experimental),
);
check(
  'attribution is available to display',
  Object.values(active).every((s) => !!s.attribution),
);

section('2. One concept from four spellings');
for (const query of ['अम्लपित्त', 'amlapitta', 'Amlapitta', 'amlapita']) {
  const result = await call(
    'GET',
    `/terminology/search?system=namaste&q=${encodeURIComponent(query)}`,
    {
      token: clinician.token,
    },
  );
  check(
    `"${query}" finds DEMO-NAM-001 first`,
    result.body?.[0]?.code === 'DEMO-NAM-001',
    `got ${result.body?.[0]?.code ?? result.status}`,
  );
}

section('3. Auto-coding attaches only what has been approved');
const coded = await call('GET', '/terminology/auto-code?system=namaste&code=DEMO-NAM-006', {
  token: clinician.token,
});
check('returns 200', coded.status === 200, `got ${coded.status}`);
check('primary is the clinician’s own selection', coded.body?.primary?.code === 'DEMO-NAM-006');
check(
  'TM2 translation attached from the authoritative map',
  coded.body?.translated?.code === 'DEMO-TM2-06',
  coded.body?.translated?.code,
);
check(
  'leads with the demo warning',
  coded.body?.notes?.[0] === 'Demo terminology — not for use on a real patient record.',
);

section('4. Access is limited to those who code or curate');
const deskSearch = await call('GET', '/terminology/search?system=namaste&q=jvara', {
  token: frontDesk.token,
});
check('front desk is refused search', deskSearch.status === 403, `got ${deskSearch.status}`);
const adminQueue = await call('GET', '/terminology/review-queue', { token: platformAdmin.token });
check(
  'platform admin cannot review mappings',
  adminQueue.status === 403,
  `got ${adminQueue.status}`,
);
const anonymous = await call('GET', '/terminology/systems');
check('unauthenticated caller is refused', anonymous.status === 401, `got ${anonymous.status}`);

section('5. Four-eyes review of a correction');
const translation = await call(
  'GET',
  '/terminology/translate?system=namaste&code=DEMO-NAM-006&target=icd11-tm2',
  {
    token: clinician.token,
  },
);
const approved = translation.body?.translations?.[0];
check('an approved TM2 mapping exists to correct', !!approved?.conceptMapElementId);

const queue = await call('GET', '/terminology/review-queue?status=approved&limit=100', {
  token: curatorA.token,
});
const approvedEntry = queue.body?.results?.find(
  (entry) => entry.id === approved?.conceptMapElementId,
);
check('it appears in the queue of approved mappings', !!approvedEntry);

const proposal = await call('POST', '/terminology/map-elements', {
  token: curatorA.token,
  body: {
    conceptMapId: approvedEntry?.map?.id,
    sourceCode: 'DEMO-NAM-006',
    targetCode: 'DEMO-TM2-06',
    equivalence: 'wider',
    comment: 'Smoke test correction — will be rejected',
    supersedesElementId: approved?.conceptMapElementId,
  },
});
check(
  'curator A proposes a correction',
  proposal.status === 201,
  `got ${proposal.status} ${proposal.raw.slice(0, 160)}`,
);

const selfApproval = await call('POST', `/terminology/map-elements/${proposal.body?.id}/review`, {
  token: curatorA.token,
  body: { decision: 'approve', comment: 'Approving my own proposal' },
});
check(
  'curator A cannot approve their own proposal',
  selfApproval.status === 403,
  `got ${selfApproval.status}`,
);

const stillApproved = await call(
  'GET',
  '/terminology/translate?system=namaste&code=DEMO-NAM-006&target=icd11-tm2',
  {
    token: clinician.token,
  },
);
check(
  'the original stays in force while the correction waits',
  stillApproved.body?.translations?.[0]?.conceptMapElementId === approved?.conceptMapElementId,
);

const rejection = await call('POST', `/terminology/map-elements/${proposal.body?.id}/review`, {
  token: curatorB.token,
  body: { decision: 'reject', comment: 'Smoke test cleanup' },
});
check('curator B can decide it', rejection.status === 200, `got ${rejection.status}`);

const history = await call('GET', `/terminology/map-elements/${proposal.body?.id}/history`, {
  token: curatorB.token,
});
check(
  'its history records both curators',
  JSON.stringify(history.body?.map((entry) => entry.action)) ===
    JSON.stringify(['propose', 'reject']),
  JSON.stringify(history.body?.map((entry) => entry.action)),
);

section('6. Coverage');
const coverage = await call('GET', '/terminology/coverage', { token: platformAdmin.token });
check('platform admin can read coverage', coverage.status === 200, `got ${coverage.status}`);
const tm2 = coverage.body?.find((entry) => entry.conceptMap.key === 'namaste-to-icd11-tm2');
check(
  'TM2 coverage reports 12 source concepts',
  tm2?.sourceConcepts === 12,
  `got ${tm2?.sourceConcepts}`,
);

finish();
