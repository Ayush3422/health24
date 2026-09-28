# Retention and erasure

How long each thing is kept, what happens when a patient asks for it to be
erased, and what the law requires be kept anyway (sp7-plan.md, T29).

Two rules pull in opposite directions, and the tension is the whole subject:

- **The DPDP Act** says personal data is erased when the purpose is served or
  consent is withdrawn — unless a law requires it kept.
- **Medical records law and a hospital's own obligations** require a clinical
  record to be kept for years, and an invoice for longer.

So an erasure request is answered by deciding, per category, which rule applies
— and by recording that decision. The system's job is to make the decision
explicit, reversible only forwards, and auditable. It is not to guess the
periods, and it does not: **the periods below are not yet confirmed by counsel,
and that is the largest open item on this page.**

---

## What is kept, and for how long

| What | Kept | Why, and by what |
| --- | --- | --- |
| The clinical record — encounters, diagnoses, prescriptions, procedures, results, notes | **Indefinitely, pending confirmation** | A clinical record has value for the patient's whole life, and the retention period is set by medical-records law and by the hospital's own policy. **Unconfirmed** |
| Documents and rendered PDFs | As the clinical record; old versions 90 days | `infra/terraform/data-stores.tf` |
| Invoices, charges and the money ledger | **8 years, pending confirmation** | Tax and company law, not health law. An accountant confirms |
| The audit trail | **Indefinitely, pending confirmation** | It is the evidence that consent was honoured and who read what; erasing it would erase the proof that erasure happened |
| Consent artefacts | As the audit trail | They are the authority the audit trail refers to |
| Operational logs | 30 days (14 in staging) | `infra/terraform`, `docs/observability.md`. They carry identifiers, not people (DF4) |
| Load balancer access logs | 30 days | As above, and they carry paths |
| Backups | 14 days of point-in-time recovery (7 in staging) | `runbooks/restore.md` |
| Sessions and refresh tokens | 30 days, or until revoked | `REFRESH_TOKEN_TTL_DAYS` |
| Sign-in codes | 15 minutes | Hashed, never stored in clear |
| A patient's exported copy of their record | 7 days, then deleted | It is a file containing an entire record; it should not sit in storage |
| Staff accounts | While employed, then deactivated — never deleted | Their name is on clinical entries, and an entry with an unattributable author is worse than a retained account |

**A note on "indefinitely".** It appears twice above and both are uncomfortable.
Neither is a decision to keep data forever; both are an admission that the
period is somebody else's to set and has not been set yet. When it is, it
belongs in this table and in a scheduled job, not in a person's memory.

---

## What happens when a patient asks for erasure

The workflow is SP5's (Decision N1), and it exists because the naive version —
a delete button — would either break the clinical record or lie to the patient.

1. **The patient asks**, from the portal, with a reason if they want to give one.
2. **A reviewer decides**, per category, and must record a note saying what law
   or duty requires anything kept. The reviewer is the hospital's data
   protection reviewer, not a clinician, and not us.
3. **The outcome is one of three**, and each is recorded:
   - `erased` — everything asked for is gone,
   - `partly_erased` — what could go, went; the note says what stayed and why,
   - `refused` — nothing went; the note says why.
4. **What was erased is summarised** on the request, so the patient can be told
   precisely rather than reassuringly.
5. **The audit trail records the erasure**, and is not itself erased.

### What erasure actually removes

| Category | On erasure |
| --- | --- |
| Portal access and sessions | Revoked immediately; the account can no longer sign in |
| Contact details — phone, email, address | Removed from the patient record |
| Documents and their files | Objects deleted from storage, including old versions (the worker holds the only role that may) |
| The clinical record | **Kept**, pending the confirmed period. This is the row a patient is most likely to argue with, and the reviewer has to be able to explain it |
| Invoices and the ledger | **Kept** for the tax period |
| The audit trail | **Kept**. It records that the erasure happened |

### What erasure cannot undo

An export the patient asked for and downloaded is theirs. A document another
hospital read under consent, while the consent was in force, was read — the
audit trail says so, and no erasure here reaches into their record.

---

## What is not built yet

- **No scheduled deletion.** Nothing expires a clinical record, an invoice or an
  audit row on a timer, because no period is confirmed. When one is, it is a
  job in the worker with the same shape as the daily summary: it runs, it is
  idempotent, and it records what it did.
- **No legal hold.** If a record is subject to a dispute it should be exempt
  from any scheduled deletion, and there is no flag for that today. It is
  needed before the first scheduled deletion, not after.
- **No retention report.** A hospital's records officer will eventually ask "what
  do you hold about this patient, and until when". The data exists; the report
  does not.

---

## The open items, with owners

| # | Open | Owner | Before |
| --- | --- | --- | --- |
| 1 | The retention period for a clinical record, under medical-records law and the hospital's policy | Counsel, with the hospital's records officer | First real patient record |
| 2 | The retention period for invoices and the ledger | An accountant | First real patient record |
| 3 | The retention period for the audit trail — long enough to answer a regulator, no longer | Counsel | First real patient record |
| 4 | Whether a patient may erase a clinical record at all, and on what conditions | Counsel | First erasure request from a real patient |
| 5 | Scheduled deletion, legal hold, and a retention report | Developer, once 1–3 are answered | Before the first period expires |

Until 1–3 are answered, the honest position to give a hospital is: **nothing is
deleted on a timer, everything is deleted on request except what we can name a
reason to keep, and the reason is written down every time.**
