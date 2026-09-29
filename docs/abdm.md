# ABDM

How this system reaches the Ayushman Bharat Digital Mission, what is built,
and — as carefully as the rest — what is not (sp8-plan.md, DF11).

**This page grows with the sub-project.** Today it covers ABHA identity, the
transport underneath it, care contexts — which visits are offered to the
national network and how — the consents that arrive over it, and the transfers
they authorise. The `/fhir/R4` read surface is Phase 6, and is described here
when it exists, not before.

---

## What is built

| | Status |
| --- | --- |
| Confirming a patient's ABHA against the registry | **Built** (Phase 1) |
| The gateway transport: sessions, correlation, callbacks | **Built** (Phase 2) |
| Care-context discovery and linking | **Built** (Phase 3) |
| Consent notification from the consent manager | **Built** (Phase 4) |
| Assembling and pushing health information | **Built** (Phase 5) |
| A `/fhir/R4` read surface | **Built** (Phase 6). See [fhir.md](fhir.md) |
| **Certified by ABDM** | **No.** Nothing here has been assessed by anybody but this repository's own tests |

The last row is the one a hospital is most likely to repeat to a regulator, so
it is stated first rather than buried: this system is being **built toward**
ABDM's HIP requirements. It has not been certified, it is not registered
against a real facility, and no part of it has run against ABDM's sandbox.
Reconciling what is written here with what the sandbox actually does is a task
in Phase 8, and it is expected to find differences.

---

## The three modes

`ABDM_MODE` decides everything, and the difference between the three is worth
understanding before a deployment is configured.

| Mode | What it is | Where it belongs |
| --- | --- | --- |
| `off` | Every ABDM operation is refused with a message naming the setting | A deployment that is not part of the network. The default in production |
| `mock` | An in-process stand-in. No network, no credential, and it accepts the published code `000000` | A developer's machine. **Refused in production** |
| `gateway` | The wire adapter, pointed at `ABDM_GATEWAY_URL` | A real deployment — and the test suite, pointed at the mock gateway server |

Unset means `mock` outside production and `off` inside it. A deployment never
silently believes it has a gateway.

The settings `gateway` requires are in
[configuration.md](configuration.md), and the schema refuses to start if any of
them is missing, naming the ones that are.

---

## How a call actually works

This is the part that makes the adapter more than a wrapper around `fetch`,
and the reason it is worth reading before changing anything in
`src/modules/abdm/gateway/`.

1. A **session token** is fetched from the gateway and cached, renewed a
   minute before it lapses, and fetched by one caller at a time. A call that
   is answered 401 throws the token away and retries **once** — no other
   failure is retried, because the gateway may already be acting on the first
   attempt.
2. The call is given a **request id**, and the wait for its answer is
   registered *before* the request is sent. A gateway fast enough to call back
   while we are still reading its 202 is not a race this should lose.
3. The gateway answers **202 and nothing useful**.
4. The real answer arrives later as a **separate inbound request** to
   `POST /api/v1/abdm/callbacks/:operation`, quoting our request id in
   `resp.requestId`.
5. That resolves the waiting call. If no callback arrives within
   `ABDM_CALL_TIMEOUT_MS`, the caller is told the registry did not answer —
   and told plainly that nothing was recorded.

**One consequence for how this is deployed.** The pending call lives in memory
in the process that made it, so the callback has to reach **that** process. A
deployment that runs several API tasks behind a load balancer needs the
callback routed to the right one, or a single task serving the callback path.
Persisting pending calls was considered and rejected: after a restart the
caller is gone, and resuming the wait would only create the illusion that a
dropped call could be recovered.

---

## Care contexts: which visits are on the network

A **care context** is ABDM's unit of sharing — the thing a patient sees in
their health app and chooses to share. Here it is **one encounter**, because
that is what a patient recognises ("the visit on the twelfth of April") and
what they can sensibly decide about one at a time. A per-hospital or per-year
grouping would be easier to produce and impossible to consent to meaningfully.

**A care context's display text carries nothing clinical.** It is shown in the
consent manager's app, it travels with every consent request, and it sits in
lists somebody may glance at. So it says the date, the kind of visit and the
hospital — never the complaint, the diagnosis or the clinician. There is a
test whose only job is to keep it that way.

**Nothing is linked until the patient answers a code**, in both directions:

| | Who sends the code | Why |
| --- | --- | --- |
| The desk offers | The gateway | A member of staff is present, and ABDM's flow puts the challenge at the consent manager |
| The patient asks, from their own app | **This system** | Nobody is present, and nothing else proves the person holding the app is the person in the record. The code goes to the number on the record |

That code is deliberately **not** a portal sign-in code, and lives in its own
table. Sharing SP5's challenge table would have meant a code issued to approve
a link could be spent to sign in.

