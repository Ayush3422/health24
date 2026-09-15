# SP4 — Documents and Results: Implementation Plan

**Status:** Approved for building. Decisions E–H answered 2026-09-14: **E1, F1, G1, H1**. No SP4 code has been written.
**Scope:** Report and document upload, storage, scanning and viewing; bulk import of legacy paper files; LOINC-coded lab results with reference ranges, abnormal flags and cross-hospital trend graphs; documents and results on the timeline, the summary card, consent and the audit trail.
**Design reference:** `planning.md` §6.3, §8, §9, §11, §13 · `features.md` SP4 · `sp3-plan.md`

---

## 0. Decisions for you

**Answered 2026-09-14: E1, F1, G1, H1** — batch upload then classify; bills as a document type now; a separate `documents` consent category; the front desk uploads while clinicians and records staff read. The options considered are kept below for the record.

### Decision E — Legacy paper files: how much of the import is in SP4?

A hospital's existing archive is paper: one folder per patient, often a hundred pages or more, mixing reports, prescriptions, bills and discharge summaries. `features.md` calls bulk import "the feature that actually gets a hospital's existing archive into the system".

| Option                                              | What it means                                                                                                                                                                                                                                                                                                                                                    | Trade-off                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **E1. Batch upload, then classify** _(recommended)_ | Records staff scan a whole folder into an import batch for the patient. A classification screen then groups pages into documents and labels each — type, report date, facility, doctor. A doctor without an account is entered by name and marked external (the question `sp3-plan.md` deferred to here). Results are typed from the classified reports. No OCR. | The archive becomes searchable, filterable and shareable document by document. Classification is manual work per folder.      |
| E2. Upload as one unclassified file                 | Each folder becomes a single "legacy file" document.                                                                                                                                                                                                                                                                                                             | Quick to import. A 200-page file cannot be searched, filtered or shared in part, and a clinician must page through all of it. |
| E3. Leave legacy import for later                   | SP4 handles new reports only.                                                                                                                                                                                                                                                                                                                                    | Smaller SP4. Hospitals start with an empty history, which is the main reason they would not adopt.                            |

### Decision F — Bills and receipts

When you described the intended flow, the hospital file included bills. Billing as data — amounts, packages, payments — belongs to SP6.

| Option                                                          | What it means                                                                                                                                     | Trade-off                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **F1. A document type now, billing data later** _(recommended)_ | `bill_or_receipt` is a document type: stored, viewable and filterable like any other document. No amounts, no totals, no billing logic until SP6. | The paper file can be digitised whole, including bills, from day one.        |
| F2. Leave bills out until SP6                                   | Bills are not uploaded.                                                                                                                           | The digitised file is incomplete; records staff must keep a paper remainder. |

### Decision G — Sharing documents with another hospital

Consent today is granted per category: visits, diagnoses, medicines, allergies, vitals and observations, notes, procedures. Documents need a place in that list.

| Option                                                  | What it means                                                                                                                            | Trade-off                                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G1. A separate `documents` category** _(recommended)_ | Scanned files are shared only when the patient agrees to share documents. Typed lab results stay under `observations`, alongside vitals. | A patient can share their lab values without sharing scans — which often carry more than intended: another patient's page, an address, a note in the margin. One more checkbox at the desk. |
| G2. Documents follow what they contain                  | A lab report is shared with `observations`, a discharge summary with `notes`, and so on.                                                 | Finer-grained, but it trusts the document type to describe everything on a scanned page, which it often does not.                                                                           |

### Decision H — Who may open reports

`planning.md` §8 says the front desk registers and uploads but does not read clinical records. Reports are clinical records.

| Option                                                                        | What it means                                                                                                                                                                                                | Trade-off                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **H1. Front desk uploads; clinicians and records staff read** _(recommended)_ | The front desk can upload, see the list of what was uploaded (type, date, status) and type results from the report in front of them. Opening a report, and seeing results and trends, needs `clinical:read`. | Keeps §8 intact. A front-desk typing mistake is caught by records staff or the clinician, not by the typist re-opening the report. |
| H2. Front desk reads its own hospital's reports                               | The front desk opens any report of its hospital.                                                                                                                                                             | Simpler for small clinics where one person does everything. Front-desk staff read clinical content — the boundary §8 draws.        |

---

## Defaults taken

Technical choices with a clear best answer. Each is reversible; say if you disagree.

