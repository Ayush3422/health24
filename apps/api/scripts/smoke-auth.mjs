/**
 * End-to-end smoke test of the SP1 authentication flow, over real HTTP.
 *
 * This exists alongside the unit tests because the properties it checks are
 * emergent — they depend on the guards, the database, the transaction
 * boundaries and the token lifecycle behaving together. Two real defects were
 * caught here that every layer passed in isolation:
 *
 *   - Refresh-token reuse revoked sessions inside the same transaction that
 *     then threw, so the revocation was rolled back by its own error path.
 *   - A stale .tsbuildinfo let tsc exit 0 without emitting, so an earlier
 *     build kept serving while "passing".
 *
 * Re-runnable: it creates its own never-signed-in account each run, so the
 * first-login path is exercised every time rather than only once.
 *
 *   pnpm db:up && pnpm db:migrate && pnpm db:bootstrap && pnpm db:seed
 *   pnpm --filter @health24/api build && pnpm --filter @health24/api start
 *   pnpm smoke:auth
 */
import * as OTPAuth from 'otpauth';
import { call, createStaff, reporter, signIn } from './lib/smoke-client.mjs';

const { check, section, finish } = reporter();

section('Setup: a fresh account that has never signed in');
const admin = await signIn('admin@sanjeevani.example.in');
const fresh = await createStaff(admin.token, { role: 'clinician', systemOfMedicine: 'ayurveda' });
check('fresh account created and invitation accepted', !!fresh.email, fresh.email);

section('1. Wrong password is rejected');
const bad = await call('POST', '/auth/login', {
  body: { email: fresh.email, password: 'definitely-the-wrong-password' },
});
check('returns 401', bad.status === 401, `got ${bad.status}`);

section('2. Unknown account is indistinguishable from a wrong password');
const unknown = await call('POST', '/auth/login', {
  body: { email: 'nobody@nowhere.example.in', password: fresh.password },
});
check('returns 401', unknown.status === 401, `got ${unknown.status}`);
check(
  'identical message, so the endpoint cannot enumerate staff',
  JSON.stringify(unknown.body?.message) === JSON.stringify(bad.body?.message),
  `${unknown.body?.message} vs ${bad.body?.message}`,
);

section('3. Correct password does NOT return a session');
const login = await call('POST', '/auth/login', {
  body: { email: fresh.email, password: fresh.password },
});
check('returns 200', login.status === 200, `got ${login.status}`);
check('no access token yet', !login.body?.accessToken, 'credentials alone must not open a session');
check(
  'second factor enrolment demanded',
  login.body?.status === 'mfa_enrolment_required',
  `status=${login.body?.status}`,
);
check('otpauth URL provided', typeof login.body?.otpauthUrl === 'string');

section('4. Protected routes reject an unauthenticated caller');
const noAuth = await call('GET', '/auth/me');
check('GET /auth/me returns 401', noAuth.status === 401, `got ${noAuth.status}`);

section('5. Enrolling the second factor');
const totp = OTPAuth.URI.parse(login.body.otpauthUrl);

const wrongCode = await call('POST', '/auth/mfa/enrol', {
  body: { challengeToken: login.body.challengeToken, code: '000000' },
});
check('incorrect code rejected', wrongCode.status === 401, `got ${wrongCode.status}`);

const enrol = await call('POST', '/auth/mfa/enrol', {
  body: { challengeToken: login.body.challengeToken, code: totp.generate() },
});
check('enrolment succeeds', enrol.status === 200, `got ${enrol.status} ${enrol.raw.slice(0, 160)}`);
check('access token issued', typeof enrol.body?.accessToken === 'string');
check('refresh token issued', typeof enrol.body?.refreshToken === 'string');
check(
  'ten recovery codes shown once',
  Array.isArray(enrol.body?.recoveryCodes) && enrol.body.recoveryCodes.length === 10,
  `got ${enrol.body?.recoveryCodes?.length}`,
);
check('hospital resolved', typeof enrol.body?.staff?.hospitalName === 'string', enrol.body?.staff?.hospitalName);
check('system of medicine recorded', enrol.body?.staff?.systemOfMedicine === 'ayurveda');

const accessToken = enrol.body.accessToken;
const refreshToken = enrol.body.refreshToken;

section('6. Authenticated routes now work');
const me = await call('GET', '/auth/me', { token: accessToken });
check('returns 200', me.status === 200, `got ${me.status}`);
check('correct identity', me.body?.email === fresh.email, me.body?.email);
check('mfaEnrolled is true', me.body?.mfaEnrolled === true);

const sessionList = await call('GET', '/auth/sessions', { token: accessToken });
check('session list returns 200', sessionList.status === 200);
check('exactly one active session', sessionList.body?.length === 1, `got ${sessionList.body?.length}`);
check('current session flagged', sessionList.body?.[0]?.isCurrent === true);

section('7. Second sign-in asks for a code, not enrolment');
const login2 = await call('POST', '/auth/login', {
  body: { email: fresh.email, password: fresh.password },
});
check('status is mfa_required', login2.body?.status === 'mfa_required', `status=${login2.body?.status}`);
check('secret is not re-issued', !login2.body?.secret, 'the secret must be shown once only');

section('8. A recovery code works as a second factor');
const recovery = await call('POST', '/auth/mfa/verify', {
  body: { challengeToken: login2.body.challengeToken, code: enrol.body.recoveryCodes[0] },
});
check('recovery code accepted', recovery.status === 200, `got ${recovery.status}`);

const login3 = await call('POST', '/auth/login', {
  body: { email: fresh.email, password: fresh.password },
});
const replayRecovery = await call('POST', '/auth/mfa/verify', {
  body: { challengeToken: login3.body.challengeToken, code: enrol.body.recoveryCodes[0] },
});
check(
  'the same recovery code cannot be used twice',
  replayRecovery.status === 401,
  `got ${replayRecovery.status} — a recovery code that survives its own use is not single-use`,
);

section('9. Refresh token rotation');
const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken } });
check('returns 200', refreshed.status === 200, `got ${refreshed.status}`);
check('token rotated', refreshed.body?.refreshToken !== refreshToken);

section('10. Reusing a spent refresh token revokes every session');
const replay = await call('POST', '/auth/refresh', { body: { refreshToken } });
check('replayed token rejected', replay.status === 401, `got ${replay.status}`);

const afterReplay = await call('POST', '/auth/refresh', {
  body: { refreshToken: refreshed.body.refreshToken },
});
check(
  'its successor was revoked too (theft response)',
  afterReplay.status === 401,
  `got ${afterReplay.status} — reuse must revoke every session, not only the replayed one`,
);

section('11. Access tokens die with their session');
const meAfter = await call('GET', '/auth/me', { token: accessToken });
check(
  'revoked session invalidates the access token at once',
  meAfter.status === 401,
  `got ${meAfter.status} — revocation that waits for token expiry is not revocation`,
);

finish();
