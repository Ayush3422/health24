/**
 * End-to-end smoke test of the SP1 Phase 5 patient registry.
 *
 * The properties under test are the ones that make this a cross-hospital
 * record rather than two disconnected ones — and the ones whose failure is
 * worst: linking two different people, or handing a hospital access to a
 * patient it cannot identify.
 *
 *   pnpm db:up && pnpm db:migrate && pnpm db:bootstrap && pnpm db:seed
 *   pnpm --filter @health24/api build && pnpm --filter @health24/api start
 *   pnpm smoke:patients
 */
import { call, createStaff, reporter, signIn } from './lib/smoke-client.mjs';

const { check, section, finish } = reporter();

// Unique per run, so the suite is re-runnable against the same database.
// The suffix is alphabetic because the name schema rejects digits — names do
// not contain numbers, and that rule is worth keeping.
const digits = Date.now().toString().slice(-7);
const run = [...digits].map((d) => 'abcdefghij'[Number(d)]).join('');
const phone = `98${digits.padStart(8, '7')}`;
const altPhone = `97${digits.padStart(8, '6')}`;

section('Sign in at both hospitals');
const ayush = await signIn('reception@sanjeevani.example.in');
const city = await signIn('reception@citygeneral.example.in');
const ayushAdmin = await signIn('admin@sanjeevani.example.in');
check('Ayurvedic hospital front desk signed in', !!ayush.token);
check('allopathic hospital front desk signed in', !!city.token);

section('1. Registering a new patient');
const registration = await call('POST', '/patients', {
  token: ayush.token,
  body: {
    name: `Ramesh Testkumar ${run}`,
    gender: 'male',
    dateOfBirth: '1984-03-02',
    phone,
    bloodGroup: 'B+',
  },
});
check('returns 201', registration.status === 201, `got ${registration.status} ${registration.raw.slice(0, 200)}`);
check('a new record was created, not linked', registration.body?.linkedExisting === false);
check('an MRN was issued', typeof registration.body?.patient?.mrn === 'string', registration.body?.patient?.mrn);
check('MRN carries the hospital prefix', registration.body?.patient?.mrn?.startsWith('SAH-'),
  registration.body?.patient?.mrn);

const patientId = registration.body.patient.id;
const ayushMrn = registration.body.patient.mrn;

section('2. MRNs are sequential and never collide');
const second = await call('POST', '/patients', {
  token: ayush.token,
  body: { name: `Second Patient ${run}`, gender: 'female', approximateAgeYears: 30 },
});
check('second registration succeeds', second.status === 201, `got ${second.status}`);
check(
  'the second MRN differs from the first',
  second.body?.patient?.mrn !== ayushMrn,
  `${ayushMrn} vs ${second.body?.patient?.mrn}`,
);

section('3. The registering hospital can find them');
const found = await call('GET', `/patients?q=${encodeURIComponent('Ramesh Testkumar ' + run)}`, {
  token: ayush.token,
});
check('search returns 200', found.status === 200, `got ${found.status}`);
check('the patient is found', found.body?.results?.some((p) => p.id === patientId));

const byMrn = await call('GET', `/patients?q=${encodeURIComponent(ayushMrn)}`, { token: ayush.token });
check('searchable by MRN', byMrn.body?.results?.some((p) => p.id === patientId));

section('4. The other hospital cannot see them');
const citySearch = await call('GET', `/patients?q=${encodeURIComponent('Ramesh Testkumar ' + run)}`, {
  token: city.token,
});
check('search returns 200', citySearch.status === 200);
check(
  'but returns nothing — no link, no visibility',
  !citySearch.body?.results?.some((p) => p.id === patientId),
  'cross-tenant leak',
);

const cityDirect = await call('GET', `/patients/${patientId}`, { token: city.token });
check('direct read returns 404, not 403', cityDirect.status === 404, `got ${cityDirect.status}`);

section('5. The link endpoint refuses an unidentified patient');
// Knowing an id must not be enough: linking grants access to the record.
const blindLink = await call('POST', `/patients/${patientId}/link`, {
  token: city.token,
  body: { name: 'Somebody Entirely Different', gender: 'female' },
});
check(
  'returns 404 when the supplied details do not match',
  blindLink.status === 404,
  `got ${blindLink.status} — an id alone must never grant access to a record`,
);

