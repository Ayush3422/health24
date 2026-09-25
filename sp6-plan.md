# SP6 — Operations: Implementation Plan

**Status:** Approved for building. Decisions O–S answered 2026-09-20: **O1, P1, Q1, R1, S1**. No SP6 code had been written before that date.
**Scope:** Orders for tests and imaging, with results that find their way back to the order; admission, ward and bed, transfer and discharge; the surgery record; a discharge summary composed from the encounter's own data and signed by a clinician; a service catalogue, charge capture, itemised invoices, payments, part-payments and refunds; and the reports a hospital and the ministry ask for — including the statutory Ayush morbidity return, generated from coded diagnoses.
**Design reference:** `planning.md` §6, §11, §14 · `features.md` SP6 and Cross-cutting · `sp3-plan.md` (encounters, immutability, guard triggers) · `sp4-plan.md` (documents, structured results) · `sp5-plan.md` (the portal, and what a patient may see)

---

## 0. Decisions for you

**Answered 2026-09-20: O1, P1, Q1, R1, S1** — an order of its own that results point back to; an inpatient encounter with a bed history beside it; one operative record with implants; charges, invoices and an append-only ledger with no gateway; and reports computed over the operational database. The options considered are kept below for the record.

### Decision O — What an order is

SP4 already holds results: typed observations and scanned reports, both recorded against an encounter. An order is the thing that was asked for before a result existed.

| Option                                                                                  | What it means                                                                                                                                                                                                                                                                                                                    | Trade-off                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1. A `service_request` row of its own, which results point back to** _(recommended)_ | One table modelled on FHIR ServiceRequest: what was asked for, by whom, for which encounter, with a status that moves ordered → collected → in progress → resulted (or cancelled). Observations and documents gain a nullable `service_request_id`, so a result is linked to its order and an order can be asked what came back. | The order is a first-class record, which is what a lab worklist, a turnaround-time report and an unresulted-orders list all need. One more table under the same row-level security and immutability rules. |
| O2. A status on the result itself                                                       | An observation created early, in an `ordered` state, filled in later.                                                                                                                                                                                                                                                            | No new table. It breaks the rule that clinical rows are never edited, leaves an imaging order with nothing to hang on until a report arrives, and cannot express one order that yields three values.       |
| O3. O1 plus order sets and protocols                                                    | Reusable bundles: "LFT panel", "pre-operative screen".                                                                                                                                                                                                                                                                           | A real convenience for clinicians. It needs a catalogue, versioning and a review path of its own; better once single orders are in daily use.                                                              |

### Decision P — How far inpatient care goes

`features.md` asks for admission, transfer, discharge, and bed and ward assignment.

| Option                                                                      | What it means                                                                                                                                                                                                                                                  | Trade-off                                                                                                           |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **P1. An inpatient encounter with a bed history beside it** _(recommended)_ | Wards and beds are hospital master data. An admission is an encounter of class `inpatient`; each stay in a bed is a row with its own start and end, so a transfer is the end of one and the start of the next. Discharge ends the encounter and frees the bed. | The whole ward round, the census and the bill all read one history. No new encounter model — SP3's stands.          |
| P2. P1 plus full bed management                                             | Housekeeping states (occupied, cleaning, blocked), reservation ahead of admission, a census board that refreshes.                                                                                                                                              | What a large hospital runs on. It is a product in itself, and the pilot's wards are small enough to be read off P1. |
| P3. Orders and billing only; no inpatient in SP6                            | Outpatient stays the only setting.                                                                                                                                                                                                                             | Much smaller. It leaves surgery, the discharge summary and most of the billing worth having without a home.         |

### Decision Q — How deep the surgery record goes

| Option                                                                  | What it means                                                                                                                                                                                                                                  | Trade-off                                                                                                                                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Q1. One operative record on the inpatient encounter** _(recommended)_ | Pre-operative assessment, the operative note, implants and devices used, and the post-operative course — recorded against the existing `procedure` row, versioned and never overwritten, with the operative note also available as a document. | Covers what a discharge summary and a medico-legal request actually need. Implants are recorded because a patient must be traceable if a device is recalled. |
| Q2. A perioperative workflow                                            | Theatre lists and scheduling, an anaesthesia record with its own chart, consumables issued from stores.                                                                                                                                        | What a surgical hospital eventually wants. It brings scheduling and inventory into SP6, which would swallow the sub-project.                                 |

