# Penetration test — scope

What an external tester is given, what they are asked to break, and what
"passed" would mean (sp7-plan.md, T25).

Written before anybody is engaged, so that the scope is a decision rather than a
negotiation with whoever is holding the invoice. **This test happens before the
first real patient record exists** — not before a demo, not before a pilot
agreement, but before real data.

## Why this exists

`security-review.md` is the developer looking adversarially at their own code.
It finds what somebody who knows where things are can find. It cannot find what
they cannot imagine, and it cannot be evidence to a hospital's counsel that
anybody independent has looked.

## What is in scope

| Surface | Reachable at | What to try |
| --- | --- | --- |
| The API | `https://api.<env>.health24.example` | Everything below |
| The clinical app | `https://clinical.<env>.…` | A signed-in clinician's browser, and one that is not signed in |
| The patient portal | `https://portal.<env>.…` | A patient's phone, and somebody else's |
| Object storage | Presigned URLs the apps hand out | The URLs themselves, their expiry and their bindings |
| The emergency card | `https://portal.<env>.…/emergency/<token>` | A stranger holding a card, and one holding a revoked card |

**The environment is staging, with synthetic data.** It is configured exactly as
production — the same images, the same policies, the same row-level security —
and holds no real patient record (DF1). A finding in staging is a finding in
production.

## What is out of scope

- **Production.** Nothing is tested against real records, ever.
- **Denial of service and volumetric attacks.** Rate limits may be probed; the
  cloud's own protections are not the subject.
- **Physical security, social engineering of hospital staff, and the hospital's
  own network.** Real risks, somebody else's test.
- **Third-party services** — AWS, the SMS provider — beyond how this system uses
  them.

## What the tester is given

Deliberately generous, because a black-box test of a system with mandatory
two-factor authentication mostly tests the sign-in page.

1. **The threat model and this scope.** Both, up front. Time spent
   rediscovering what is written down is time not spent on what is not.
2. **Four accounts**, each with its password and second factor: a clinician, a
   front-desk clerk, a hospital administrator, and a patient — at *two*
   hospitals, so that crossing between them can be attempted from the inside.
3. **Read access to the source**, on request. A grey-box test finds more per
   hour, and an attacker with a former employee has the source anyway.
4. **A contact who answers within the working day**, so a blocked tester does
   not spend a day blocked.

They are **not** given AWS credentials, the database, or any production access.

## What to try, in order of what would hurt most

1. **Read another hospital's record.** As a signed-in clinician at hospital A,
   reach anything belonging to hospital B — through an id, a search, a report, a
   bill, an export, a presigned URL, a timeline, a merge candidate. This is the
   one that must not be possible; everything else is a lesser finding.
2. **Read a record without consent.** Cross-hospital access is supposed to
   require a consent artefact that is in force, in date and covering the
   category. Find a path that skips any of those three.
3. **Be somebody else.** Forge or replay a token, reuse a refresh token, keep a
   revoked session alive, pass another patient's id into a portal route, use a
   staff token on a patient route or the reverse.
4. **Get in without a second factor.** Any path from a password alone to a
   session.
5. **Change the record without leaving a trace**, or make an audit write fail
   while a read succeeds.
6. **Get something executable in front of a clinician** — through an upload,
   a document, a display name, an imported report.
7. **Make the system say something it should not**: an error, a log, a metric or
   a header carrying a name, an MRN, a phone number or clinical text.
8. **Escalate a role.** Front desk into clinician, clinician into administrator,
   hospital administrator into platform administrator — or any of them into the
   patient's own view.
9. **Anything the threat model says is handled.** Those claims are the most
   worth testing, because they are the ones that have stopped being questioned.

## What "passed" means

**Not "no findings".** A test with no findings usually means the scope was too
narrow or the tester too polite.

Passed is:

- **No critical or high finding open.** A critical is anything in categories 1–4
  above: cross-tenant access, consent bypass, authentication bypass, or
  impersonation. These are fixed and retested before the report is closed —
  not accepted, not scheduled.
- **Every medium and low finding either fixed or written into
  `accepted-risks.md`** with a reason and a revisit date, signed off by name.
- **A retest** of everything fixed, by the same tester.
- **The report kept**, because a hospital's counsel and an ABDM assessor will
  both ask for it.

## Before engaging anybody

- Confirm the tester may work against systems in India and understands that the
  data is synthetic but the system is a health record system.
- Agree rules of engagement in writing: hours, rate limits, what they do if they
  find real personal data (stop, report, delete), and who they call.
- Snapshot staging beforehand, and be ready to rebuild it from Terraform —
  a test that leaves the environment broken should cost an afternoon, not a week.
- Tell the SMS provider. A test will send codes.
