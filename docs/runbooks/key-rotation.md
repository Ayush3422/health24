# Runbook — rotating a key

**When to use this.** On a schedule (once a year is a reasonable default), when
somebody who knew a key leaves, or immediately when a key may have leaked. If
this is a leak, read [secrets.md](../secrets.md) first: rotation is step one of
three.

**Who can do it.** Somebody who can change the environment of the deployed
services and run a one-off job against the database.

**How long it takes.** Half an hour, most of which is two deploys. There is no
outage and nobody is signed out, as long as the steps are done in this order.

**What breaks if you skip the overlap.** Setting a new key without keeping the
old one accepted means: every signed-in user is thrown out at once, and — for
the encryption key — **nobody can pass their second factor again**, because
every stored secret was written with the old key. That is an outage that ends
with an administrator resetting the second factor of every member of staff by
hand.

---

## The two keys

| Key | Written with | Read with | Rows to move |
| --- | --- | --- | --- |
| `JWT_ACCESS_SECRET` | current | current, then previous | none — tokens expire on their own |
| `TOTP_ENCRYPTION_KEY` | current | current, then previous | `staff_user.totp_secret_encrypted`, `emergency_card.token_encrypted` |

The signing secret needs no rewrite: an access token lives fifteen minutes and
a refresh token thirty days, so the overlap only has to outlast what is in
circulation. The encryption key protects data at rest, so its rows have to be
rewritten before the old key can be withdrawn.

---

## Rotating `JWT_ACCESS_SECRET`

1. **Generate one.** 32 bytes, from a generator, never chosen by a person:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

2. **Put the current secret into `JWT_ACCESS_SECRET_PREVIOUS`** and the new one
   into `JWT_ACCESS_SECRET`, in the secret store, together. The two must differ
   — the API refuses to start if they are the same, which is the mistake this
   check exists to catch.

3. **Deploy.** From here, new tokens are signed with the new secret and tokens
   signed with the old one are still accepted.

4. **Wait out the longest token.** Thirty days for a refresh token, on the
   default `REFRESH_TOKEN_TTL_DAYS`. If the rotation is a response to a leak,
   do not wait: revoke every session instead, which signs everybody out and
   makes the old secret worthless immediately.

5. **Remove `JWT_ACCESS_SECRET_PREVIOUS` and deploy again.** Anything still
   holding an old token is now signed out, which is the point.

---

## Rotating `TOTP_ENCRYPTION_KEY`

1. **Generate one**, as above.

2. **Put the current key into `TOTP_ENCRYPTION_KEY_PREVIOUS`** and the new one
   into `TOTP_ENCRYPTION_KEY`, together.

3. **Deploy.** Secrets are now written with the new key and read with either,
   so signing in keeps working while the rows are still on the old key.

4. **Rewrite the rows**, with both keys in the environment:

   ```bash
   pnpm --filter @health24/api keys:rewrap
   ```

   It prints a count per table: rewritten, already current, unreadable. It runs
   in one transaction per table, and running it twice is safe — the second run
   rewrites nothing.

5. **If it reports anything unreadable, stop.** A row neither key opens was
   written by something else, and withdrawing the old key would make it
   permanently unreadable. Find out what wrote it first. Nothing has been
   damaged: the script leaves unreadable rows exactly as they are.

6. **Remove `TOTP_ENCRYPTION_KEY_PREVIOUS` and deploy again.**

7. **Check.** Sign in as one account with its authenticator app. If the second
   factor is accepted, every row moved.

---

## Afterwards

- Record the rotation: which key, when, by whom, and why. The compliance
  self-assessment refers to this history.
- Destroy the old value. A retired key sitting in a password manager is a live
  key until somebody deletes it.
- If this was a leak, continue with [secrets.md](../secrets.md) — the audit
  trail, and whether it is reportable.

## What proves this works

`apps/api/test/key-rotation.e2e-spec.ts` walks these steps against a real
database: a token issued before the rotation is still accepted during the
overlap, a second factor stored under the old key still opens the door, the
rewrite moves every row and moves nothing on a second run, and once the old key
is withdrawn a token signed with it is refused. If this runbook is ever wrong,
that test is where to make it right.
