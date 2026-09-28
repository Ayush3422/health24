# Runbook — an incident

**When to use this.** An alarm fired, or somebody says the system is broken.
Not for a breach — that is `breach-notification.md`, and if there is any chance
data was reached by somebody who should not have, start there instead and come
back to this.

**Who runs it.** Whoever picks it up. Say so out loud — "I have this" — so that
two people are not fixing it in opposite directions.

**The order that matters:** find out what is broken, restore service, then find
out why. Diagnosing first is how a fifteen-minute outage becomes an hour.

---

## What the alarms mean

| Alarm | What it means | First thing to do |
| --- | --- | --- |
| `api-5xx` | The API is failing requests. A clinician is looking at a screen that will not work | Check `/ready` and the recent deploy |
| `api-no-healthy-tasks` | Nothing is serving at all | As above, then scale up |
| `database-storage` | The database is running out of room | Check autoscaling; a write that fails is a diagnosis that is not recorded |
| `database-backup-age` | Point-in-time recovery is falling behind | `restore.md` — the backup is the thing at risk, not the service |

An alarm that fires and resolves by itself still gets read. A flapping alarm is
either a real intermittent fault or a threshold that is wrong, and both need a
person.

---

## Triage, in five minutes

```bash
# What is running, and can it serve?
curl -fsS https://<api host>/version
curl -sS  https://<api host>/ready | jq

# What has it been doing? (the last deploy, and the task that is failing)
aws ecs describe-services --cluster health24-production --services api \
  --query 'services[0].{desired:desiredCount,running:runningCount,deployments:deployments[].{status:status,rollout:rolloutState,task:taskDefinition}}'

aws logs tail /health24/production/api --since 15m --filter-pattern '{ $.level >= 50 }'
```

`/ready` names which dependency is down, which is most of the diagnosis:

| `/ready` says | It is |
| --- | --- |
| `database: down` | RDS, its security group, or connections exhausted |
| `migrations: down` | A deploy that ran the image before the migration job finished |
| `redis: down` | ElastiCache. The API still serves; uploads go unscanned and patients untexted |
| `storage: down` | S3 or the task role. Documents will not open |
| everything `up`, still 5xx | The application itself — read the logs |

---

## Restore service first

| Symptom | The quickest safe action |
| --- | --- |
| It broke at a deploy | Roll back: deploy the previous image tag (`docs/deployment.md`). Migrations are additive, so the old image runs against the new schema |
| One task is bad, others are fine | Stop it; ECS starts a replacement |
| Everything is overloaded | Raise `desired_count`. It is a variable and a Terraform apply |
| The database is the problem | `restore.md` — but read it before acting; a restore is not a first response |
| A dependency outside us is down | Say so, publicly and early. A hospital can work on paper for an hour if somebody tells them to |

**Two things never done while restoring service:** editing data by hand to make
a screen work, and turning off a control — a policy, a guard, a header — to get
past an error. Both make the next hour worse and the incident report longer.

---

## Then find out why

With service restored, the interesting evidence is still there: logs for 30
days, the audit trail indefinitely, metrics in CloudWatch.

```bash
# Everything that happened while serving one request
aws logs filter-log-events --log-group-name /health24/production/api \
  --filter-pattern '{ $.req.id = "<request id>" }'
```

The request id is on every line and in the `x-request-id` header of the
response, so a clinician who quotes an error can be followed exactly.

---

## Telling people

- **Inside the first ten minutes**, if it is user-visible: say what is broken,
  what still works, and when the next update comes. "We do not know yet" with a
  time for the next update is a good update.
- **The hospital's own contact**, not only a status page. Somebody there has to
  decide whether to move to paper.
- **When it is over**: what happened, what was lost if anything, and what is
  being done. In the same channel as the first message.

---

## Afterwards

Within a week, in writing, blamelessly:

1. **What happened**, as a timeline from the log.
2. **Why it was possible** — the cause, not the trigger. "The deploy went out"
   is a trigger; "a migration ran while tasks were being replaced" is a cause.
3. **Why it took as long as it did**, which is usually the more useful half.
4. **What changes**: a test, an alarm, a runbook correction, a design change.
   Each with an owner and a date, or it is a wish rather than a change.

A postmortem with no change to anything is a signal that the wrong question was
asked.
