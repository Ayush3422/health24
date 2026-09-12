/**
 * End-to-end smoke test of the SP1 Phase 4 tenancy and staff management flow.
 *
 * Checks the properties that matter and are easy to get wrong: that a hospital
 * admin cannot see or touch another hospital's staff, cannot escalate their
 * own role, cannot lock their hospital out by removing its last administrator,
 * and that deactivation cuts live sessions immediately rather than whenever a
 * token happens to expire.
 *
 * Prerequisites: API running on :3000 against a seeded database.
 *
 *   pnpm db:up && pnpm db:migrate && pnpm db:bootstrap && pnpm db:seed
 *   pnpm --filter @health24/api build && pnpm --filter @health24/api start
 *   pnpm smoke:tenancy
 */
import { call, reporter, SEED_PASSWORD, signIn } from './lib/smoke-client.mjs';

const { check, section, finish } = reporter();

section('Sign in as three different actors');
const platformAdmin = await signIn('admin@health24.example.in');
const ayushAdmin = await signIn('admin@sanjeevani.example.in');
const cityClinician = await signIn('arun@citygeneral.example.in');
check('platform admin signed in', !!platformAdmin.token);
check('ayush hospital admin signed in', !!ayushAdmin.token);
check('city hospital clinician signed in', !!cityClinician.token);
check('platform admin has no hospital', platformAdmin.staff?.hospitalId === null,
  `got ${platformAdmin.staff?.hospitalId}`);

console.log('\n=== 1. Platform admin can list every hospital ===');
const allHospitals = await call('GET', '/hospitals', { token: platformAdmin.token });
check('returns 200', allHospitals.status === 200, `got ${allHospitals.status}`);
check('sees both seeded hospitals', allHospitals.body?.length === 2, `got ${allHospitals.body?.length}`);

console.log('\n=== 2. A hospital admin CANNOT list every hospital ===');
const forbiddenList = await call('GET', '/hospitals', { token: ayushAdmin.token });
check('returns 403', forbiddenList.status === 403, `got ${forbiddenList.status}`);

console.log('\n=== 3. A hospital admin sees only their own hospital ===');
const own = await call('GET', '/hospitals/me', { token: ayushAdmin.token });
check('returns 200', own.status === 200, `got ${own.status}`);
check('is the Ayurvedic hospital', own.body?.name?.includes('Sanjeevani'), own.body?.name);
check('facility type is ayush', own.body?.facilityType === 'ayush', own.body?.facilityType);

const otherHospitalId = allHospitals.body.find((h) => h.id !== own.body.id).id;

console.log('\n=== 4. A hospital admin cannot read another hospital by id ===');
const peek = await call('GET', `/hospitals/${otherHospitalId}`, { token: ayushAdmin.token });
check('returns 403', peek.status === 403, `got ${peek.status}`);

console.log('\n=== 5. A hospital admin cannot edit another hospital ===');
const crossEdit = await call('PATCH', `/hospitals/${otherHospitalId}`, {
  token: ayushAdmin.token,
  body: { name: 'Hijacked Hospital' },
});
check('returns 403', crossEdit.status === 403, `got ${crossEdit.status}`);

console.log('\n=== 6. A hospital admin cannot change their own hospital status ===');
const selfSuspend = await call('PATCH', `/hospitals/${own.body.id}`, {
  token: ayushAdmin.token,
  body: { status: 'active' },
});
check('returns 403 — a tenant must not escape suspension', selfSuspend.status === 403,
  `got ${selfSuspend.status}`);

console.log('\n=== 7. A hospital admin CAN edit their own details ===');
const selfEdit = await call('PATCH', `/hospitals/${own.body.id}`, {
  token: ayushAdmin.token,
  body: { contactPhone: '9812345699' },
});
check('returns 200', selfEdit.status === 200, `got ${selfEdit.status} ${selfEdit.raw.slice(0, 150)}`);

console.log('\n=== 8. Staff list is tenant-scoped ===');
const ayushStaff = await call('GET', '/staff', { token: ayushAdmin.token });
check('returns 200', ayushStaff.status === 200, `got ${ayushStaff.status}`);
// Count-based assertions are brittle here: every run of this suite invites
// new development accounts, so the number grows. The property that actually
// matters is invariant — nothing from another tenant appears, whatever the
// size of the list.
check(
  'contains the seeded Ayurvedic hospital staff',
  ['meera@sanjeevani.example.in', 'reception@sanjeevani.example.in', 'admin@sanjeevani.example.in']
    .every((email) => ayushStaff.body?.some((s) => s.email === email)),
  `${ayushStaff.body?.length} staff returned`,
);
check(
  'contains nothing from the other hospital',
  !ayushStaff.body?.some((s) => s.email.includes('citygeneral')),
  'cross-tenant leak',
);

console.log('\n=== 9. A clinician cannot list staff at all ===');
const clinicianStaff = await call('GET', '/staff', { token: cityClinician.token });
check('returns 403', clinicianStaff.status === 403, `got ${clinicianStaff.status}`);

console.log('\n=== 10. Inviting a clinician requires a system of medicine ===');
const badInvite = await call('POST', '/staff/invite', {
  token: ayushAdmin.token,
  body: { name: 'Dr. No System', email: 'nosystem@sanjeevani.example.in', role: 'clinician' },
});
check('returns 400', badInvite.status === 400, `got ${badInvite.status}`);