| #   | Default                                                                                                                                                                                                                                    | Why                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DF1 | **The S3 API everywhere.** An S3-compatible server in Docker Compose locally (the Versity S3 Gateway, since MinIO stopped publishing images), AWS S3 in Mumbai (`ap-south-1`) in production.                                               | One code path. Presigned uploads and the rule that files never pass through the API can be tested locally. A local-disk adapter would leave both untested until AWS.      |
| DF2 | **Asynchronous virus scanning.** ClamAV in its own container, a BullMQ job on the existing Redis. A document is not viewable until its files scan clean; an infected file is quarantined and never served.                                 | Required by `planning.md` §9. Scanning inside the upload request would force files through the API.                                                                       |
| DF3 | **Reference ranges come from the report.** Each result stores the range printed by the lab, prefilled from a panel default and editable. The abnormal flag is computed against the stored range; the lab's own flag is recorded beside it. | Ranges differ by laboratory, method, age and sex; a single Health24 range would mis-flag some patients. Panel defaults need the clinical reviewer (`planning.md` §15 Q3). |
| DF4 | **Files:** PDF, JPEG and PNG, up to 25 MB each. HEIC is refused with a message.                                                                                                                                                            | Browsers display these natively. A phone camera capture from the browser produces JPEG.                                                                                   |
| DF5 | **Thumbnails** for images, generated by the worker. PDFs show a type icon and page count in lists, and render in the browser viewer.                                                                                                       | Server-side PDF rendering needs a heavy native dependency for little gain in v1.                                                                                          |
| DF6 | **Documents are never deleted.** A wrong upload is marked entered in error — hidden from lists and the timeline, file retained. Metadata corrections are new versions.                                                                     | The pattern from SP3. Erasure requests under the DPDP Act are a patient-portal question for SP5.                                                                          |
| DF7 | **Lab results are attributed to whoever typed them**, with the ordering clinician recorded as a reference (an account, or an external name) — not as the clinician whose decision the entry is. Vitals keep their SP3 attribution.         | A lab value is a fact transcribed from a report, not a clinical decision, and front-desk staff may type it (H1).                                                          |

---

## Decisions already made

| #   | Decision                                                                                                                                                                                             | Source                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| S1  | Reports are stored as files **and** key results as LOINC-coded observations.                                                                                                                         | `planning.md` D7                              |
| S2  | Object storage in India, encrypted at rest, versioned, no public objects. Access only through short-lived presigned URLs issued after a permission and consent check, and every issuance is audited. | `planning.md` §9, §13                         |
| S3  | Files never transit the API server: the browser uploads straight to storage.                                                                                                                         | `planning.md` §9                              |
| S4  | Results are typed against a curated panel: CBC, LFT, KFT, lipid profile, HbA1c, TSH, fasting and post-prandial glucose.                                                                              | `planning.md` §9                              |
| S5  | OCR and machine extraction are deferred. `observation.source` exists from day one so extracted values can later be told apart and reviewed.                                                          | `planning.md` §9, `features.md` excluded list |
| S6  | Clinical records are never edited or deleted; corrections are new versions.                                                                                                                          | `sp3-plan.md` S3                              |
| S7  | No clinical decision support. An abnormal flag is a comparison against the stated range, not an interpretation.                                                                                      | `features.md` excluded list                   |

---

## Definition of done

1. The front desk, records staff or a clinician uploads reports — drag and drop, several at once, or a phone camera — and the files go straight to storage. A document becomes viewable only once every file scans clean.
2. Every view and download is a presigned URL valid for about a minute, issued after the permission and consent check and audited with the consent it rested on. No public or long-lived link to a file exists.
3. Documents carry a type, report date, performing facility and ordering clinician, and can be searched and filtered by type, date and hospital.
4. Results are typed against the curated panel, attached to their report, with the lab's reference range and a computed abnormal flag; `source` is `entered`.
5. A trend graph per analyte spans every hospital and all time the caller may see, in one unit, with the reference range drawn and each point naming its hospital.
6. A legacy paper folder can be imported as a batch and classified into documents, including doctors who have no account (Decision E).
7. Documents and results appear on the timeline and the summary card; another hospital's appear only under consent (Decision G).
8. Documents and results can be marked entered in error, and document details corrected as new versions.
9. The authorisation suite covers every new route; row-level security is proven for documents and results with and without consent; a test proves an object cannot be fetched without a valid URL; the Amlapitta scenario is extended with results, a trend and a report.

