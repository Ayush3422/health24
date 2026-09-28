# ABDM

How this system reaches the Ayushman Bharat Digital Mission, what is built,
and — as carefully as the rest — what is not (sp8-plan.md, DF11).

**This page grows with the sub-project.** Today it covers ABHA identity and the
transport underneath it. Care contexts, consent notification and the data push
are Phases 3 to 5 and are described here when they exist, not before.

---

## What is built

| | Status |
| --- | --- |
| Confirming a patient's ABHA against the registry | **Built** (Phase 1) |
| The gateway transport: sessions, correlation, callbacks | **Built** (Phase 2) |
| Care-context discovery and linking | Phase 3 |
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
