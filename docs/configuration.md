# Configuration

Every variable the system reads, what it is for, and what happens without it.

The schema in [`apps/api/src/config/env.ts`](../apps/api/src/config/env.ts) is
the authority: the API and the worker both refuse to start on configuration
that is missing or malformed, naming what is wrong (sp7-plan.md, DF2). This
page exists so that a person setting the system up does not have to read Zod,
and `apps/api/src/config/configuration-doc.spec.ts` fails if the two ever
disagree.

Nothing here holds a value. Local values live in `.env`, which is not in the
repository; deployed values come from a secret store — see
[secrets.md](secrets.md).

## How to read the table

- **Required** — the process will not start without it.
- **Required in production** — optional locally, refused when `NODE_ENV=production`.
- **Optional** — a default is used, given in the table.

| Variable | Required | Shape | Default | What it is for, and what happens without it |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | Optional | `development` \| `test` \| `production` | `development` | Which set of production refusals applies. Everything below marked "production" is enforced only when this is `production`. |
| `PORT` | Optional | 1–65535 | `3000` | The port the API listens on. |
| `DATABASE_URL` | **Required** | Postgres URL | — | The application's unprivileged connection; row-level security binds to this role. Without it nothing starts. |
| `DATABASE_ADMIN_URL` | Optional | Postgres URL | — | The owner connection, for migrations, seeding and the fixtures. **Refused in production**: the running application is never the owner. |
| `REDIS_URL` | **Required in production** | Redis URL | — | The queues behind upload scanning and messages to patients. Without it both fail quietly, which is why production refuses to start. |
| `JWT_ACCESS_SECRET` | **Required** | ≥16 characters, ≥32 in production | — | Signs access, challenge and portal tokens. A development placeholder beginning `dev_only` is refused in production. |
| `JWT_ACCESS_SECRET_PREVIOUS` | Optional | ≥16 characters | — | The secret this one replaced. Tokens are signed with the current secret and verified against either, so a rotation does not sign everybody out. Must differ from the current one. See [runbooks/key-rotation.md](runbooks/key-rotation.md). |
| `JWT_ACCESS_TTL` | Optional | duration, e.g. `15m` | `15m` | How long an access token lives. |
| `REFRESH_TOKEN_TTL_DAYS` | Optional | 1–365 | `30` | How long a refresh token lives before a full sign-in is required. |
| `TOTP_ISSUER` | Optional | text | `Health24` | The name shown in an authenticator app. |
| `TOTP_ENCRYPTION_KEY` | **Required** | 32 bytes, base64url | — | Encrypts second-factor secrets and emergency-card tokens at rest. Generate with `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`. A key of any other length is refused. |
| `TOTP_ENCRYPTION_KEY_PREVIOUS` | Optional | 32 bytes, base64url | — | The key this one replaced. Secrets are written with the current key and read with either. Withdrawn once `pnpm --filter @health24/api keys:rewrap` has rewritten every row. Must differ from the current one. |
| `CORS_ORIGINS` | **Required in production** | comma-separated origins | — | Which origins may call the API. Without it in production the API would answer whoever asked. |
| `LOG_LEVEL` | Optional | `fatal`…`trace` | `info` | How much the process says. |
| `LOG_FORMAT` | Optional | `json` \| `pretty` | `pretty` outside production | How lines are written. Production writes JSON whatever this says; set `json` locally to see exactly what a deployed process would write. |
| `BUILD_SHA` | Optional | git sha | `unknown` | What `/version` reports as the running commit. Set by the image build. |
| `BUILD_TIME` | Optional | ISO instant | `unknown` | What `/version` reports as the build time. Set by the image build. |
| `LOG_FILE` | Optional | path | — | Writes the log to a file instead of standard output, as JSON, for a host with no collector — and for the test that proves no patient reaches a log line. |
| `WORKER_PORT` | Optional | 1–65535 | `3100` | Where the worker serves `/health` and `/metrics`. It has no API. |
| `ALLOW_DEMO_TERMINOLOGY` | Optional | `true` \| `false` | unset | Whether synthetic `DEMO-` codes may be recorded on a patient. **`true` is refused in production**: a demo code on a real record is a falsified diagnosis. |
| `STORAGE_BUCKET` | Optional | bucket name | `health24-documents` | Where uploaded documents and rendered PDFs live. |
| `STORAGE_REGION` | Optional | AWS region | `ap-south-1` | **Anything but `ap-south-1` is refused in production**: data residency is a legal requirement. |
| `STORAGE_ENDPOINT` | Optional | URL | — | Only for a local S3-compatible server. Plain `http:` is refused in production. |
| `STORAGE_ACCESS_KEY_ID` | Optional | text | — | Local only. **Refused in production**, where the task's IAM role supplies credentials. |
| `STORAGE_SECRET_ACCESS_KEY` | Optional | text | — | As above. |
| `CLAMAV_HOST` | Optional | host | `localhost` | The virus scanner every upload passes through before it can be served. |
| `CLAMAV_PORT` | Optional | 1–65535 | `3310` | As above. |
| `SCAN_QUEUE_NAME` | Optional | text | the default queue | Overridden so that parallel test runs do not take each other's jobs. |
| `SMS_PROVIDER` | Optional | `log` | unset | How sign-in codes reach patients. **`log` is refused in production**: a code in a log is a code anyone with log access can use. A DLT-registered provider is chosen before the pilot. |
| `SMS_LOG_FILE` | Optional | path | — | Where the `log` provider also writes each message, for the browser tests. **Refused in production.** |
| `NOTIFICATION_QUEUE_NAME` | Optional | text | the default queue | As `SCAN_QUEUE_NAME`. |
| `ABDM_MODE` | Optional | `off`, `mock`, `gateway` | `mock` outside production, `off` in it | How this system reaches ABDM. `mock` is an in-process stand-in that needs no credential and accepts a well-known code; `off` refuses every ABDM operation; `gateway` is the wire adapter, and needs the five settings below. **`mock` is refused in production** — it would mark any ABHA verified without the patient being there. See [abdm.md](abdm.md). |
| `ABDM_GATEWAY_URL` | With `gateway` | URL | — | The gateway's base URL. **Plain HTTP is refused in production** unless it is loopback or a private address. |
| `ABDM_CLIENT_ID` | With `gateway` | text | — | This deployment's registered client. |
| `ABDM_CLIENT_SECRET` | With `gateway` | secret | — | Its secret. Injected, never in the repository, and never logged. |
| `ABDM_HIP_ID` | With `gateway` | text | — | The **default** facility id in the Health Facility Registry. ABDM registers a facility and this platform hosts many, so a hospital's own `hfr_id` is used where it has one and this is the fallback for a deployment serving a single facility. |
| `ABDM_CM_ID` | With `gateway` | text | — | The consent manager this deployment is registered with. |
| `ABDM_CALLBACK_SECRET` | Optional | secret | — | What an inbound callback must carry. **Required in production with `gateway`**: without it, anything that can reach the callback URL can answer for the registry. What it is and is not worth is in [abdm.md](abdm.md). |
| `ABDM_CALL_TIMEOUT_MS` | Optional | 1000–120000 | `30000` | How long to wait for an answer that arrives as a separate inbound request. |
| `ABDM_CALLBACK_SKEW_SECONDS` | Optional | 30–3600 | `300` | How far a callback's own timestamp may be from ours, in either direction, before it is refused as a replay. |

## The apps

The clinical app and the portal read no secrets. Both are static builds served
behind a proxy that forwards `/api` to the API; in development the Vite proxy
does it, and `API_ORIGIN` points it somewhere other than `http://localhost:3000`
— which is how the browser tests run a whole second stack on its own ports.

Nothing that a browser can read is a secret, so nothing that a browser can read
is configured here.
