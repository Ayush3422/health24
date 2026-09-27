# Runbook — backups, and restoring from one

**When to use this.** A restore: somebody deleted or corrupted data, a migration
went wrong, or the database is gone. Also on a schedule, as a drill, because a
backup nobody has restored is not a backup (sp7-plan.md, DF7).

**Who can do it.** Somebody with the AWS role that can restore an RDS instance,
and the database owner's credentials from Secrets Manager.

**What this cannot do.** Bring back something never in a backup — an object
deleted from storage past its version expiry, or a record erased under the DPDP
Act, which is meant to be unrecoverable.

---

## What is backed up

| What | How | How often | Kept | Who can read it |
| --- | --- | --- | --- | --- |
| The database | RDS automated backups with point-in-time recovery | Continuously; a daily snapshot | 14 days (7 in staging) | The AWS role that can restore; encrypted with the database's KMS key |
| Uploaded documents and rendered PDFs | S3 versioning | Every write | Current version indefinitely; old versions 90 days | The API and worker task roles, and an operator with the bucket's KMS key |
| The audit trail | It is in the database | With the database | With the database | As the database |
| Operational logs | CloudWatch | Continuously | 30 days (14 in staging) | Whoever can read the log group |
| Secrets | Secrets Manager, with a 7-day recovery window | On change | 7 days after deletion | Named people, and the task execution role |

**Not backed up, deliberately:** anything on a developer's machine, and any
environment other than production — staging holds synthetic data, and a copy of
production is never made into it (DF1).

**What a backup does not protect against:** an application bug that writes wrong
data and is not noticed for a month. Point-in-time recovery reaches back
fourteen days. The defence against that is the record's own immutability — a
correction is a new version, and nothing is overwritten (`sp3-plan.md` S3).

---

## The drill

Run it. It takes seconds locally and it runs in CI on every push, so a failure
is noticed by whoever caused it:

```bash
pnpm --filter @health24/api db:restore-drill
```

It dumps the database, restores it into a scratch copy, and then asks the copy
five questions: is the schema at the version the code expects, is the record
there, is row-level security still enabled and forced, does the application see
nothing without a hospital context, and does it see the right rows with one. It
touches nothing it is checking.

`apps/api/test/restore-drill.e2e-spec.ts` does the same and then **boots the
application against the restored copy** and signs a member of staff in to read a
patient through the API — because "the dump restores" and "the system runs on
it" are different claims, and only the second is worth anything at three in the
morning.

### What it measured, last time it was run

On a developer's machine, against the integration database (a 0.45 MB dump —
two hospitals, nine patients):

| Step | Time |
| --- | --- |
| Dump | 1.4 s |
| Restore | 3.8 s |
| Verify | 0.08 s |
| **Total** | **5.6 s** |

These numbers are about the shape of the process, not about production. **The
recovery time to promise a hospital is the one measured against a
production-sized copy**, and that measurement is a task for the first staging
environment (SP8). Until then the honest statement is: the procedure works and
takes seconds on a small database; how long it takes on a real one is not yet
known.

### RPO and RTO

| | Target | Where it comes from |
| --- | --- | --- |
| **RPO** — data that can be lost | **5 minutes** | RDS point-in-time recovery, which replays to any second within the retention window. The alarm `database-backup-age` fires if recovery falls more than two hours behind. |
| **RTO** — time to be serving again | **2 hours**, to be confirmed | An RDS point-in-time restore creates a new instance, which takes tens of minutes for a small database; the steps around it below take about twenty. Not yet measured at production size. |

---

## Restoring, in production

1. **Stop making it worse.** If the cause is a deploy, roll it back
   (`docs/deployment.md`). If the cause is a bug still writing, scale the API to
   zero: a restore that finishes while the bug is still running is a restore you
   will do twice.
2. **Decide the moment to restore to.** Point-in-time recovery needs a
   timestamp. The audit trail tells you when the damage started — it is
   append-only, so it survived whatever happened to the rest.
3. **Restore into a new instance**, never over the live one:
   ```bash
   aws rds restore-db-instance-to-point-in-time \
     --source-db-instance-identifier health24-production \
     --target-db-instance-identifier health24-production-restored \
     --restore-time 2026-09-27T14:05:00Z \
     --db-subnet-group-name health24-production \
     --vpc-security-group-ids <the database security group> \
     --no-publicly-accessible
   ```
4. **Check it before trusting it.** Point the drill at the restored instance:
   ```bash
   DATABASE_ADMIN_URL=<owner url on the restored instance> \
   DATABASE_URL=<application url on the restored instance> \
   RESTORE_DRILL_DATABASE=health24_check \
   pnpm --filter @health24/api db:restore-drill
   ```
   Five ticks, or stop and find out why.
5. **Create the application's login role** on the restored instance if it is not
   there, and grant it `health24_app`. It must not be the owner
   (`sp1-plan.md`).
6. **Switch over.** Update the `DATABASE_URL` and `DATABASE_ADMIN_URL` secrets
   to the restored endpoint and force a new deployment. The readiness probe will
   keep traffic away from any task that cannot reach it (DF6).
7. **Confirm.** `/ready` is 200, `/version` is the commit you expect, and a
   clinician can open a patient. Then tell whoever is waiting.
8. **Afterwards.** Write down what was lost — the window between the restore
   point and the incident — because that window is what a patient or a hospital
   has to be told about, and `breach-notification.md` may apply.

## Restoring a single document

A document is a version in S3, not a row. If a file was overwritten or deleted,
list its versions and copy the one you want back over the current version.
Never delete the newer version: the record of what happened is worth more than
tidiness.

## If the drill fails

A failed drill is an incident, even though nothing is broken yet. In order:

1. Which check failed? "The record is there" means the dump is incomplete;
   "row-level security survived" means the restore dropped policies, which would
   silently expose every hospital's rows to every other.
2. Do not fix it by loosening the check.
3. Until it passes, the honest position is that there is no tested backup — say
   so, in writing, to whoever needs to know.
