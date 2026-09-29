# ABDM: the certification position

What ABDM asks of a Health Information Provider, what this system does, and
what has actually been assessed by anybody other than this repository's own
tests (sp8-plan.md, T37, DF11).

**The short answer, first, because it is the one a hospital will repeat to a
regulator: this system is not ABDM-certified.** It has not been assessed, it
is not registered against a real facility, and no part of it has run against
ABDM's sandbox. What it is, is built toward the HIP requirements and tested
against a mock of the gateway.

---

## The three columns that matter

Everything below is one of three things, and they are not the same thing:

| | Meaning |
| --- | --- |
| **Built** | Implemented here and covered by tests against a mock gateway |
| **Sandbox** | Has run against ABDM's own sandbox |
| **Certified** | ABDM has assessed it |

Today **every row is "Built"**, no row is "Sandbox", and no row is
"Certified". The middle column cannot be filled without credentials and the
right without an assessment; both are listed under "What is not ours to do".

---

## Against the HIP milestones

ABDM's milestones are numbered differently in different versions of its
documentation, so this table names the capability rather than the number. The
numbering is one of the things to reconcile when the sandbox is available.

| Capability | Built | Where |
| --- | --- | --- |
| Register a client and hold a gateway session | Yes | `gateway/session.ts` |
| Correlate an asynchronous answer to a request | Yes | `gateway/correlation.ts` |
| Verify a patient's ABHA | Yes | `abha.service.ts` |
| Answer care-context discovery | Yes | `care-contexts/discovery.service.ts` |
| HIP-initiated linking, with the patient confirming | Yes | `care-contexts/linking.service.ts` |
| User-initiated linking, with the HIP sending the code | Yes | same |
| Unlink a care context | Yes | same |
| Receive a consent notification, and act on it | Yes | `consent/abdm-consent.service.ts` |
| Handle revocation and expiry from the consent manager | Yes | same |
| Answer a health-information request | Yes | `transfer/data-request.service.ts` |
| Assemble FHIR bundles per care context | Yes | `transfer/care-context-bundle.ts` |
| Encrypt with ECDH/HKDF/AES-GCM, ephemeral per transfer | Yes | `transfer/fidelius.ts` |
| Push to the requester and notify the outcome | Yes | `transfer/transfer.service.ts` |
| A `/fhir/R4` read surface | Yes | [fhir.md](../fhir.md) |

---

## What will fail an assessment, as far as we can tell

Stated before anybody else finds it. These are the known gaps between what is
built and what the specification asks for.

1. **`Composition.author` is not written.** FHIR R4 marks it `1..*` and a
   strict receiver will reject the bundle on it. The honest value is not a
   single person for a record assembled from a visit; naming the hospital
   would be a claim about attribution the record does not support. This is
   first on the list and needs a decision, not more code.
   ([fhir.md](../fhir.md), deviation 3.)

2. **Conformance to ABDM's profiles is not claimed.** The bundles are FHIR R4
   document bundles led by a typed `Composition`; they have not been validated
   against the published profile per health information type.

3. **The wire parameters are the published ones as understood here.** The
   encryption's salt, info string and key/IV split; the exact request and
   callback shapes; the error codes. Each is the sort of detail where nearly
   right is wrong, and each is in one module so that correcting it is one
   change.

4. **Demographic ABHA verification is not implemented**, deliberately: it is
   not a challenge, and it confirms nothing about who is standing at the desk.
   If ABDM requires it for certification, that is a decision to revisit rather
   than an oversight to fix.

5. **The ABHA number's check digit is not verified.** The shape is checked —
   fourteen digits — and the published algorithm is not applied, because a
   checksum that is wrong is worse than none.

6. **Discovery answers one refusal for every reason.** "No patient found",
   "the year of birth disagrees" and "we do not know that facility" are
   deliberately indistinguishable, because each of them would tell a caller
   something. If certification requires them to be told apart, that is a
   trade-off to argue rather than a bug to fix — and the argument is in
   [abdm.md](../abdm.md).

---

## What is not ours to do

None of these can be done from a repository, and none of them is blocked by
code.

| # | Open | Owner | Before |
| --- | --- | --- | --- |
| 1 | Register the facility in the **Health Facility Registry** and set its `hfr_id` here | The pilot hospital | Any sandbox work |
| 2 | Register the clinicians in the **Health Professional Registry** | The pilot hospital | Certification |
| 3 | Obtain **sandbox credentials** for a registered client | Whoever holds the ABDM relationship | Reconciling the mock (Phase 8, T38) |
| 4 | Run every flow against the **sandbox**, and record each difference | Developer, once 3 exists | Certification |
| 5 | Decide the `Composition.author` question with a clinical reviewer | Clinical reviewer | Certification |
| 6 | Counsel on **ABDM's own obligations**, which sit beside the DPDP Act | Counsel | A pilot with real patients |
| 7 | Submit for assessment | The pilot hospital, with us | — |

---

## What this system will not claim

- That it is certified, until it is.
- That its bundles conform to ABDM's profiles, until a validator says so.
- That the encryption interoperates with ABDM's, until something of ABDM's has
  decrypted one of these bundles.

Each of those is a claim a hospital would repeat to a regulator, and a claim
repeated to a regulator is the most expensive kind to have been wrong about.