### Decision R — How money is handled

The first part of the system where a mistake costs a patient money rather than an inconvenience.

| Option                                                                                  | What it means                                                                                                                                                                                                                                                                                                                                                                                                  | Trade-off                                                                                                                                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1. Charges, invoices and an append-only payment ledger; no gateway** _(recommended)_ | A per-hospital service and procedure catalogue with prices; charges captured from orders, procedures and bed-days; an itemised invoice with a gapless number per hospital and financial year; payments, part-payments and refunds as ledger entries that are added, never edited; insurance and scheme fields (PM-JAY, private insurers) captured but never adjudicated. Money is stored in paise as integers. | An auditable money trail with no floating-point rounding and no edited history. Cash, UPI and card are recorded as they are taken at the desk. |
| R2. R1 plus an online payment gateway                                                   | The patient pays from the portal.                                                                                                                                                                                                                                                                                                                                                                              | Needs a merchant account, settlement reconciliation and refund handling against a third party. Worth doing when a pilot hospital asks for it.  |
| R3. Billing deferred to a later sub-project                                             | Orders, inpatient and reporting only.                                                                                                                                                                                                                                                                                                                                                                          | Smaller. Revenue reports and outstanding dues then have nothing to report on, and a hospital's own reason for buying the system is missing.    |

### Decision S — Where reports are computed

| Option                                                                                               | What it means                                                                                                                                                                                                                                                                                                                                                                                                            | Trade-off                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1. Queries over the operational database, with the heavy ones cached by IST day** _(recommended)_ | Footfall, diagnosis distribution, prescription patterns, revenue and the data-quality report are SQL over the same tables, run under the hospital's own row-level security. Daily counts that never change again are written to a summary table by a nightly job, so a year's report does not rescan a year of rows. The statutory Ayush morbidity return is generated from coded diagnoses and exported as CSV and PDF. | No second store to keep in step, and a report can never show a hospital another hospital's numbers, because the same policies decide what it may read.                                               |
| S2. A separate analytics database                                                                    | Operational data copied nightly into a store shaped for reporting.                                                                                                                                                                                                                                                                                                                                                       | The right answer at scale. It duplicates patient data into a second place that must be secured, audited and erased in step with the first — which the DPDP Act work in SP5 would have to reach into. |
| S3. Reporting deferred                                                                               | Operations without the numbers.                                                                                                                                                                                                                                                                                                                                                                                          | The Ayush morbidity return is a statutory obligation for the pilot hospital and the clearest payoff of dual coding. Deferring it wastes the reason the coding exists.                                |

---

## Defaults taken

Technical choices with a clear best answer. Each is reversible; say if you disagree.