**Withdrawing.** A hospital can unlink a visit, which stops it being offered
and is recorded with a reason and a date. What it does **not** do is revoke a
consent already granted over it — that artefact is the patient's, held by the
consent manager. So the honest answer to "does unlinking stop the sharing?" is
in two halves: it stops new requests finding the visit, and Phase 5 must refuse
to assemble anything for a care context that is no longer linked. Saying only
the first would be a promise this cannot keep.

---

## Discovery: being asked whether we hold anything

This is the only place in the system where an outsider asks after a patient by
name, so it is written as though it were an oracle, because that is what a
careless version would be.

**There is exactly one way to match**: a **verified** ABHA address equal to the
one in the request. Not a typed one, for the same reason a typed ABHA is not
certainty anywhere else; and never a name, a phone number or a date of birth,
because those are what a stranger has. Demographics that positively disagree —
a year of birth off by more than two — refuse a match the ABHA would otherwise
have made.

**Every refusal is the same refusal.** "No such person", "that person but you
got their year of birth wrong" and "we do not know that facility" are three
sentences that would each tell the asker something, so outwardly they are one.

**A discovery that matched is on the patient's audit trail**, whether or not
they go on to link anything. Their identity was used to find them, and that is
theirs to see.

---

## Consent: one model, two origins

A consent granted in the patient's ABHA app is written as a row in
`consent_artefact` — the same table as a consent recorded at a desk — and from
that moment `app.consent_permits` is the only thing that decides what it
reveals. There is no second path into the clinical record, which is the whole
of the decision this was built on.

That function was written for a hospital reading another hospital's record: it
matches on the grantee hospital and requires the patient to be registered
there. ABDM's requester is neither. So the function was **replaced in place**
with a second branch rather than joined by a second function — every policy
that already called it picks up the new case, and no policy was touched.

The new branch is reachable only inside a context bound to **one** consent id,
which nothing but the assembly of a data request will ever set. A clinician's
ordinary request has no such context, and an ABDM artefact names no grantee
hospital, so it can never widen what a hospital sees.

### What the health information types grant

| ABDM type | Granted here |
| --- | --- |
| `Prescription` | medications |
| `DiagnosticReport` | observations, documents |
| `OPConsultation` | encounters, diagnoses, medications, allergies, observations, procedures |
| `DischargeSummary` | encounters, diagnoses, medications, procedures |
| `HealthDocumentRecord` | documents |
| `WellnessRecord` | observations |
| `ImmunizationRecord` | nothing — this system holds no immunisations |

**Clinicians' notes are never granted through ABDM, by any type.** SP5 made
that call for the patient's own downloadable export — whether a doctor's free
text belongs in a bundle is a clinical reviewer's decision, not a mapping one
— and nothing about ABDM changes it.

**What does not map is recorded, not dropped.** An unrecognised or unmodelled
type is written onto the artefact, so somebody can see the consent is narrower
than what was asked for.

### What a notification is refused for

- **A visit this facility never shared.** A consent naming care contexts that
  were never linked here is either a mistake or somebody else's.
- **Types that map to nothing at all.** Storing that artefact would leave the
  patient believing their records were flowing when none can.
- **No end date.** Expiry is a timestamp here rather than a status precisely
  so nobody has to remember to end a consent; one without a date never could.

A refusal is a non-2xx answer, which is deliberate: the consent manager
retries, and that retry is the durability. Building a second retry here would
add a failure mode rather than remove one — which is why a consent
notification, alone among the inbound operations, is written **before** the
gateway is answered.

**Redelivery is free.** The consent manager's own id is unique on the table,
so a notification delivered twice writes nothing the second time.

### Ending one

| How it ends | What happens |
| --- | --- |
| The consent manager revokes it | Recorded as a revocation, with the reason |
| The consent manager says it expired | The same. `expires_at` cannot move — it is the evidence of what was agreed — so "no longer in force" is recorded as a revocation |
| **The patient revokes it in our portal** | It stops here immediately |

That last row deserves a caveat the portal must say out loud: revoking here
stops **this system** from assembling anything, at once. It does not revoke
the artefact at the consent manager, and it does not reach data another
provider already received. To end it everywhere, the patient revokes it in
their ABHA app.

---

## Answering a request for records

A data request names a consent, where to push the records, and the requester's
half of a key agreement. It is accepted or refused at the door — a request on
a consent that is not in force is refused outright, so nothing is written that
suggests a transfer is coming — and the transfer itself is a queued job,
because assembling and encrypting a record is not work to do while a gateway
waits.

**One visit at a time, and the consent is re-read before each one.** That is
not an implementation detail: a patient who withdraws their consent while a
transfer is running stops the rest of it. What has already gone cannot be
recalled, and the row left behind records `partly_transferred` with the reason
rather than rounding the outcome to "done" or "failed".

