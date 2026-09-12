/**
 * End-to-end smoke test of the SP1 authentication flow, driven over real HTTP
 * against a running API.
 *
 * This exists alongside the unit tests because the properties it checks are
 * emergent — they depend on the guards, the database, the transaction
 * boundaries and the token lifecycle all behaving together. Two real defects
 * were caught here that every layer passed in isolation:
 *
 *   - Refresh-token reuse revoked sessions inside the same transaction that
 *     then threw, so the revocation was rolled back by its own error path.
 *   - A stale .tsbuildinfo let tsc exit 0 without emitting, so an earlier
 *     build kept serving while "passing".
 *
 * Prerequisites: the API running on :3000, and a seeded database whose staff
 * have not yet enrolled a second factor.
 *
 *   pnpm db:up && pnpm db:migrate && pnpm db:bootstrap && pnpm db:seed
 *   pnpm --filter @health24/api build && pnpm --filter @health24/api start
 *   pnpm smoke:auth
 */
import * as OTPAuth from 'otpauth';

const BASE = 'http://localhost:3000/api/v1';
let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`);
}

async function post(path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

async function get(path, token) {
  const res = await fetch(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: json, raw: text };
}

const EMAIL = 'meera@sanjeevani.example.in';
const PASSWORD = 'health24-dev-password';

console.log('=== 1. Wrong password is rejected ===');
const bad = await post('/auth/login', { email: EMAIL, password: 'wrong-password-here' });
check('wrong password returns 401', bad.status === 401, `got ${bad.status}`);

console.log('\n=== 2. Unknown account is indistinguishable from wrong password ===');
const unknown = await post('/auth/login', { email: 'nobody@nowhere.example.in', password: PASSWORD });
check('unknown email returns 401', unknown.status === 401, `got ${unknown.status}`);
check(
  'same message for unknown account and wrong password',
  JSON.stringify(unknown.body?.message) === JSON.stringify(bad.body?.message),
  `${unknown.body?.message} vs ${bad.body?.message}`,
);

console.log('\n=== 3. Correct password does NOT return a session ===');
const login = await post('/auth/login', { email: EMAIL, password: PASSWORD });
check('login returns 200', login.status === 200, `got ${login.status}`);
check('no access token issued yet', !login.body?.accessToken, 'credentials alone must not open a session');
check(
  'MFA enrolment demanded on first sign-in',
  login.body?.status === 'mfa_enrolment_required',
  `status=${login.body?.status}`,
);
check('otpauth URL provided', typeof login.body?.otpauthUrl === 'string');

console.log('\n=== 4. Protected route rejects an unauthenticated caller ===');
const noAuth = await get('/auth/me');
check('GET /auth/me without token returns 401', noAuth.status === 401, `got ${noAuth.status}`);

console.log('\n=== 5. Enrol the second factor with a real TOTP code ===');
const totp = OTPAuth.URI.parse(login.body.otpauthUrl);

const wrongCode = await post('/auth/mfa/enrol', {
  challengeToken: login.body.challengeToken,
  code: '000000',
});
check('incorrect TOTP code rejected', wrongCode.status === 401, `got ${wrongCode.status}`);

const enrol = await post('/auth/mfa/enrol', {
  challengeToken: login.body.challengeToken,
  code: totp.generate(),
});
check('enrolment succeeds', enrol.status === 200, `got ${enrol.status} ${enrol.raw.slice(0, 200)}`);
check('access token issued', typeof enrol.body?.accessToken === 'string');
check('refresh token issued', typeof enrol.body?.refreshToken === 'string');
check('recovery codes shown once', Array.isArray(enrol.body?.recoveryCodes) && enrol.body.recoveryCodes.length === 10,
  `got ${enrol.body?.recoveryCodes?.length}`);
check('staff profile carries hospital', typeof enrol.body?.staff?.hospitalName === 'string',
  enrol.body?.staff?.hospitalName);
check('system of medicine recorded', enrol.body?.staff?.systemOfMedicine === 'ayurveda',
  enrol.body?.staff?.systemOfMedicine);

const accessToken = enrol.body.accessToken;
const refreshToken = enrol.body.refreshToken;

console.log('\n=== 6. Authenticated routes now work ===');
const me = await get('/auth/me', accessToken);
check('GET /auth/me returns 200', me.status === 200, `got ${me.status}`);
check('correct identity returned', me.body?.email === EMAIL, me.body?.email);
check('mfaEnrolled is true', me.body?.mfaEnrolled === true);

const sessionList = await get('/auth/sessions', accessToken);
check('session list returns 200', sessionList.status === 200);
check('exactly one active session', sessionList.body?.length === 1, `got ${sessionList.body?.length}`);
check('current session flagged', sessionList.body?.[0]?.isCurrent === true);

console.log('\n=== 7. Second login now asks for the code, not enrolment ===');
const login2 = await post('/auth/login', { email: EMAIL, password: PASSWORD });
check('status is mfa_required', login2.body?.status === 'mfa_required', `status=${login2.body?.status}`);
check('no secret re-issued', !login2.body?.secret, 'must not hand out the secret again');

console.log('\n=== 8. Refresh token rotation ===');
const refreshed = await post('/auth/refresh', { refreshToken });
check('refresh returns 200', refreshed.status === 200, `got ${refreshed.status}`);
check('new refresh token differs', refreshed.body?.refreshToken !== refreshToken, 'token must rotate');

console.log('\n=== 9. Reusing a rotated refresh token revokes everything ===');
const replay = await post('/auth/refresh', { refreshToken });
check('replayed token rejected', replay.status === 401, `got ${replay.status}`);

const afterReplay = await post('/auth/refresh', { refreshToken: refreshed.body.refreshToken });
check(
  'the successor token was ALSO revoked (theft response)',
  afterReplay.status === 401,
  `got ${afterReplay.status} — reuse must revoke every session, not just the replayed one`,
);

console.log('\n=== 10. Access token stops working once its session is revoked ===');
const meAfter = await get('/auth/me', accessToken);
check(
  'access token rejected after session revocation',
  meAfter.status === 401,
  `got ${meAfter.status} — a revoked session must not survive until token expiry`,
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