| #    | Default                                                                                                                                                                                                                                                                                                                    | Why                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| DF1  | **Orders, bed stays and operative records are clinical rows**: tenant-scoped, audited, versioned where they can be corrected, and guarded by triggers that allow only the transitions the domain allows.                                                                                                                   | The rules that keep the clinical record honest do not stop at the ward door (`sp3-plan.md` S3).                                 |
| DF2  | **A result is linked to its order, never merged into it.** `observation` and `document_reference` gain a nullable `service_request_id`; the order's status moves as results arrive.                                                                                                                                        | One order can yield many values, and a result can arrive with no order behind it — both stay expressible.                       |
| DF3  | **Money is integer paise.** No floating point anywhere, in the database, the API or either app. Totals are computed from lines, never stored twice without a check.                                                                                                                                                        | Floating-point rupees are wrong by design, and the error compounds through part-payments and refunds.                           |
| DF4  | **The money trail is append-only.** An invoice is never edited: a mistake is corrected by a credit note, a repayment by a refund entry. Invoice numbers are gapless per hospital and financial year, issued by the database.                                                                                               | It is what an auditor and a tax officer expect, and what stops a dispute becoming somebody's word against another's.            |
| DF5  | **Billing never crosses a hospital.** Charges, invoices and payments are visible to the hospital that raised them, and no consent makes them readable elsewhere; consent covers clinical categories, not money.                                                                                                            | A consent artefact shares care data (`sp3-plan.md`); a patient's bill at one hospital is not another hospital's business.       |
| DF6  | **The discharge summary is composed, then signed.** The system assembles it from the encounter's own data — diagnoses, procedures, medicines, results, the course in hospital — and a clinician edits and signs it. Nothing is generated as clinical prose the system invents, and it is not a summary until it is signed. | `features.md` asks for auto-composition; `planning.md` §15 Q3 keeps a human between a machine and a clinical statement.         |
| DF7  | **The signed summary is a versioned clinical note and a document.** Signing writes the note version and renders the PDF that the patient sees in the portal and the next hospital reads.                                                                                                                                   | One artefact, two audiences, no second copy that can drift.                                                                     |
| DF8  | **A patient sees their bills in the portal as documents**, under the rights they already have (`sp5-plan.md`, DF7); no new money screen in SP6.                                                                                                                                                                            | The receipt is what a patient needs; a billing interface for patients is a later decision.                                      |
| DF9  | **Reports are read under the hospital's own context**, and a platform-level figure is aggregate only, with no patient identifiers, for the `platform_admin` role.                                                                                                                                                          | The same rule as everywhere else: the database decides what may be read, not the report.                                        |
| DF10 | **Statutory returns are generated, reviewed and recorded**: the return for a period is produced, shown for review, and the submitted version kept with what it contained and who submitted it.                                                                                                                             | A number sent to a ministry must be reproducible a year later, by which time the underlying record may have gained corrections. |

---

## Decisions already made

| #   | Decision                                                                                            | Source                       |
| --- | --------------------------------------------------------------------------------------------------- | ---------------------------- |
| S1  | Clinical rows are never edited or deleted; a correction is a new version.                           | `sp3-plan.md` S3             |
| S2  | Every read and write is audited; the audit trail is append-only.                                    | `planning.md` §6.4           |
| S3  | Row-level security binds to an unprivileged role; tenancy and consent are enforced by the database. | `sp1-plan.md`, `sp3-plan.md` |
| S4  | Dates that a person reads are India Standard Time; instants are stored with a time zone.            | `sp3-plan.md`                |
| S5  | Background work runs on queues with a sweep behind it, never in the request.                        | `sp4-plan.md`, `sp5-plan.md` |
| S6  | Dual coding is on the diagnosis; NAMASTE and ICD-11 both travel with it.                            | `sp2-plan.md`, `sp3-plan.md` |

---

## Definition of done

1. A clinician orders a test or an image; the order appears on the lab's or the radiology desk's worklist, moves through collected and in progress, and closes when the result is recorded against it.
2. A result recorded without an order still stands on its own, and an order with no result is visible as outstanding.
3. A patient is admitted to a named bed, transferred once, and discharged; the bed history reads correctly and the bed is free afterwards.
4. A surgery is recorded with its pre-operative assessment, operative note, implants and post-operative course, and the operative note is readable as a document.
5. The discharge summary is composed from the encounter's own data, edited, signed by a clinician, and appears in the patient's portal as a document.
6. Charges are captured from orders, procedures and bed-days against the hospital's price list; an itemised invoice is issued with a gapless number.
7. A part-payment, a further payment and a refund are recorded; the outstanding-dues report agrees with the ledger to the paisa.
8. Footfall, diagnosis distribution, prescription patterns, revenue and data quality report correctly for a period, and no report can be made to show another hospital's numbers.
9. The Ayush morbidity return is generated from coded diagnoses for a period, reviewed, and kept as submitted.
10. The acceptance scenario below passes end to end.

---

## Design sketch

