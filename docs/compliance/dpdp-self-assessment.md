# DPDP Act 2023 — self-assessment

Where this system satisfies each obligation of the Digital Personal Data
Protection Act 2023, and where it does not (sp7-plan.md, T27, DF10).

**Assessed on 2026-09-28 by the developer, against the repository at that date.**
This is an engineer's reading of the Act, not advice, and **counsel has not yet
reviewed it**. Several rows below turn on questions only counsel can answer; the
open items at the end name them. Nothing here should be shown to a hospital as
a compliance statement until that has happened.

**Who is who.** Each hospital is a Data Fiduciary for its own patients' data.
Health24 is a Data Fiduciary for what it decides about — how the record is kept,
secured, shared and erased — and a Data Processor for a hospital where it acts
on that hospital's instructions. The data-processing agreement settles which is
which in each case, and it is not written yet.

| Verdict | Meaning |
| --- | --- |
| **Satisfied** | The system does this, and something proves it |
| **Partly** | It does most of it; what is missing is named |
| **Open** | It does not, or the answer is not ours to give |

---

## Notice and consent (§§5–7)

| Obligation | Verdict | Where |
| --- | --- | --- |
| Notice before or with consent: what, why, how to withdraw, how to complain | **Open** | The portal has no notice screen. The text is counsel's, the screen is ours. |
| Consent free, specific, informed, unconditional, unambiguous, with clear affirmative action | **Satisfied** for sharing between hospitals | A consent artefact names the categories, the hospitals and the dates; it is recorded with how it was captured — in person, signed form, or by the patient in the portal (`sp5-plan.md`) |
| Consent withdrawn as easily as given | **Satisfied** | The portal revokes in one action, and revocation takes effect on the next query because the policy reads it, not a cached flag (`portal-consent` suite) |
| Consequences of withdrawal borne by the principal, not concealed | **Partly** | The portal says what stops being shared; the wording is counsel's to approve |
| A Consent Manager, registered with the Board | **Open** | ABDM's consent manager is the likely route, and it is SP8. Until then consent is recorded by the hospital and by the patient directly |
| Processing without consent for "legitimate uses" (§7) — including a medical emergency | **Satisfied** | Emergency access exists, is refused without a stated reason, is limited in scope and time, notifies the patient, and is reviewed by the hospital's administrator (`sp5-plan.md`) |

---

## What a Fiduciary must do (§8)

| Obligation | Verdict | Where |
| --- | --- | --- |
| Remain accountable even where a Processor is used | **Open** | Needs the processing agreement with each hospital, and one with each sub-processor — AWS and the SMS provider |
| Process only for the purpose consented to | **Satisfied by design** | The record is read under a hospital or patient context; a report counts what that context can see and no more (DF9) |
| Completeness, accuracy and consistency where data is used to decide about a person or shared | **Satisfied** | Corrections are versions, never overwrites; a correction the patient asks for is recorded, answered and auditable (`sp3-plan.md` S3, `corrections` suite) |
| Reasonable security safeguards | **Satisfied** | Row-level security in the database, mandatory second factor, encryption at rest and in transit, scanned uploads, headers, rate limits — `threat-model.md`, `security-review.md`, `hardening.md` |
| Notify the Board and each affected principal of a breach | **Partly** | `runbooks/breach-notification.md` exists and is walked through; the Board's channel and the exact timeline are counsel's to confirm |
| Erase on withdrawal, or when the purpose is served, unless law requires keeping | **Partly** | The erasure workflow exists, records what was erased and what law requires kept, and is refused where it must be (`sp5-plan.md`, Decision N1). The retention periods themselves are unconfirmed — `retention-and-erasure.md` |
| Publish a Data Protection Officer or contact | **Open** | No published contact. A name and an address on the portal, once there is one |
| A grievance redressal mechanism | **Partly** | A patient can ask for a correction and for erasure, and see who read their record. There is no general complaint route with a named responder |

---

## The rights of a patient (§§11–14)

| Right | Verdict | Where |
| --- | --- | --- |
| Access: a summary of data and of processing, and who it was shared with | **Satisfied** | The portal shows the record, and **who read it, when and under what authority** — including emergency access. A machine-readable copy can be requested and is built by the worker (`sp5-plan.md`) |
| Correction, completion, updating and erasure | **Satisfied** | Both routes exist: a correction request to the hospital, and an erasure request reviewed against what must be kept |
| Grievance redressal | **Partly** | As above: the specific routes exist, a general one does not |
| Nomination — someone to exercise the rights on the principal's death or incapacity | **Open** | Not built. The guardian mechanism for children is the nearest thing and is not the same |
| A child's data: verifiable parental consent; no tracking or behavioural advertising | **Partly** | A guardian holds a child's portal access and it hands over automatically at the age set in policy (`guardian-handover.timer.ts`). There is no tracking or advertising anywhere in the system, and never will be. "Verifiable" parental consent is the open part: today a hospital verifies the guardian in person |

---

## Cross-border, and the rest

| Obligation | Verdict | Where |
| --- | --- | --- |
| Transfer outside India only where permitted (§16) | **Satisfied** | Nothing leaves India: `ap-south-1` is a validation rule on the region variable, production refuses to start with storage anywhere else, and no third-party service receives patient data — error reporting is off by default and scrubbed when on |
| Significant Data Fiduciary duties (§10): a DPO in India, independent audit, impact assessment | **Open** | Whether Health24 is designated one depends on volume and sensitivity. Health data at scale makes it likely. Counsel advises; a DPIA and an audit are then required |
| Security of processing by a Processor | **Partly** | The controls are in place; the contractual half is not written |
| Retention limits | **Partly** | See `retention-and-erasure.md`: the mechanics exist, the periods are unconfirmed |

---

## The gaps, with owners

| # | Gap | Owner | Before |
| --- | --- | --- | --- |
| 1 | Notice and consent text, and the screen that shows it | Counsel drafts, developer builds | First real patient record |
| 2 | Data-processing agreement with each hospital, and with sub-processors | Counsel | First pilot |
| 3 | Breach timelines and the Board's filing channel confirmed | Counsel | First real patient record |
| 4 | Retention periods per category, confirmed against medical-records law | Counsel, with a hospital's records officer | First real patient record |
| 5 | A published grievance contact, and a route to reach them | Founder | First real patient record |
| 6 | Whether Health24 is a Significant Data Fiduciary; if so, DPO, DPIA and audit | Counsel | Before scale, and before ABDM |
| 7 | Nomination (§14) | Developer, after counsel says what is required | Before scale |
| 8 | Verifiable parental consent beyond in-person verification | Counsel, then developer | Before scale |
| 9 | Consent Manager registration, or ABDM's | Founder and counsel | SP8 |

**None of the nine is a code gap that can be closed by writing code first.** That
is the honest summary of this page: the engineering side of the Act is in good
order, and the legal side has not started.