---

## Design

### Data model

Tenant-scoped under row-level security, following SP3:

```
document_reference   id, patient_id, hospital_id, encounter_id?,
                     doc_type, title?, report_date, performing_facility?,
                     ordering_clinician_id? | ordering_clinician_name?,
                     status(pending_scan|available|quarantined|abandoned),
                     import_batch_id?, recorded_by, entry_source,
                     version_status, supersedes_id, recorded_at
document_file        id, document_id, position, storage_key, mime,
                     size_bytes, sha256, scan_status(pending|clean|infected),
                     scanned_at?, page_count?, thumbnail_key?
import_batch         id, patient_id, hospital_id, opened_by, status
                     (open|classifying|done), note?, created_at
observation          + source(entered|extracted), document_id?,
                     reference_low?, reference_high?, reference_text?,
                     interpretation(normal|low|high|abnormal)?, lab_flag?,
                     value_canonical?, unit_canonical?
```

Document types, following `features.md` and Decision F: lab report, radiology, discharge summary, prescription, operative note, referral, bill or receipt, other.

A document has one or more files, in order: a phone capture of a three-page report is one document with three files. A lab panel is one observation per analyte sharing a `group_id`, as vitals already do, linked to its report by `document_id`.

**Storage keys carry no personal data:** `hospitals/{hospital}/patients/{patient}/documents/{document}/{file}`. In production the bucket has versioning, default encryption under a KMS key, all public access blocked, and a policy refusing non-TLS requests. Browser uploads are allowed by CORS from the application's origin only.

### Upload

1. `POST /documents` with the patient, type, date and the files' names, types and sizes. The server checks the permission, the patient link, each type and size, and returns a presigned `PUT` per file, valid for five minutes and bound to its content type and length.
2. The browser uploads each file directly to storage.
3. `POST /documents/:id/complete`. The server checks each object exists with the declared size and checksum, then queues the scan.
4. The worker scans each file with ClamAV. Clean: marked clean, thumbnail and page count recorded; when every file is clean the document becomes `available`. Infected: the object moves to a quarantine prefix, the document is `quarantined`, the uploader sees why, and the event is audited.

An upload never completed within a day is marked `abandoned` and its objects removed by a job. Having never become part of the record, it is not subject to the never-delete rule.

### Viewing

`GET /documents/:id/files/:fileId/url?disposition=inline|attachment` checks the document is visible to the caller — its own hospital's, or covered by consent — and returns a presigned `GET` valid for about a minute. Each issuance is an audit row naming the document, the file and any consent. The viewer uses PDF.js for PDFs and the browser for images, with zoom. Responses carrying URLs are `no-store`, and no file ever enters the offline cache.

### Results

The entry form starts from a panel: the rows arrive with LOINC code, name, the panel's default unit and range, and plausibility bounds that reject typing errors, as vitals do. The person typing sets the specimen date, the lab, and attaches the report when there is one.

Units are converted only where the panel defines an explicit factor (glucose in mg/dL and mmol/L, for instance). The value is stored as entered and, where a factor exists, in the panel's canonical unit for trends. A value in a unit with no factor is kept, shown, and left off the graph rather than guessed at.

The panel definitions live in the shared package, as vital signs do. Their LOINC codes and default ranges must be verified against a licensed LOINC release and by the clinical reviewer before production, and carry LOINC's attribution.

### Trends

`GET /patients/:id/results/trends?code=` returns every point for one analyte the caller may see, across hospitals, in the canonical unit. The clinical app draws it as a line over time with the reference band, each point marked by hospital and abnormal points highlighted, with the same data as a table beneath for accessibility.

### Consent, row-level security and audit

- **Decision G1:** `documents` joins the consent categories. Row-level security on `document_reference` and `document_file` admits the hospital's own rows and rows covered by consent for `documents` on the report date. Emergency access includes the new category automatically.
- Lab results are observations and follow the existing `observations` policy.
- Storage is reachable only through presigned URLs, and issuing one is audited. In production, S3 server access logs are kept alongside.
- The timeline gains `document` and `result` entries; the summary card gains recent abnormal results. The timeline performance test is re-run with documents and results in the synthetic volume.
- The offline cache keeps its SP3 scope: the summary card, now with recent abnormal results. Documents are never cached.

### Legacy import (Decision E1)