```
service_request      id, patient_id, hospital_id, encounter_id, category(laboratory|imaging|procedure),
                     requested_code_system?, requested_code?, requested_display,
                     priority(routine|urgent), clinical_note?,
                     ordered_by_staff_id, ordered_at,
                     status(ordered|collected|in_progress|resulted|cancelled),
                     cancelled_reason?, versioning
observation          + service_request_id?          -- SP4 table, one nullable column
document_reference   + service_request_id?          -- SP4 table, one nullable column

ward                 id, hospital_id, name, kind(general|icu|private|day_care), status
bed                  id, hospital_id, ward_id, label, status(available|occupied|blocked)
bed_stay             id, hospital_id, encounter_id, bed_id, started_at, ended_at?, moved_reason?
                     -- a transfer ends one stay and starts the next; never two open for one encounter

procedure            + operative fields (Decision Q1): pre_op_assessment?, operative_note?,
                     post_op_course?, anaesthesia?           -- versioned as today
implant_device       id, hospital_id, procedure_id, name, manufacturer?, serial_or_lot?, implanted_at

discharge_summary    id, hospital_id, encounter_id, composed_at, composed_from(jsonb snapshot),
                     narrative, signed_by_staff_id?, signed_at?, document_reference_id?, versioning

service_catalogue_item  id, hospital_id, code, name, category, unit, price_paise, active_from, active_to?
charge               id, hospital_id, encounter_id, patient_id, item_id, quantity, unit_price_paise,
                     amount_paise, source(order|procedure|bed_day|manual), source_id?, captured_by_staff_id
invoice              id, hospital_id, encounter_id, patient_id, number, financial_year,
                     issued_at, issued_by_staff_id, total_paise, status(issued|settled|cancelled)
invoice_line         invoice_id, charge_id, description, quantity, unit_price_paise, amount_paise
payment_entry        id, hospital_id, invoice_id, kind(payment|refund|credit_note),
                     method(cash|upi|card|bank_transfer|scheme), amount_paise, reference?,
                     taken_by_staff_id, at            -- append-only; a mistake is another entry
insurance_detail     invoice_id, scheme(pmjay|private|none), insurer?, policy_or_card?, approved_paise?

daily_summary        hospital_id, ist_date, metric, dimension, value    -- written nightly, never edited
statutory_return     id, hospital_id, kind(ayush_morbidity), period_from, period_to, generated_at,
                     contents(jsonb), submitted_at?, submitted_by_staff_id?, document_reference_id?
```

Permissions: ordering is a clinician's; collecting and resulting belong to the lab or records staff; admission, transfer and discharge to the front desk and clinicians; the catalogue and prices to the hospital administrator; charge capture and payments to the front desk; reports to the hospital administrator, with the morbidity return submitted by them.

---

## Phases and tasks

### Phase 1 — Orders

- [x] **T1** `service_request` with row-level security, the status guard and audit (O1, DF1)
- [x] **T2** Order entry and cancellation, with permissions
- [x] **T3** Results linked to their order; an order closes when its results are in (DF2)
- [x] **T4** Worklists: what is outstanding, by category and age

**What an order turned out to be.** No version columns: asking for a test
asserts nothing about the patient, so there is nothing to correct — a wrong
order is cancelled with a reason and a new one placed. Instead of one
`status_changed_at` it carries a timestamp and a person per step, each set
once, which the guard trigger can enforce and which makes a turnaround-time
report arithmetic rather than archaeology. A typed result closes its order in
the same transaction that records it; an uploaded report closes it when the
scan comes back clean, so an upload that never arrives leaves the order
outstanding.

### Phase 2 — Orders in the clinical app

- [x] **T5** Ordering from an encounter, and the order's own screen
- [x] **T6** The lab and radiology worklist, and recording a result against an order

**Where orders show up.** An encounter has an Orders section that places them
and moves them along; a patient's reports tab lists every order for that
patient, waiting first; and `/orders` is the lab's and the radiology desk's
worklist — urgent first, oldest next, with how long each has waited. The
worklist links to where the answer is typed, carrying the order in the
address, so typing values or uploading a report closes the order that asked
for it.

### Phase 3 — Admission, ward and bed

- [x] **T7** Ward and bed master data, with the administrator's screens (P1)
- [x] **T8** Admission, transfer and discharge; the bed history and a ward view
- [~] **T9** Bed-day charges captured from the stay (feeds Phase 6)

**Who admits whom.** The decision to admit is clinical and was already a
record: an inpatient encounter, opened by the clinician who made it. Giving
the patient a bed is the other half, and the desk — who holds the board — does
that. The database has said since SP3 that only records staff open an
encounter in a clinician's name, and this keeps that rule rather than widening
it for the desk.

**Occupancy is not a column.** A bed says whether it is usable — available, or
out of service — and whether somebody is in it is read from the open stay. One
open stay per encounter and one per bed are partial unique indexes, so two
patients cannot be recorded in one bed however the application is called.

