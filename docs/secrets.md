# Secrets

Where the values behind [configuration.md](configuration.md) come from, and
what must never hold them (sp7-plan.md, T3, DF3).

## The rule

**The repository carries names and shapes. It never carries values.** That
holds for the code, the infrastructure definitions, the CI configuration, a
test fixture, a comment, a commit message and a screenshot. A secret that has
been committed is a secret that has leaked, whatever happens to the commit
afterwards: it is in every clone and every fork already, so the response is to
rotate it, not to rewrite history.

## What counts as a secret here

| Secret | What it opens | Rotation |
| --- | --- | --- |
| `DATABASE_URL` password | The whole record, subject to row-level security | Change the role's password, redeploy |
| `DATABASE_ADMIN_URL` password | The whole record, **bypassing** row-level security | Held only by migration jobs and a named human, never by the running application |
| `JWT_ACCESS_SECRET` | Any session — a forged token is a signed-in clinician | [key-rotation.md](runbooks/key-rotation.md), overlap supported |
| `TOTP_ENCRYPTION_KEY` | Every second factor in the database | [key-rotation.md](runbooks/key-rotation.md), overlap supported |
| Object storage credentials | Every uploaded document and rendered PDF | Not used in production: the task's IAM role supplies short-lived credentials |
| SMS provider credentials | The ability to send as the hospital, and to read delivery reports | The provider's own console |

Two things that look like secrets and are not: `STORAGE_BUCKET` and
`CORS_ORIGINS` are configuration. Two things that are secrets and do not look
it: a full `DATABASE_URL` (it carries the password) and `SMS_LOG_FILE` in an
environment where codes are being written (it names a file full of live
sign-in codes, which is why production refuses to start with it set).

## Where the values live

**Locally.** In `.env` at the repository root, which `.gitignore` excludes.
`.env.example` lists the names with placeholder values, and the placeholders
are deliberately obvious — anything beginning `dev_only` is refused in
production by the schema.

**In production.** In AWS Secrets Manager in `ap-south-1`, one secret per
environment, injected into the task definition as environment variables. The
application never calls Secrets Manager itself: it reads its environment, so
the same binary runs unchanged locally, in staging and in production.

The Terraform in SP7 Phase 4 declares the secret **names** and the task's
permission to read them. It does not declare values, and `terraform plan` on a
fresh checkout must never print one.

## Who may see what

- **Nobody needs `DATABASE_ADMIN_URL` day to day.** It belongs to the migration
  job and to a named person for an incident, and its use is worth an alert.
- **A developer never needs a production secret.** Local work runs on synthetic
  data with local values (DF1); there is no path from production data to a
  developer's machine, and asking for one is a sign something else is wrong.
- **A secret read is an event.** Secrets Manager logs access to CloudTrail;
  reviewing that log is part of the incident runbook.

## When one leaks

Treat "possibly leaked" as "leaked". The order is: rotate, then work out what
it opened, then decide whether it is a reportable breach — in that order,
because the first step is the only one that stops the bleeding.

1. Rotate the secret — [key-rotation.md](runbooks/key-rotation.md) for the two
   that support an overlap; for a database password, change it and redeploy.
2. Revoke what it issued. A leaked `JWT_ACCESS_SECRET` means every live session
   is suspect: revoke all sessions, which signs everybody out.
3. Read the audit trail for what was done with it. That is what the audit trail
   is for, and it is append-only.
4. Follow [breach-notification.md](runbooks/breach-notification.md) if a
   patient's data may have been reached.