section('6. Registering the same person at the other hospital links, not duplicates');
const atCity = await call('POST', '/patients', {
  token: city.token,
  body: {
    name: `Ramesh Testkumar ${run}`,
    gender: 'male',
    dateOfBirth: '1984-03-02',
    phone,
  },
});
check('returns 201', atCity.status === 201, `got ${atCity.status} ${atCity.raw.slice(0, 200)}`);
check('an existing person was linked', atCity.body?.linkedExisting === true,
  'the whole product depends on this');
check('same underlying patient id', atCity.body?.patient?.id === patientId,
  `${patientId} vs ${atCity.body?.patient?.id}`);
check('but the second hospital gets its OWN MRN', atCity.body?.patient?.mrn?.startsWith('CGH-'),
  atCity.body?.patient?.mrn);

section('7. Both hospitals now see the patient under their own number');
const ayushView = await call('GET', `/patients/${patientId}`, { token: ayush.token });
const cityView = await call('GET', `/patients/${patientId}`, { token: city.token });
check('Ayurvedic hospital sees its MRN', ayushView.body?.mrn === ayushMrn, ayushView.body?.mrn);
check('allopathic hospital sees its own', cityView.body?.mrn !== ayushMrn, cityView.body?.mrn);
check('same person, same id', ayushView.body?.id === cityView.body?.id);

section('8. A plausible-but-uncertain match is refused, not guessed');
const similar = await call('POST', '/patients', {
  token: ayush.token,
  body: {
    name: `Ramesh Testkumar ${run}`,
    gender: 'male',
    dateOfBirth: '1984-03-02',
    phone: altPhone,
  },
});
check('returns 409', similar.status === 409, `got ${similar.status}`);
check('the code identifies the reason', similar.body?.code === 'POSSIBLE_DUPLICATE', similar.body?.code);
check('candidates are returned for a human to judge', Array.isArray(similar.body?.candidates) && similar.body.candidates.length > 0);
check(
  'candidate names are masked',
  similar.body?.candidates?.[0]?.maskedName?.includes('•'),
  similar.body?.candidates?.[0]?.maskedName,
);
check(
  'no unmasked name is exposed',
  !JSON.stringify(similar.body.candidates).includes('Testkumar'),
  'another hospital\'s patient names must not leak through the duplicate warning',
);

section('9. Overriding the warning queues the pair for review');
const forced = await call('POST', '/patients', {
  token: ayush.token,
  body: {
    name: `Ramesh Testkumar ${run}`,
    gender: 'male',
    dateOfBirth: '1984-03-02',
    phone: altPhone,
    forceCreate: true,
  },
});
check('returns 201', forced.status === 201, `got ${forced.status} ${forced.raw.slice(0, 200)}`);
check('a separate record was created', forced.body?.patient?.id !== patientId);
check('the possible duplicate was queued', forced.body?.queuedForReview > 0,
  `queued ${forced.body?.queuedForReview}`);

const duplicateId = forced.body.patient.id;

section('10. The review queue shows the pairing, masked');
const queue = await call('GET', '/patients/merge-queue', { token: ayushAdmin.token });
check('returns 200', queue.status === 200, `got ${queue.status}`);
const pairing = queue.body?.find((entry) =>
  entry.patients.some((p) => p.patientId === duplicateId),
);
check('the queued pairing is listed', !!pairing);
check('names are masked in the queue', pairing?.patients?.[0]?.maskedName?.includes('•'));
check('the score is shown to the reviewer', typeof pairing?.score === 'number', `${pairing?.score}`);

section('11. Front desk can resolve; a clinician cannot');
// Created fresh rather than reusing a seeded account, so the suite does not
// depend on which accounts previous runs happened to enrol.
const clinicianAccount = await createStaff(ayushAdmin.token, { role: 'clinician' });
const clinician = await signIn(clinicianAccount.email, clinicianAccount.password);
const clinicianAttempt = await call('POST', `/patients/merge-queue/${pairing.id}/resolve`, {
  token: clinician.token,
  body: { decision: 'reject', reason: 'clinician should not be able to do this' },
});
check('clinician is refused', clinicianAttempt.status === 403, `got ${clinicianAttempt.status}`);