console.log('\n=== 11. A hospital admin cannot mint a platform admin ===');
const escalate = await call('POST', '/staff/invite', {
  token: ayushAdmin.token,
  body: { name: 'Sneaky', email: 'sneaky@sanjeevani.example.in', role: 'platform_admin' },
});
check('returns 400 — role rejected by schema', escalate.status === 400, `got ${escalate.status}`);

console.log('\n=== 12. A valid invitation works ===');
const invite = await call('POST', '/staff/invite', {
  token: ayushAdmin.token,
  body: {
    name: 'Dr. Kavita Rao',
    email: `kavita.${Date.now()}@sanjeevani.example.in`,
    role: 'clinician',
    systemOfMedicine: 'ayurveda',
  },
});
check('returns 201', invite.status === 201, `got ${invite.status} ${invite.raw.slice(0, 150)}`);
check('account starts in invited state', invite.body?.staff?.status === 'invited',
  invite.body?.staff?.status);
check('invite token issued', typeof invite.body?.inviteToken === 'string');

console.log('\n=== 13. An invited account cannot sign in before accepting ===');
const earlyLogin = await call('POST', '/auth/login', {
  body: { email: invite.body.staff.email, password: SEED_PASSWORD },
});
check('returns 401', earlyLogin.status === 401, `got ${earlyLogin.status}`);

console.log('\n=== 14. Accepting the invitation activates the account ===');
const weakPassword = await call('POST', '/auth/invite/accept', {
  body: { inviteToken: invite.body.inviteToken, password: 'short' },
});
check('weak password rejected', weakPassword.status === 400, `got ${weakPassword.status}`);

const accept = await call('POST', '/auth/invite/accept', {
  body: { inviteToken: invite.body.inviteToken, password: 'a-perfectly-fine-passphrase' },
});
check('returns 204', accept.status === 204, `got ${accept.status} ${accept.raw.slice(0, 150)}`);

const replayInvite = await call('POST', '/auth/invite/accept', {
  body: { inviteToken: invite.body.inviteToken, password: 'another-fine-passphrase' },
});
check('invite token is single-use', replayInvite.status === 401, `got ${replayInvite.status}`);

console.log('\n=== 15. An admin cannot change their own role ===');
const selfPromote = await call('PATCH', `/staff/${ayushAdmin.staff.id}`, {
  token: ayushAdmin.token,
  body: { role: 'clinician', systemOfMedicine: 'ayurveda' },
});
check('returns 403', selfPromote.status === 403, `got ${selfPromote.status}`);

console.log('\n=== 16. An admin cannot deactivate themselves ===');
const selfDeactivate = await call('POST', `/staff/${ayushAdmin.staff.id}/deactivate`, {
  token: ayushAdmin.token,
  body: { reason: 'testing self-deactivation' },
});
check('returns 403', selfDeactivate.status === 403, `got ${selfDeactivate.status}`);

console.log('\n=== 17. Last-administrator guard (NOT exercised — see note) ===');
// Honest accounting: `assertNotLastAdmin` cannot currently be reached.
//
// Only `hospital_admin` holds staff:deactivate and staff:update. So to target
// the last *active* admin, the caller must themselves be an active admin —
// which means there are two, and the guard passes. The one remaining path,
// an admin acting on themselves, is refused earlier by the self-action checks
// in tests 15 and 16.
//
// The guard becomes live the moment platform support is given staff
// permissions over a tenant, which is a realistic near-term need. It stays,
// documented as defensive, rather than being claimed as tested.
const admins = ayushStaff.body.filter((s) => s.role === 'hospital_admin');
check('fixture has exactly one admin (precondition, not the guard itself)',
  admins.length === 1, `got ${admins.length}`);

console.log('\n=== 18. Cross-tenant staff access is not found, not forbidden ===');
const crossStaff = await call('GET', `/staff/${cityClinician.staff.id}`, { token: ayushAdmin.token });
check(
  'returns 404, revealing nothing about the other tenant',
  crossStaff.status === 404,
  `got ${crossStaff.status}`,
);

console.log('\n=== 19. Deactivation cuts live sessions immediately ===');
const target = ayushStaff.body.find((s) => s.role === 'front_desk');
const targetSignIn = await signIn(target.email);
check('target signed in before deactivation', !!targetSignIn.token);

const meBefore = await call('GET', '/auth/me', { token: targetSignIn.token });
check('their token works', meBefore.status === 200, `got ${meBefore.status}`);

const deactivate = await call('POST', `/staff/${target.id}/deactivate`, {
  token: ayushAdmin.token,
  body: { reason: 'smoke test' },
});
check('deactivation returns 200', deactivate.status === 200, `got ${deactivate.status} ${deactivate.raw.slice(0, 150)}`);

const meAfter = await call('GET', '/auth/me', { token: targetSignIn.token });
check(
  'their existing token stops working at once',
  meAfter.status === 401,
  `got ${meAfter.status} — deactivation that waits for token expiry is not a security control`,
);

console.log('\n=== 20. Reinstating restores access ===');
const reinstate = await call('POST', `/staff/${target.id}/reinstate`, { token: ayushAdmin.token });
check('returns 200', reinstate.status === 200, `got ${reinstate.status}`);
check('status back to active', reinstate.body?.status === 'active', reinstate.body?.status);


finish();