**T9 is half done.** A stay knows its bed-days — a started day counts as a
day, in India Standard Time, as every hospital bills it — and an admission
adds them up. Turning them into money needs the catalogue and its prices,
which is Phase 6; nothing here knows what a bed costs.

### Phase 4 — Surgery

- [x] **T10** The operative record: assessment, note, post-operative course (Q1)
- [x] **T11** Implants and devices, traceable by serial or lot

**The operative record is four more columns on the procedure**, not a table of
its own: pre-operative assessment, anaesthesia, the operative note and the
post-operative course. A therapy session leaves them empty; an operation fills
them, and they are corrected by superseding like everything else.

**A device hangs off the encounter, not the procedure row.** A procedure may be
corrected into a new version, and what was implanted is a fact about the
patient either way — so the device names the operation it came from as well as
pointing at it, and survives any correction to it. Serial, lot and model are
searchable across the hospital's own record, because a recall notice is
answered by each hospital for its own patients, and the superseded versions
stay in the history where a recall audit can still find the old number.

### Phase 5 — The discharge summary

- [x] **T12** Composition from the encounter's own data, and the editor (DF6)
- [x] **T13** Sign-off: the versioned note, the rendered document, and the portal (DF7)

**Composition copies; it never writes.** Each section is filled from what was
recorded — the stay and its bed-days, the diagnoses with their codes, the
operation and the devices, the results, the medicines — and the three only a
clinician can answer, how the patient was at discharge, the advice and the
follow-up, are left empty. The one place composition offers prose is the
course in hospital, and those are the surgeon's own words from the
post-operative course.

**A draft is not a record.** It is edited freely until it is signed; composing
again pulls in anything recorded since and leaves edited sections alone. The
signature is what makes it a record, and it writes two: a versioned clinical
note, which is what the hospital keeps and corrects, and a PDF, which is what
the patient reads in the portal and the next hospital opens. After that the
summary row never changes again — a trigger says so, not a convention.

**The PDF is marked clean without a scan.** The server rendered it from the
record a moment earlier and it never left the process; the scanner exists for
files people upload.

### Phase 6 — Charges

- [x] **T14** The service catalogue and its prices, with effective dates (R1)
- [x] **T15** Charge capture from orders, procedures, bed-days and by hand

**A price is never overwritten.** Repricing closes the row in force on the day
before the new price starts and opens another for the same code, so an invoice
raised last month still reads against the price that stood then. One price in
force per code at a time, which a partial unique index enforces.

**Nothing is charged automatically.** The record knows a test was ordered, an
operation performed, a bed occupied for three days; only the hospital knows
what those cost here. So the encounter shows what is chargeable and not yet
charged, and the desk chooses the catalogue item — at which point the price is
copied onto the charge, never looked up again.

**The arithmetic is the database's.** `amount = quantity × unit price` is a
check constraint, not a line of application code; a charge is voided rather
than edited; and one order, procedure or stay can be charged once, which a
partial unique index enforces too.

### Phase 7 — Invoices and money

- [x] **T16** Itemised invoices with gapless numbering per financial year (DF4)
- [x] **T17** Payments, part-payments, refunds and credit notes as ledger entries
- [x] **T18** Outstanding dues, insurance and scheme capture, and the receipt in the portal (DF5, DF8)

**The number has no gaps, and that cost a sequence.** A Postgres sequence does
not roll back, so a failed transaction would leave a hole — and a hole in an
invoice series is the first thing a tax officer asks about. Instead a row per
hospital and financial year is locked and incremented inside the same
transaction that writes the invoice, so the number and the invoice happen
together or not at all.

**There is no paid flag anywhere.** What is outstanding is arithmetic over the
ledger, worked out when somebody asks — so a status can never drift from what
was actually paid. The plan's sketch had a `status` column on the invoice;
this does without one, and says `unpaid`, `part paid`, `settled` or `overpaid`
from the ledger itself. For the same reason an invoice is never cancelled: a
mistake is a credit note, which is what an accountant expects anyway.

**The total is the database's arithmetic**, checked at commit against the sum
of the lines, and the ledger is append-only: no updates, no deletes, a refund
for money taken wrongly and a credit note for an amount written off.

