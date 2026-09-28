# Runbook — being on call

What somebody on call needs to know before the first page, and what they are
expected — and not expected — to do (sp7-plan.md, T26, DF9).

**Read this when you go on call, not when something breaks.**

---

## What you are actually responsible for

A hospital does not stop when the system does. The patient in front of a
clinician is still there, and the clinician falls back to paper. So the job on
call is, in order:

1. **Tell them.** A hospital that knows the system is down for an hour manages.
   One that keeps trying, with a patient waiting, does not.
2. **Restore service** — `incident-response.md`.
3. **Protect the record.** If there is any chance data was reached by somebody
   who should not have, stop and use `breach-notification.md` instead.

Notice what is *not* on the list: fixing the cause. That is tomorrow's work,
with somebody awake.

## Before your shift

- [ ] You can sign in to AWS and assume the deploy role.
- [ ] `aws ecs describe-services --cluster health24-production --services api`
      answers.
- [ ] You can read the logs: `aws logs tail /health24/production/api --since 5m`.
- [ ] You know where the runbooks are, offline as well — a laptop with no
      network is the one case where a repository in the cloud is no help.
- [ ] You have the hospital's own contact, and they have yours.
- [ ] You are subscribed to the alerts topic. Send yourself a test alarm once.

If any of these is not true, say so before the shift rather than during it.

## What pages you, and how fast to answer

| Signal | Answer within | Where it goes |
| --- | --- | --- |
| `api-no-healthy-tasks` | 15 minutes, any hour | Nothing is serving |
| `api-5xx` sustained | 15 minutes in hospital hours, 1 hour otherwise | Clinicians are hitting errors |
| `database-storage` | 1 hour | It is a warning until it is not |
| `database-backup-age` | Next morning | The backup is at risk, not the service |
| A hospital calls | Immediately | They are not paging for fun |

**Hospital hours are the ones that matter.** An outpatient clinic runs
7am–2pm; a ward and casualty run all night. Assume somebody is working.

## What you may do without asking

- Roll back a deploy.
- Restart or stop a task; raise `desired_count`.
- Revoke a session or deactivate an account, if it is being misused.
- Rotate a secret.
- Say out loud that the system is down.

## What you wake somebody else for

- **Restoring the database.** Never alone, never without a second person
  watching — `restore.md`.
- **Anything that might be a breach.** Two people, from the first minute.
- **Changing data by hand.** The answer is almost always no; if it is truly
  yes, it is two people and a written record.
- **Turning off a control** to get past an error. Also almost always no.

## What you do not have to do

- Find the cause tonight.
- Answer a question you cannot answer. "I do not know yet, I will tell you by
  eight" is a complete answer.
- Be certain. Acting on a suspicion early is cheaper than being sure late.

## Handing over

At the end of a shift, in writing, even if nothing happened — "quiet" is
information:

- What fired, what you did, and what is still open.
- Anything you noticed and did not chase.
- Anything in a runbook that was wrong. **Correct it while you remember**; a
  runbook is only worth what the last person's honesty put into it.

## When there is no rota

Right now there is one developer and no pilot hospital, so "on call" means
whoever built it. That is fine for synthetic data and not fine for a real
patient record: a single person is a single point of failure, asleep for eight
hours a day.

**Before the first real record**: two people, a written rota, and one rehearsal
of a page at an inconvenient hour. Listed in `sp7-plan.md` under work outside
the code.
