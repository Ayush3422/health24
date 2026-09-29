# Runbook: ABDM

Two things go wrong with the national network, and they go wrong at different
hours. A **transfer fails** and somebody is waiting for records that have not
arrived. A **consent is disputed** and somebody is saying records left that
should not have. This page is for both (sp8-plan.md, T36).

It is written for somebody who did not build this. Every query below has been
run against a real database.

---

## A transfer has not arrived

### 1. Find the request

Ask by the transaction id the requester or the gateway quotes. If all you have
is the patient, ask by them.

```sql
SELECT r.id, r.status, r.care_contexts_sent, r.care_contexts_requested,
       r.failure_reason, r.created_at, r.completed_at,
       c.grantee_abdm_hiu_name AS requester
  FROM abdm_data_request r
  JOIN consent_artefact c ON c.id = r.consent_artefact_id
 WHERE r.abdm_transaction_id = '<transaction id>';
```

The `status` is the whole answer, and each one means something different.

| Status | What it means | What to do |
| --- | --- | --- |
| `pending` | The transfer has not run. Either the job is queued and the worker is behind, or the job was lost | §2 |
| `transferred` | It ran and something was sent. If the requester says otherwise, the problem is at their end or in the gateway | §4 |
| `partly_transferred` | **The consent was withdrawn, or a push failed, part-way.** `failure_reason` says which | §3 |
| `failed` | Nothing was sent. `failure_reason` says why | §3 |
| `refused` | The consent was not in force, or admitted nothing of those visits | §3 — and it is probably not a fault |

If there is **no row at all**, the request never reached this system. Check that
the facility is registered here and that the callback secret matches:

```sql
SELECT id, name, hfr_id FROM hospital WHERE hfr_id = '<the X-HIP-ID they sent>';
```

A facility ABDM knows and this deployment does not is a configuration mistake,
not an incident: set `hfr_id` on the hospital and ask the requester to retry.

### 2. It is still pending

The transfer is a queued job with a sweep behind it. Anything still pending
after five minutes is taken on by the worker whether or not its job ever ran,
so **the first thing to check is that the worker is alive**:

```bash
curl -s localhost:3100/health
curl -s localhost:3100/metrics | grep queue
```

If the worker is down, start it; the sweep will pick the request up within five
minutes and nothing needs doing by hand. If the worker is up and the request
has been pending for much longer than that, the sweep is failing — read the
worker's log for `Transfer <id> failed` and treat it as §3.

### 3. It failed, was refused, or stopped part-way

`failure_reason` is written to be read by a person. The three that happen:

- **"The consent was withdrawn while the transfer was running."** Not a fault.
  The patient changed their mind and this system stopped. What had already gone
  cannot be recalled; `care_contexts_sent` says how much. Tell the requester
  the consent ended — they will hear it from the consent manager too.
- **"A push failed: the requester answered HTTP 5xx"** (or a timeout). Their
  endpoint was unreachable. The job retries three times with a growing delay;
  if all three fail the row settles as `failed`. Once they are back, the
  requester asks again with a **new transaction id** — this system will not
  re-send under the old one, deliberately, because a transfer recorded as
  finished must not quietly happen twice.
- **"The consent admits nothing of these visits."** The consent's health
  information types map to nothing this system holds, or its date range
  excludes everything. Check the artefact:

```sql
SELECT data_categories, date_range_from, date_range_to, abdm_unmapped_types,
       status, expires_at
  FROM consent_artefact WHERE abdm_consent_id = '<consent id>';
```

`abdm_unmapped_types` is the interesting column: it lists what the consent
asked for that this system does not hold. If it is full, the patient consented
to something we have none of, and the answer to the requester is that there is
nothing to send.

### 4. It says transferred and they say nothing arrived

Confirm what left, and when:

```sql
SELECT resource_type, count(*) AS rows, min(at) AS first, max(at) AS last
  FROM access_log
 WHERE consent_artefact_id = '<artefact id>'
 GROUP BY resource_type ORDER BY rows DESC;
```

Every row that was sent is there, attributed to the requester. If that list is
full and they received nothing, the failure is between this system and them:
the push goes **directly** to the URL they supplied, not through the gateway,
so ask them for their side's logs for that transaction id. Nothing can be
re-sent under the same transaction id; they must ask again.

---

## A consent is disputed

Somebody — the patient, a hospital, or the consent manager — says records were
shared that should not have been. Four questions, in order.

### 1. Does the artefact exist here, and what did it say?

```sql
SELECT id, abdm_consent_id, grantee_abdm_hiu_name, status,
       data_categories, date_range_from, date_range_to,
       granted_at, expires_at, revoked_at, revocation_reason
  FROM consent_artefact WHERE abdm_consent_id = '<consent id>';
```

The row is what this system acted on. `data_categories` and the date range are
what it permitted — not what the consent manager's screen said, which is a
separate record held by them, and the two are worth comparing.

### 2. Which visits did it cover?

```sql
SELECT c.encounter_id, c.display, c.status, c.linked_at, c.unlinked_at
  FROM abdm_care_context c
 WHERE c.encounter_id = ANY (
         SELECT unnest(abdm_care_context_ids) FROM consent_artefact
          WHERE abdm_consent_id = '<consent id>');
```

A consent covers the care contexts it named when it was granted, and nothing
linked afterwards.

### 3. What actually left?

```sql
SELECT a.at, a.action, a.resource_type, a.resource_id, a.actor_label
  FROM access_log a
  JOIN consent_artefact c ON c.id = a.consent_artefact_id
 WHERE c.abdm_consent_id = '<consent id>'
 ORDER BY a.at;
```

This is the answer to the dispute. Every row that was put in a bundle is here,
with the moment it left and the requester it went to. If a row is **not** here,
it did not leave under this consent.

### 4. Stop it, if it should be stopped

Any of these ends it for this system, at once:

- The patient revokes it in their **ABHA app**; the consent manager notifies
  us and the artefact is marked revoked. This is the one that ends it
  everywhere.
- The patient revokes it in **our portal**. Immediate here, and it does **not**
  reach the consent manager — tell them to do the first as well.
- The hospital **unlinks the visit** on the ABDM screen. New requests stop
  finding it; an existing consent is unaffected, so do this as well as, not
  instead of, a revocation.

In an emergency, as the system:

```sql
UPDATE consent_artefact
   SET status = 'revoked', revoked_at = now(),
       revocation_reason = '<who asked, and why>'
 WHERE abdm_consent_id = '<consent id>' AND status = 'active';
```

Nothing more is needed: assembly reads the artefact before every visit, so a
transfer already running stops at its next one.

**Then record it.** A consent dispute is a privacy complaint until somebody
decides it is not — see [breach-notification.md](breach-notification.md) for
when it becomes one, and
[docs/compliance/dpdp-self-assessment.md](../compliance/dpdp-self-assessment.md)
for who answers it.

---

## What this runbook cannot tell you

**Whether the consent manager's record matches ours.** We hold what we were
notified; they hold what the patient approved. If those disagree, that is
ABDM's question and ours together, and there is no query here that settles it.

**Whether the requester kept what they received.** A transfer is not
recallable. The consent's `dataEraseAt` is when they undertook to erase it, and
enforcing that is not something this system can do.
