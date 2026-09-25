# Observability

What the system says about itself, and the one rule that governs all of it
(sp7-plan.md, Phase 2).

## The rule

**Logs and metrics carry identifiers, never people.** A UUID, a hospital id, a
route, a status code — these say which row to go and read, under the controls
that protect it. A name, a phone number, an MRN or a line of clinical text says
what is in the row, and a log aggregator has none of the record's protections:
no row-level security, no consent, no audit of who read it, and a retention
nobody chose.

This is enforced rather than asked for. `common/logging/scrub.ts` sits in
pino's `logMethod` hook, so every line — whatever anybody wrote, wherever they
wrote it — is scrubbed on the way out, by key (`name`, `phone`, `mrn`,
`chiefComplaint`, …) and by shape (mobile numbers, emails, MRNs, Aadhaar and
ABHA numbers, wherever they appear in prose). `test/logging.e2e-spec.ts` runs a
real application against a real log file and reads every line back.

The audit trail is a different thing and stays where it is: it is the legal
record of who read what, it is append-only, and nothing moves it into a log
sink.

## Logs

One JSON object per line, written to standard output — or to `LOG_FILE` when
there is no collector. `LOG_LEVEL` sets the level; outside production a
developer gets a prettified line per request unless `LOG_FORMAT=json`.

Every request produces one line carrying the request id (`req.id`), the method,
the path **without its query string**, the status and the duration. The id
comes from `x-request-id` when the edge set one and is echoed back on the
response, so a line here lines up with a line from the load balancer.

An unhandled 5xx produces one more line: the route, the request id, the acting
staff and hospital ids, the status, and the error's name, scrubbed message and
stack. A 4xx does not — the caller being told no is already in the request
line.

## Errors

`ErrorReporter` is an interface with a no-op default: nothing leaves the
process. A transport — Sentry or anything else — is added by implementing it
and providing it in `AppLoggerModule`, and it receives what the scrubber
allows, not what the error carried. That is deliberate: our errors quote rows,
and a third party that has not signed anything should not receive them.

## Probes

| Route | Answers | Fails when |
| --- | --- | --- |
| `GET /health` | Is the process alive? | It cannot answer at all |
| `GET /ready` | Can it serve? | Database, migrations, Redis or storage is down — 503 |
| `GET /version` | What is running? | Never; reports `unknown` when the build did not say |

`/health` deliberately touches nothing else: restarting a process will not fix
a database that is down, and would lose what is in flight. `/ready` asks every
dependency, each with a two-second timeout, and reports each one separately so
the answer says *which* dependency is the problem.

The migration check asks `app.schema_version()` — a function, because the
application role is kept out of the migration history on purpose (migration
0066). A process whose database is behind the schema its code expects reports
not ready rather than serving half its routes.

## Metrics

`GET /metrics`, in the Prometheus text format, from a small in-process
collector (`health/metrics.service.ts`) rather than a metrics library.

| Metric | Type | Labels |
| --- | --- | --- |
| `http_requests_total` | counter | `route`, `method`, `status` (`2xx`, `4xx`, `5xx`) |
| `http_request_duration_seconds` | histogram | `route`, `method` |
| `audit_write_failures_total` | counter | `action` |

`audit_write_failures_total` is the one to alert on first. An audit write that
fails leaves the record readable and the trail of who read it missing, which is
the failure a regulator asks about — and it is invisible in a log read one line
at a time.

`route` is the **pattern** — `/api/v1/patients/:id`, never a real id. That
keeps the number of time series bounded, which every metrics system asks for,
and keeps a patient's id off a dashboard that is kept for a year.

## What is not here yet

Queue depth and job failures. `MetricsService.gauge` is where they go, and the
worker — which is where the queues actually live — has no HTTP server to
scrape yet; it gets one in Phase 4, with the containers. Dashboards and alert
thresholds belong with the infrastructure rather than the code.
