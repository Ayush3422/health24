# Accepted risks

Everything a scanner or a review found that is **not** being fixed right now,
why, and when it is looked at again (sp7-plan.md, DF8).

An entry needs four things: what it is, why it does not apply or cannot be
fixed yet, who accepted it, and a date to revisit. **An entry with no date is
an entry nobody will ever remove**, which is how a risk register becomes a list
of things everybody has stopped reading.

A finding that is fixed leaves this file. It is not a history; the history is
in git.

## How the gate works

| Scanner | What fails the build | What is only reported |
| --- | --- | --- |
| `pnpm audit --prod` | High and critical in anything that ships | — |
| `pnpm audit` | — | High and critical in development and build tooling |
| gitleaks | Any secret, in the tree or in history | — |
| Trivy, on each image | High and critical with a fix available | Unfixed advisories |
| Trivy, on the repository | Misconfigured Dockerfiles and Terraform | — |

Production dependencies gate because they run beside a patient's record.
Development tooling does not, because a vulnerability in a test runner is a
vulnerability on a developer's machine — and a build that fails every day on one
teaches everybody to ignore the scanner, which is the failure the scanner exists
to prevent. They are reviewed here instead.

## Open

### Development tooling with high or critical advisories

**Accepted on 2026-09-28. Revisit 2026-12-31, and before any external
penetration test.**

| Package | Reaches | Why it is not a build failure |
| --- | --- | --- |
| `vitest` (critical) | the test runner | The advisory is the Vitest **UI server** serving arbitrary files. The UI is never started — not locally, not in CI — and the runner has no network listener without it. |
| `vite` | `@nestjs/cli` → `unplugin` | A `server.fs.deny` bypass in the dev server. The API's own dev server is Nest, not Vite; this copy of Vite is a build-time dependency that never listens. |
| `glob`, `picomatch`, `tmp` | `@nestjs/cli` | Command injection through the glob CLI, a ReDoS, and a path traversal — all reachable only by running those tools against attacker-controlled patterns, which is a developer's own machine and their own input. |
| `undici` | `testcontainers` | Unbounded memory in a websocket client that nothing here opens. `testcontainers` is a test dependency. |

None of these ship. The API image is built from the production dependency tree
(`pnpm deploy --prod`), and the apps ship as static files with no Node at all —
so none of the above is in an image that runs anywhere.

**What would change this:** any of them moving into a production dependency, or
a CI job that starts one of these servers.

### The `/metrics` endpoint is public

**Accepted on 2026-09-28. Revisit when the load balancer's rules are written for
real, and before a pilot.**

`/metrics` answers anybody who can reach the API. It holds counts by route,
method and status class, and — by construction — nothing about a patient
(`docs/observability.md`). What it does reveal is the shape of the API and how
busy it is.

The intended fix is a listener rule that refuses `/metrics` from outside the
VPC, which belongs with the load balancer rather than the application. Until
then, the exposure is: an attacker learns the route names, which are also in
every client bundle.

## Closed recently

Kept only until the next revisit date, as evidence the register is being worked
rather than accumulated.

| Finding | Closed | How |
| --- | --- | --- |
| `drizzle-orm` < 0.45.2 — SQL injection via improperly escaped identifiers | 2026-09-28 | Upgraded to 0.45.3. The review also established the code was never exposed: the only `sql.identifier()` call takes a key of a fixed seven-entry constant, chosen by a Zod enum, and never a string from a request. |
| `multer` < 2.3.0 — four denial-of-service advisories | 2026-09-28 | Overridden to ≥ 2.4.0. It arrives through `@nestjs/platform-express`; the API parses no multipart at all — uploads are presigned straight to storage — so nothing was exposed, but a future `FileInterceptor` would have reintroduced it silently. |
| `lodash` ≤ 4.17.23 — code injection via `_.template` | 2026-09-28 | Overridden to ≥ 4.18.1. It arrives through `@nestjs/config`, which uses `get` and `set` and never `template`. |