section('12. Merging requires naming the survivor');
const noSurvivor = await call('POST', `/patients/merge-queue/${pairing.id}/resolve`, {
  token: ayushAdmin.token,
  body: { decision: 'merge', reason: 'same person, duplicate created in error' },
});
check('returns 400 without keepPatientId', noSurvivor.status === 400, `got ${noSurvivor.status}`);

section('13. Merging works');
const merged = await call('POST', `/patients/merge-queue/${pairing.id}/resolve`, {
  token: ayushAdmin.token,
  body: {
    decision: 'merge',
    reason: 'same person, duplicate created in error',
    keepPatientId: patientId,
  },
});
check('returns 201', merged.status === 201, `got ${merged.status} ${merged.raw.slice(0, 200)}`);
check('the correct record survived', merged.body?.survivingPatientId === patientId);
check('a merge log id is returned so the merge can be undone', typeof merged.body?.mergeLogId === 'string',
  'reversibility is only real if the caller can reach it');

const afterMerge = await call('GET', `/patients/${duplicateId}`, { token: ayush.token });
check(
  'the merged record is no longer directly readable',
  afterMerge.status === 404,
  `got ${afterMerge.status}`,
);

const survivorAfter = await call('GET', `/patients/${patientId}`, { token: ayush.token });
check('the survivor is intact', survivorAfter.status === 200, `got ${survivorAfter.status}`);

section('14. Resolving the same pairing twice is refused');
const doubleResolve = await call('POST', `/patients/merge-queue/${pairing.id}/resolve`, {
  token: ayushAdmin.token,
  body: { decision: 'reject', reason: 'trying again' },
});
check('returns 400', doubleResolve.status === 400, `got ${doubleResolve.status}`);

section('15. Demographic corrections are recorded');
const correction = await call('PATCH', `/patients/${patientId}`, {
  token: ayush.token,
  body: { bloodGroup: 'O+', reason: 'corrected from lab report' },
});
check('returns 200', correction.status === 200, `got ${correction.status} ${correction.raw.slice(0, 160)}`);
check('the change took effect', correction.body?.bloodGroup === 'O+', correction.body?.bloodGroup);

const noReason = await call('PATCH', `/patients/${patientId}`, {
  token: ayush.token,
  body: { bloodGroup: 'A+' },
});
check('a correction without a reason is refused', noReason.status === 400, `got ${noReason.status}`);

section('16. A merge can be undone');
// Merges are performed by humans on incomplete information, and some will be
// wrong. A system that cannot undo one leaves two people's histories
// permanently fused — worse than the duplicate it was fixing.
const revert = await call('POST', `/patients/merges/${merged.body.mergeLogId}/revert`, {
  token: ayushAdmin.token,
  body: { reason: 'merged in error during smoke test' },
});
check('returns 201', revert.status === 201, `got ${revert.status} ${revert.raw.slice(0, 200)}`);
check('the merged record is named as restored', revert.body?.restoredPatientId === duplicateId,
  `${duplicateId} vs ${revert.body?.restoredPatientId}`);

const restored = await call('GET', `/patients/${duplicateId}`, { token: ayush.token });
check('the restored record is readable again', restored.status === 200, `got ${restored.status}`);
check('it kept its own MRN', typeof restored.body?.mrn === 'string', restored.body?.mrn);

const survivorStillThere = await call('GET', `/patients/${patientId}`, { token: ayush.token });
check('the survivor is still intact', survivorStillThere.status === 200, `got ${survivorStillThere.status}`);
check(
  'the two are separate records again',
  restored.body?.id !== survivorStillThere.body?.id,
  'the revert must actually separate them',
);

const doubleRevert = await call('POST', `/patients/merges/${merged.body.mergeLogId}/revert`, {
  token: ayushAdmin.token,
  body: { reason: 'trying again' },
});
check('a merge cannot be reverted twice', doubleRevert.status === 404, `got ${doubleRevert.status}`);

finish();