Records staff open an import batch for a patient and upload the scanned folder: many images or PDFs at once, each scanned like any other file. The classification screen shows the pages as thumbnails; staff select pages, create a document from them — type, date, facility, doctor — and move on. A page that is not part of this patient's record, such as a blank page or someone else's report, is excluded with a reason and kept, not deleted. The batch is done when every page is assigned or excluded. Results are then typed from the classified reports.

### Infrastructure

- Docker Compose gains MinIO and ClamAV. The API gains a worker entry point running BullMQ jobs: scan, thumbnail, page count, abandoned-upload cleanup.
- New configuration: storage endpoint, region, bucket and credentials. Startup refuses a production configuration outside `ap-south-1`, as it already refuses demo terminology.
- The content security policy allows the storage origin for images, frames and uploads.
- Likely dependencies: the AWS S3 client and presigner, BullMQ, sharp, pdf-lib for page counts, a clamd client, and PDF.js in the clinical app.

---

## Task breakdown

### Phase 1 — Storage and scanning

- [x] **T1** MinIO and ClamAV in Docker Compose; storage module: presigned upload and download, object checks, quarantine move — MinIO no longer publishes images, so the local S3-compatible server is the Versity S3 Gateway (`versity/versitygw:v1.8.0`), which checks signatures as S3 does; ClamAV 1.4. `StorageService` signs the content type and exact length into upload URLs, issues one-minute `no-store` download URLs, and refuses any key not built from identifiers alone. Production refuses storage outside `ap-south-1` or over plain HTTP. `pnpm storage:bootstrap` creates the local bucket
- [x] **T2** BullMQ worker entry point and the scan job — a clamd INSTREAM client of our own (a scanner error is never a clean verdict), a lazily opened scan queue with retries, and a processor that quarantines infected files. The worker is its own process (`pnpm --filter @health24/api worker`), built by Nest rather than tsx, which does not emit the decorator metadata dependency injection needs; BullMQ needs `ioredis` installed alongside it. Recording verdicts against documents follows with the model in Phase 3
- [x] **T3** Storage tests: no object reachable without a URL, URLs expire, a wrong content type or length is refused, the EICAR test file is quarantined — `storage.e2e-spec.ts` (8) and `scanning.e2e-spec.ts` (4, directly and through the queue and a worker) against the real servers; unit specs for storage keys (3) and the clamd protocol against a stand-in server (6). CI starts Redis, the storage server and ClamAV

### Phase 2 — Document model

- [x] **T4** Migrations: `document_reference`, `document_file`, `import_batch`, the `documents` consent category, row-level security, consent, immutability triggers and grants — migrations 0021 and 0022. Documents are read by their own hospital or under consent for `documents` on the report date (through `app.consent_permits_category`, because a newly added enum value cannot be named in the migration that adds it); files are visible exactly when their document is; import batches are never shared. The database also refuses: an admin as uploader, an ordering clinician who is not a clinician or is given both by account and by name, a storage key not naming the row's own hospital and patient, file types other than PDF, JPEG and PNG, files over 25 MB, and any change beyond availability, scan results and version status
- [x] **T5** Permissions for uploading documents and entering results (Decision H); authorisation and row-level security suites — `documents:upload` and `results:enter` for the front desk, records staff and clinicians; reading reports stays behind `clinical:read`. `documents-rls.e2e-spec.ts` (18). No routes yet, so the authorisation suite gains its entries with the API in Phase 3. The consent screen offers the new category

### Phase 3 — Documents API

- [x] **T6** Upload, completion and the scan pipeline end to end — `POST /documents` records the document and returns one presigned upload per file (file names are never stored); `POST /documents/:id/complete` checks each object's size and type and queues the scans. The worker scans under the hospital named in the storage key, stores the checksum of the stored bytes, and makes a document available when every file is clean or quarantined as soon as one is infected, locking the document row while it decides. Uploads never confirmed within a day are abandoned and their objects removed, hourly (migrations 0023 and 0024). Thumbnails and page counts move to Phase 5, where the screens use them
- [x] **T7** View and download URLs, audited with their consent — one-minute links for roles that read clinical records, audited as a read or, for a download, an export, with the consent they rested on. The front desk is refused (Decision H1); a document still being scanned or quarantined is refused; one entered in error is not found
- [x] **T8** Listing, search and filters by type, date and hospital — `GET /patients/:id/documents` with types, report-date range and scope; the front desk sees its own hospital's uploads only
- [x] **T9** Corrections: details as new versions, entered in error — a correction supersedes the document with a new version carrying the same stored files and their scan results; only the holding hospital may change a document. `documents-api.e2e-spec.ts` (12) runs it all against the real storage server, ClamAV and a worker; the authorisation suite covers the seven new routes