**The PDF goes to the patient** as a document of type bill_or_receipt, which
is what the portal already shows them (DF8) — rendered by the server, marked
clean without a scan, as the discharge summary is. It prints `Rs` rather than
`₹`: the standard PDF fonts cannot encode the rupee sign, and shipping a font
to draw one character is not worth it.

### Phase 8 — Reporting

- [ ] **T19** Footfall, prescription patterns and revenue, by period and department (S1)
- [ ] **T20** Diagnosis distribution from coded data, and the nightly daily-summary job
- [ ] **T21** The Ayush morbidity return: generated, reviewed, submitted and kept (DF10)
- [ ] **T22** The data-quality report: unmapped diagnoses, unresulted orders, incomplete records

### Phase 9 — Verification

- [ ] **T23** Unit and integration: status transitions, bed history, money arithmetic, row-level security for every new table
- [ ] **T24** The acceptance scenario below
- [ ] **T25** Browser tests for the new clinical screens, and the portal's receipt and summary

---

## The acceptance scenario

Continuing the Amlapitta scenario, a year on.

1. At City General, a physician orders a liver panel for Lakshmi. It appears on the lab's worklist as outstanding.
2. The lab records the sample as collected, then types the values from the report. The order closes as resulted, and the values appear in her trend beside the older ones from Sanjeevani.
3. She is admitted for a day-care procedure, given a bed in the day-care ward, moved once to a general ward, and discharged two days later. The bed history shows both stays, and both beds are free afterwards.
4. The procedure is recorded with its operative note and the stent used, by serial number.
5. The discharge summary is composed from the encounter — her diagnoses, the procedure, the medicines she leaves on, the liver panel — edited by the physician, and signed. It appears in her portal that evening.
6. The desk raises an itemised invoice: the bed-days, the procedure, the panel and the stent, at the hospital's own prices. She pays half in cash and the rest by UPI a week later; a duplicate charge is corrected by a credit note.
7. The outstanding-dues report agrees with the ledger; the month's revenue summary includes her invoice once.
8. The month's Ayush morbidity return counts her Amlapitta under both its NAMASTE and its ICD-11 codes, is reviewed by the hospital administrator, and is kept exactly as submitted.

---

## Risks specific to SP6

| Risk                                                                        | Response                                                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money handled wrongly — rounding, double counting, an edited history        | Integer paise, totals derived from lines and checked against them, an append-only ledger, and arithmetic tested to the paisa (T23)                        |
| SP6 is the largest sub-project and the easiest to let sprawl                | Phases 1–2 (orders) and 6–7 (billing) are each deliverable on their own; bed management stays at P1 and surgery at Q1 unless a pilot asks otherwise       |
| The statutory return's real format is unknown                               | The generator is built against the ministry's published format before T21; the contents are kept as submitted so a format change does not rewrite history |
| An auto-composed summary that reads as though a machine diagnosed something | Composition assembles recorded facts only; a clinician edits and signs; nothing is a summary until signed (DF6)                                           |
| Reports slow as data grows                                                  | Daily counts written nightly and never recomputed; report queries measured against a seeded year, as the timeline was in SP3                              |
| Billing data leaking across hospitals through a report                      | Reports run under the hospital's own context; a test asserts a second hospital's figures are unreachable (DF5, DF9)                                       |

---

## Open items outside the code

- **The Ayush morbidity return**: the ministry's current format, reporting period and submission channel.
- **An accountant or counsel** on invoice numbering, GST treatment of services, consumables and pharmacy, and how long financial records must be kept.
- **The pilot hospital's price list**, and which schemes it bills against (PM-JAY, private insurers).
- **Ward and bed reality** at the pilot: how many wards, whether beds are named or numbered, and who moves a patient.

---

## Estimate

`planning.md` §14 gives SP6 **8–12 weeks** for one developer: orders about 2 weeks, inpatient and beds about 1.5 weeks, surgery about 1 week, the discharge summary about 1.5 weeks, charges and invoicing about 2.5 weeks, reporting about 2 weeks, and verification throughout. Q2 (a perioperative workflow), R2 (a payment gateway) or P2 (full bed management) would each add two weeks or more.