**The bundle is assembled in a context bound to that one consent.** A mistake
in the code that builds a bundle cannot widen it; it can only ask for rows the
database has already decided it may see. What comes out is a FHIR `document`
bundle led by a `Composition` — close to ABDM's published profiles per health
information type, and **not asserted to conform to them**. That check is Phase
6, and reconciling with the sandbox is Phase 8.

### What a bundle leaves out

- **Clinicians' notes**, always. No health information type grants them.
- **The files behind a document.** A `DocumentReference` names the report and
  its date; the bytes are fetched through a link issued one at a time and
  audited, and a bundle never carries a long-lived one.
- **Anything recorded without a visit.** Allergies, observations and documents
  can be entered with no encounter, and a care context *is* a visit — so those
  rows belong to no care context and are in no bundle. This is a real omission
  and it is here rather than left to be discovered.

### The encryption

Each transfer has its own ephemeral key pair on each side. The requester sends
a public key and a nonce; this system generates its own pair, agrees a shared
secret by X25519, and derives an AES-256-GCM key and initialisation vector by
HKDF-SHA256 with the two nonces exclusive-ored as the salt. Nothing that could
decrypt a transfer exists after it, on this side, unless somebody kept it —
the private key never leaves the function that used it and is never stored or
logged.

The scheme is proved self-consistent by a test that plays the requester and
decrypts what was sent, and that shows two transfers to the same requester
never share a key. What that cannot prove is that ABDM derives the key the
same way: the parameters are the published ones as understood here, this is
the sort of detail where nearly right is wrong, and reconciling them is Phase
8. One module holds all of it.

### What is written down about a transfer

Every row that left is on the patient's audit trail, attributed to the
requester and carrying the consent artefact it rested on — so "who has seen
this" is answered the same way for a national requester as for a hospital. The
data request row says what was asked for, how much of it went, and why it
stopped if it did.

---

## One deployment, many facilities

ABDM registers a **facility**; this platform hosts many. The client id and
secret belong to the deployment, and the facility id — `X-HIP-ID` — belongs to
the hospital, which is why it is `hospital.hfr_id` and not only the
`ABDM_HIP_ID` setting. Outbound calls carry the hospital's own registry id;
inbound requests are answered for the facility the header names, and a header
naming a facility this deployment does not know is answered with the same
"no patient found" as everything else.

`ABDM_HIP_ID` remains as the default for a deployment that serves one
facility. Phase 2 had only that, which was right for a single clinic and wrong
here.

---

## What authenticates a callback

The callback endpoint is reachable from outside and is answered on behalf of
the national registry, so what protects it deserves a straight answer rather
than the word "authenticated".

Three checks, in order, and each is worth something different:

1. **A shared secret** (`ABDM_CALLBACK_SECRET`), compared in constant time.
   Required in production. This is the check the specification is least
   generous about — where the gateway cannot be configured to send a secret,
   this degrades to the two below, and this page is where that would be
   recorded rather than quietly assumed away.
2. **A correlation id we issued and are still waiting on.** The strongest of
   the three, and the only one that needs nothing from ABDM: an answer to a
   question nobody asked is refused, so reaching the URL does not let a caller
   inject an outcome — only answer a call this process made, in the seconds it
   is waiting.
3. **A timestamp within `ABDM_CALLBACK_SKEW_SECONDS`**, in either direction. A
   captured callback sent again later is refused; usually check 2 has already
   forgotten it.

The refusal says nothing about which check failed. Telling a caller that their
correlation id was unknown tells them how to find one that is not.

**What none of this establishes is the content of a consent artefact.** That
rests on the artefact's own signature, and it is Phase 4's problem. It is named
here so that nobody reads the three checks above as covering it.

---

## Running against the mock gateway

`ABDM_MODE=mock` is enough for ordinary development: it needs no server and no
configuration.

The **mock gateway server** in `src/modules/abdm/gateway/mock-gateway.ts` is
the other kind of mock — a real HTTP server that hands out sessions, refuses a
call without one, answers 202, and calls back on its own connection. It is what
`abdm-gateway.e2e-spec.ts` points `ABDM_MODE=gateway` at, and it is deliberately
awkward in the ways the real gateway is: it can be told to answer with an
error, or not to answer at all, which is how the timeout path is covered.

Operations are added to it beside the adapter that calls them. There is one
place the wire format lives, and this is half of it.

---

## Open, and honest about it

- **No sandbox credentials**, so nothing here has met ABDM. Phase 8 reconciles
  the mock against the sandbox and records every difference.
- **No registered facility**, in the Health Facility Registry or the Health
  Professional Registry. Both are needed before certification is even a
  question, and neither can be done from a repository.
- **The ABHA number's checksum is not verified.** The shape is checked —
  fourteen digits — and the published check digit algorithm is not applied,
  because a check that is wrong is worse than none. Confirmed with the sandbox.
- **Demographic verification is not implemented**, deliberately: it is not a
  challenge, it confirms nothing about who is standing at the desk, and an
  enum value for something unimplemented is a claim this sub-project does not
  make.
