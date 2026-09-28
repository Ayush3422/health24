# Runbook — a personal data breach

**When to use this.** The moment anybody suspects that a patient's data has been
seen, changed, lost or taken by somebody who should not have it. Suspicion is
enough to start: the first steps cost little and undo nothing.

**Who runs it.** Whoever notices, until somebody senior takes over. Do not wait
for the right person to be awake before doing step 1.

**Under the DPDP Act 2023, Health24 is a Data Fiduciary** and the hospital is
too. A breach is reportable to the Data Protection Board **and to every affected
patient** — there is no severity threshold in the Act, and no "minor breach"
exemption (sp7-plan.md, T26).

> **Timing.** The working assumption is **72 hours to the Board** and **without
> delay to affected patients**, which is what the Rules under the Act set out.
> **Counsel confirms this before the first real patient record exists** — it is
> listed as an open item in `docs/compliance/dpdp-self-assessment.md`, and
> nobody should be reading this page for the first time while a clock is
> running.

---

## The first hour

### 1. Write down the time, and start a log

One file, appended to, never edited. Every step below goes in it with a
timestamp and who did it. This log is what the Board, the hospital and counsel
will all ask for, and memory three days later is not evidence.

### 2. Stop it continuing

Pick the smallest action that stops the bleeding:

| What is happening | What to do |
| --- | --- |
| A session or account is being misused | Revoke that user's sessions; deactivate the account |
| A secret may have leaked | Rotate it — `key-rotation.md` — and revoke every session |
| A deploy is exposing something | Roll it back (`docs/deployment.md`) |
| Data is being read through a bug | Scale the API to zero. An outage is recoverable; a continuing breach is not |

Do not "fix it quickly" first. A hurried fix destroys the evidence of what
happened, and you will be asked.

### 3. Preserve what happened

- **Do not delete anything**, including the attacker's own rows.
- Snapshot the database now: a point-in-time restore of the current moment
  (`restore.md` step 3) into a separate instance, kept until this is closed.
- Export the relevant audit trail and logs before retention removes them — logs
  are kept 30 days, and an investigation can outlast that:
  ```sql
  -- Everything read for one patient, with who and under what authority
  SELECT at, actor_type, actor_id, actor_label, hospital_id, resource_type,
         resource_id, action, outcome, consent_artefact_id, break_glass_reason,
         route, ip_address
    FROM access_log
   WHERE patient_id = '<patient id>'
     AND at > now() - interval '30 days'
   ORDER BY at;
  ```
- The audit trail is append-only and survived whatever happened to the rest.
  That is what it is for.

### 4. Tell one other person

Even at three in the morning. A breach handled alone is a breach handled badly,
and the second person's job is to ask the questions the first person is too busy
to.

---

## Working out what was reached

The audit trail answers this, and it is the reason every read is recorded.

```sql
-- Which patients an actor touched, and how
SELECT patient_id, resource_type, action, count(*), min(at), max(at)
  FROM access_log
 WHERE actor_id = '<staff id>' AND at BETWEEN '<from>' AND '<to>'
 GROUP BY 1, 2, 3
 ORDER BY 5;

-- Anything reached under emergency access in a window
SELECT * FROM access_log
 WHERE break_glass_reason IS NOT NULL AND at BETWEEN '<from>' AND '<to>';
```

Write down, in the log:

- **Which patients.** By id. The notification is per patient.
- **What categories** — demographics, diagnoses, medicines, documents, bills.
- **When it started and when it stopped.**
- **How.** Stolen credential, missing authorisation check, leaked secret, a
  person exceeding their access.
- **What could follow for the patient.** The Act asks about likely consequences,
  and a patient asks the same question in plainer words.

If the audit trail cannot answer a question, say so plainly rather than
estimating. "We cannot rule out X" is a true sentence; a guess is not.

---

## Notifying

### The Data Protection Board

Within **72 hours** of becoming aware, on the Board's own channel. Include:

1. What happened, and when it was noticed.
2. Its nature and extent: how many patients, which categories of data.
3. Likely consequences for them.
4. What was done to contain it, and what will stop it recurring.
5. Who at Health24 is answering questions, with a name and a contact.

An incomplete report filed on time is better than a complete one filed late.
Say what is not yet known and follow up.

### The patients

**Without delay**, and not through the hospital alone — the Act puts this on the
Fiduciary. In plain language, in the language the patient uses if possible, and
covering:

- **What happened**, in a sentence, with no euphemism: "someone who should not
  have been able to see your records was able to see them".
- **What of theirs** was involved.
- **What they should do**, if anything. If nothing, say that.
- **What was done about it.**
- **Who to ask**, with a real contact.

Send it from the portal *and* by SMS to the number on the record: a patient who
never opens the portal is still entitled to be told.

### The hospital

Every hospital whose patients are affected, in parallel with the Board, because
they are a Fiduciary too and have their own obligations. The data-processing
agreement sets the mechanics.

---

## Afterwards

Within a fortnight, while it is still fresh:

- **A written account**: what happened, why it was possible, how it was found,
  how long it took, and what has changed. It goes in `docs/compliance/`.
- **A test for it.** Anything that got through is a case nobody had written down
  — put it in the suite so that it cannot happen the same way twice.
- **The threat model corrected.** If it claimed the thing that happened could
  not, that claim was wrong, and other claims beside it deserve a second look.
- **The honest question**: would we have noticed if nobody had told us? If the
  answer is no, the next piece of work is detection, not the fix.

---

## What this runbook assumes and does not have

- **No cyber-insurance notification step**, because there is no policy yet.
  Listed in `sp7-plan.md` under work outside the code.
- **No forensics retainer.** For anything beyond reading the audit trail, this
  needs somebody who does it professionally; agreeing who, in advance, is part
  of the pilot preparation.
- **The Board's filing channel is not yet a link here**, because it is not yet
  confirmed. Counsel provides it, and it goes in this paragraph.
