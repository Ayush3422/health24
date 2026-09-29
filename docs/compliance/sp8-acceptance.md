# SP8 acceptance — walked

The nine steps of the acceptance scenario in `sp8-plan.md`, walked on
**2026-09-29**, with what actually happened (T35).

Eight of them are a test — `apps/api/test/sp8-acceptance.e2e-spec.ts` — which
runs the whole scenario in order against a real database and a mock gateway
speaking the real protocol. It is one long test rather than eight, because the
scenario is a sequence: nothing after step 2 is meaningful if step 2 did not
happen, and splitting it would let a later step pass against a state an
earlier one never produced.

The ninth is a question answered by a document, and two steps of the
sub-project's own task list could not be walked at all. Both are recorded here
as not done rather than marked complete.

---

## 1. Her ABHA is confirmed at the desk

**Done.** Front-desk enters `lakshmi.devi@abdm`, the gateway sends a code, she
reads it back, and the record says `verified: true` with the method and the
moment. The use of her identity is on her access history whether or not
anything came of it.

**One thing this produced.** The first run of the browser tests could not do
this at all: the patient they drive was registered at one hospital and is
being seen at another, and SP1's rule lets a hospital **write** only a patient
it created. That is right for demographics and wrong for an ABHA, which is
confirmed with the patient standing there by whichever hospital they walked
into. Migration 0076 adds a second way to satisfy that check, open only while
`app.record_abha_verification` is running. The old rule is untouched.

## 2. Her visit goes on to the network, and only once she confirms

**Done, including the negative half.** After the desk offers the visit and
before she answers the code, the test asserts there is **no** care context
row. It appears only after the confirmation.

## 3 and 4. The consent manager notifies a consent

**Done, and step 4 turned out to be wrong as written.**

The plan said a member of staff at the clinic "sees nothing different". What
they see is: their own consent list — *what this hospital may read of another
hospital's record* — is unchanged and empty, exactly as the plan intended. But
the clinic **can** see that a national requester was given something of its
records, on a screen that is about exactly that.

That is better than the plan's version, and it came out of the walk. A single
list holding both would say the opposite of the truth about half its rows, so
the clinical consent list is now scoped to consents granted **to** this
hospital, and `?source=abdm` asks for the other direction.

## 5. The records leave, and only what was agreed

**Done.** One push, for the one care context the consent named, carrying the
diagnoses and medicines of the six months it covered. The test asserts her
clinician's note is not in the push — and cannot be, because no health
information type grants notes and the assembly context would not return one.

## 6. Every row that left is on her trail

**Done.** Every resource in the bundle is in `access_log` against the consent
artefact, attributed to **"ABDM requester Shanti Allopathic (HIU)"** rather
than to "the system". Her notes are on nobody's trail as having left, because
they did not.

**This step found a real gap.** The portal's access history reported a system
actor with no name at all, so a transfer to a national requester arrived on
her screen as an anonymous event. The label was already in the audit row and
was being dropped on the way out. A requester now names itself; a scheduled
job of ours still does not.

## 7. She revokes it, and the next request is refused

**Done, three ways.** The consent manager's revocation marks the artefact
revoked; a second data request on it is refused at the door with nothing
written that suggests a transfer is coming; and the assembly context, asked
directly on an unprivileged connection, returns no rows at all.

## 8. A FHIR client reads the same record

**Done.** `/fhir/R4/metadata` answers without a token; `Condition?patient=…`
answers with her diagnoses under a clinician's token; and the same request
without a token is refused. The surface adds a representation, not an access
path.

## 9. A hospital asks whether this is ABDM-certified

**Answered, and the answer is no.**
[`abdm-certification.md`](abdm-certification.md) says so in its first
paragraph, lists every capability as **built** and nothing as sandbox-tested
or certified, and names six known gaps that would fail an assessment —
starting with `Composition.author`, which FHIR requires and this system does
not write.

---

## The two steps that could not be walked

### T38 — reconcile the mock against the sandbox

**Not done, and it cannot be from here.** There are no sandbox credentials
(Decision Z1), so nothing in this sub-project has met ABDM. What exists
instead is a mock gateway that behaves like the real one in the ways that
matter — it hands out sessions, refuses a call without one, answers 202 and
calls back on its own connection, and can be told to answer with an error or
not to answer at all.

What that cannot prove is that ABDM behaves as documented. The parameters most
likely to be wrong are named in
[`abdm-certification.md`](abdm-certification.md) and each lives in one module.

### T39 — the first real `terraform plan`

**Not done, carried from SP7 and carried again.** There is still no AWS
account (SP7, Decision V1). What passes is `terraform fmt -check`,
`terraform init -backend=false` and `terraform validate`, in CI on every push,
exactly as it did at the end of SP7.

Recording it as still open for a second sub-project running is uncomfortable,
and that is the point of recording it.

---

## What the walk changed

| Step | Change |
| --- | --- |
| 1 | Migration 0076: the hospital a patient walked into may confirm their ABHA, not only the one that registered them |
| 4 | The clinical consent list is scoped to consents granted **to** this hospital; what was given to a national requester is its own list |
| 6 | A system actor in the access history names itself, so a requester is not reported as "the system" |

Seven of the nine steps were already true when the walk began. Two were not,
and both were found by walking rather than by reading.