### Phase 4 — Results API

- [x] **T10** Panel definitions in the shared package: LOINC codes, units and conversions, plausibility bounds, default ranges — marked for verification and clinical review — seven panels (CBC, LFT, KFT, lipid profile, HbA1c, TSH, fasting and post-prandial glucose) in `schemas/results.ts`, flagged `LAB_PANELS_REVIEWED = false`. Units convert only through explicit factors (µmol/L bilirubin, lakh/µL platelets, mmol/L glucose and more); the abnormal flag compares against the range on the report, falling back to the lab's own flag
- [x] **T11** Observation extension migration: source, document link, reference range, interpretation, canonical value — migrations 0025 and 0026: a `category` separates vital signs from laboratory results. A lab result carries no clinician attribution (DF7) and is typed directly by the front desk, records staff or a clinician; the database enforces both, keeps laboratory columns off vital signs, and ties a result to a report of the same patient and hospital. Vitals and the timeline now read vital signs only
- [x] **T12** Results entry with the abnormal flag; corrections — `POST /results`, `GET /patients/:id/results`; a mistyped set is withdrawn whole (`POST /results/:setId/entered-in-error`) and typed again, as vitals are
- [x] **T13** Trends endpoint across hospitals under consent — `GET /patients/:id/results/trends?code=`: every point in the canonical unit with its range converted alike, oldest first, each naming its hospital and audited with its consent. `results.e2e-spec.ts` (9) and `lab-panels.spec.ts` (8)

### Phase 5 — Screens

- [x] **T14** Upload: drag and drop, several files, phone camera, progress and scan status — one document from many files in a chosen order, checked for type and size before anything is sent; each file goes straight to storage with its progress shown, then the list polls until the scan settles. The front desk names an ordering doctor by name, since it cannot list clinicians. The worker now records a PDF's page count (pdf-lib) once its scan is clean; tested in `documents-api.e2e-spec.ts`. Local storage allows the clinical origin (CORS)
- [x] **T15** Documents list with filters, and the viewer for PDFs and images with zoom — filters by type, report date and hospital; the viewer shows a PDF in the browser's own viewer and an image with zoom steps, each file through a fresh one-minute link, with download as a separate audited link. Correct details and entered in error from the list. **Thumbnails dropped for v1** (DF5): every thumbnail shown would be its own audited read of the record, so lists show type, file count and page count instead
- [x] **T16** Results entry form by panel, attached to a report — panel, collection date and time (IST), laboratory, and the uploaded lab report it was typed from; per test the value, unit, the report's range (prefilled with typical values in the standard unit, cleared when another unit is chosen) and the lab's printed flag. The front desk sees what it has just recorded and nothing more; readers see every set with withdraw and trend
- [x] **T17** Trend graphs with the reference band and a table beside — SVG line in one validated blue with the reference range as a neutral band, hospital told by marker shape, out-of-range results by ▲/▼ as well as the flag word, a hover and keyboard readout, and a table of every value beneath

### Phase 6 — Legacy import (Decision E)

- [x] **T18** Import batch API — two tables under the batch (migrations 0027 and 0028): `import_file`, the folder's file as uploaded, kept as the original and scanned on the same queue; and `import_page`, one page cut from a clean file by the worker — one single-page PDF per PDF page (pdf-lib), one page per image, a PDF that cannot be split kept whole. A document made from pages copies each page inside storage to the document's own key, with its checksum, and is available at once; so a clinician is only ever shown the pages classified into a document, never the rest of the folder. A page is settled once — in a document of its own batch, or excluded with a reason — and the batch finishes only when every page is settled and no file is in progress; a finished batch takes nothing more. Import files and pages are never shared, not even under consent; the database refuses a page from an unscanned file, a page in another batch's document, both classified and excluded, any change once settled, and the hospital admin. New permission `documents:import` for records staff and clinicians: classifying means reading every page, so not the front desk. Unconfirmed import files are abandoned by the hourly job like document uploads. `imports-rls.e2e-spec.ts` (9), `imports-api.e2e-spec.ts` (10), and the authorisation suite covers the ten new routes
- [x] **T19** Classification screen: pages to documents, exclusions with a reason — an import section on the patient page and its own page per import: upload the folder in any number of goes (ordered by file name, names never sent), a grid of pages with their state, a preview through a one-minute audited link per page, select pages in document order, then make a document (type, report date, title, facility, ordering doctor) or exclude them with a reason; finish when every page is sorted. No thumbnails, as for documents (DF5)
- [x] **T20** External doctors named without an account — stored by name since Phase 3 (DF7); now, wherever a doctor is named — upload and classification — the name field offers the names this hospital has already written (`GET /external-clinicians`), so the same doctor is named alike across documents

