# ABDM

How this system reaches the Ayushman Bharat Digital Mission, what is built,
and — as carefully as the rest — what is not (sp8-plan.md, DF11).

**This page grows with the sub-project.** Today it covers ABHA identity, the
transport underneath it, and care contexts — which visits are offered to the
national network and how. Consent notification and the data push are Phases 4
and 5, and are described here when they exist, not before.

---

## What is built

| | Status |
| --- | --- |
| Confirming a patient's ABHA against the registry | **Built** (Phase 1) |
| The gateway transport: sessions, correlation, callbacks | **Built** (Phase 2) |
| Care-context discovery and linking | **Built** (Phase 3) |
| Consent notification from the consent manager | Phase 4 |
| Assembling and pushing health information | Phase 5 |
| A `/fhir/R4` read surface | Phase 6 |
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