### Phase 7 — The record

- [x] **T20b** The patient page as tabs (asked for on 2026-09-15, taken up at the start of this phase) — the patient's name, MRN and, for clinical roles, the allergy warning stay on top; beneath, a sticky navbar of eight tabs, each on its own address (`/patients/:id/:tab`): Overview (details, summary card, problems, medicines, allergies, vitals, starting an encounter), Doctors & treatment (every clinician who treated the patient, at this hospital and, under consent, others — with their diagnoses, medicines, procedures, notes and visits, grouped from the timeline), All reports (documents other than bills, and lab results), Bills (bill and receipt documents, Decision F1), Medicines (current, and prescription history), Visits & timeline, Paper imports, and Consent & sharing. A role sees only the tabs it may use: the front desk gets Overview, All reports, Bills and Consent. No API change
- [ ] **T21** Documents and results on the timeline; recent abnormal results on the summary card
- [ ] **T22** The documents category on the consent screen
- [ ] **T23** The timeline performance test with documents and results in the volume

### Phase 8 — Verification

- [ ] **T24** Unit: unit conversions, abnormal flags, panel definitions, storage keys free of personal data
- [ ] **T25** Integration: every new endpoint; row-level security with and without consent; audit of URL issuance
- [ ] **T26** The Amlapitta scenario extended (below), and a browser check of upload, viewer, results and trends

---

## The acceptance scenario, extended

Continuing `planning.md` §1 and the SP3 smoke test:

1. The patient brings an old LFT and an abdominal ultrasound report from a private laboratory. Sanjeevani's records staff upload both; the LFT values are typed against the panel and attached to the report.
2. At City General the gastroenterologist orders a fresh LFT; its values are typed there.
3. With consent covering observations and documents, the gastroenterologist sees one ALT trend across both hospitals, with each point naming its hospital, and opens the ultrasound report through a short-lived link that is audited.
4. With consent covering observations but not documents, the trend is visible and the reports are not.
5. With consent revoked, neither is visible, and the attempts are audited.

---

## Risks specific to SP4

| Risk                                                                             | Response                                                                                                                                |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A scanned page carries more than intended — another patient's report, an address | Classification step before sharing; a separate documents consent category (G1); pages excluded with a reason                            |
| Wrong abnormal flags from a range that does not fit the patient                  | The lab's printed range stored with each result (DF3); defaults reviewed clinically                                                     |
| Unit mix-ups such as mg/dL against mmol/L                                        | Explicit conversion factors only; a canonical unit for trends; plausibility bounds; unconvertible values kept off the graph             |
| A shared or leaked file link                                                     | URLs valid for about a minute, issued per view and audited; no long-lived links                                                         |
| Malware in uploads                                                               | Every file scanned; nothing served until clean; quarantine                                                                              |
| Storage growth from legacy archives                                              | Size limits; originals never recompressed (they are the legal record); older objects moved to a cheaper storage class by lifecycle rule |
| Unverified LOINC codes or default ranges reaching production                     | Panel definitions marked as unverified until checked against a licensed release and by the clinical reviewer                            |
| Solo-developer scope                                                             | Legacy import is its own phase and can follow the rest if time runs short                                                               |

---

## Open items outside the code

- **Clinical reviewer** (`planning.md` §15 Q3) for the panel definitions and default ranges.
- **LOINC** codes verified against a licensed release, with attribution.
- **Production storage**: the bucket, KMS key, access logging and lifecycle rules, set up as infrastructure.
- **Erasure under the DPDP Act** against never-delete records — for SP5, with counsel.

---

## Estimate

`planning.md` §14 gives SP4 **5–8 weeks** for one developer. Legacy import (Decision E1) accounts for about one of those weeks; storage and scanning infrastructure for about one more.
