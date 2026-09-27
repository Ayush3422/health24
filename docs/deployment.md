# Deployment

How this system is packaged, what it runs on, and what a deploy actually does
(sp7-plan.md, Phase 4).

Nothing here has been applied to a cloud account. The infrastructure is written,
formatted, validated and reviewed; the first real `terraform apply` will find
something, and that is expected rather than hidden — it is a task in SP8, not an
assumption in this page (Decision V1).

## The images

| Image | Built from | Runs | Serves |
| --- | --- | --- | --- |
| `health24/api` | `docker/api.Dockerfile` | `node dist/main.js` | the API on 3000 |
| `health24/api` | the same image | `node dist/worker.js` | queues, and probes on 3100 |
| `health24/clinical` | `docker/web.Dockerfile --build-arg APP=clinical` | nginx | the clinical app on 8080 |
| `health24/portal` | `docker/web.Dockerfile --build-arg APP=portal` | nginx | the patient portal on 8080 |

**The API and the worker are one image.** They share every line of code; two
images would be two things to keep in step and one chance for the worker to be
running last week's code.

**Both apps are one Dockerfile**, built twice. The alternative is the portal
quietly losing a header the clinical app has.

Every image runs as a non-root user with a read-only root filesystem, carries a
healthcheck, and is tagged with the commit it was built from. The nginx images
get their security headers **generated** from
`packages/shared/src/security-headers.ts` at build time
(`scripts/render-nginx-headers.mjs`), so what production sends is what the
browser suites ran against.

## The whole stack, locally

```bash
cp .env.prod-local.example .env.prod-local   # then fill in the two keys
docker compose -f docker-compose.prod.yml up --build
```

That is the same images, the same configuration shape and the same startup
order as a deployment, on one machine:

- **postgres, redis, storage, clamav** — RDS, ElastiCache, S3 and an ECS
  service in a deployment.
- **migrate** — a one-shot job holding the owner's connection. It has to finish
  before anything serves.
- **db-init** — creates the unprivileged login role the application connects
  as, which in a deployment is done by whoever provisions the database.
- **api** on `localhost:3001`, **worker** probes on `localhost:3101`,
  **clinical** on `localhost:8081`, **portal** on `localhost:8082`.

The data is synthetic, always (DF1). The API in this stack runs with
`NODE_ENV=production`, which means every production refusal applies: a
development JWT secret, a storage region outside Mumbai, the owner's database
connection or the `log` SMS provider all stop it starting (T2). That is the
point — it is the cheapest place to find a configuration mistake.

## What runs in AWS

Everything in `infra/terraform`, in `ap-south-1`, per environment:

- **VPC**, two zones. Public subnets hold the load balancer and nothing else;
  tasks are private; the database and the cache have no route to the internet
  at all. S3 is reached through a gateway endpoint, so document traffic never
  leaves the VPC.
- **RDS PostgreSQL 16**, multi-AZ in production, encrypted with its own KMS key,
  `rds.force_ssl` on, point-in-time recovery for fourteen days, and a master
  password AWS generates into Secrets Manager — so no password is ever in this
  repository or in Terraform state.
- **ElastiCache Redis**, encrypted in transit and at rest, with a replica in
  production: the jobs that tell a patient their record was read under
  emergency access are not worth losing (SP5).
- **S3** for documents: private, versioned, KMS-encrypted, TLS-only by bucket
  policy, old versions expiring after ninety days so an erasure request does
  not leave copies behind for years.
- **ECS Fargate**: the API, the worker, the two apps, and clamav — which is a
  dependency of every upload rather than an optional extra, found by the other
  services through internal DNS.
- **An ALB** with three host names. The API's target group asks `/ready`, not
  `/health`: a task that cannot reach its database should be taken out of
  rotation rather than restarted (DF6). `/api/*` on either app's host name is
  routed to the API, which is what keeps a browser same-origin (T13).
- **Secrets Manager**, names only. Terraform creates each secret empty; a person
  fills it in once. There is deliberately no `secret_version` resource, because
  that would put the value in state.
- **CloudWatch** log groups with retention, and four alarms: the API failing
  requests, no healthy API task, the database filling up, and point-in-time
  recovery falling behind. Every one has a runbook.

### IAM, in one line each

- The **execution role** starts containers: pull an image, read the secrets it
  injects, write a log stream.
- The **API's task role** may read and write documents in one bucket. It may not
  delete them.
- The **worker's task role** may also delete them, because an erasure request is
  its job (sp5-plan.md, Decision N1). The grant is a separate policy so that it
  is visible rather than buried.
- Nothing has the database owner's credentials except the migration task.

## What a deploy does

`.github/workflows/deploy.yml`, in order:

1. **Build and scan** every image — on every push, with no credentials. Trivy
   fails the build on a high or critical vulnerability that has a fix (DF8).
2. **Push** to ECR, if a deploy role is configured. Authentication is OIDC:
   there is no access key to leak.
3. **Deploy**, only when a person asks and only through a GitHub environment a
   reviewer approves:
   1. register the migration task definition at the new image,
   2. run it as a one-off task and **wait for its exit code**,
   3. `terraform apply` with the new image tag, which rolls the services,
   4. wait for every service to be stable,
   5. ask `/version` whether the commit now serving is the one that was
      deployed, and `/ready` whether it can serve.

**Migrations never run on boot.** Two tasks starting together would both try,
and a migration that fails halfway through a rolling deploy leaves half the
tasks serving against a schema they do not expect. One job, run once, waited
for — and the readiness probe checks afterwards that the schema is where the
code expects it (migration 0066).

**Without AWS credentials, everything after the build is skipped rather than
failed.** A repository with no cloud account should have a green pipeline; a
permanently red one is a pipeline everybody learns to ignore.

## Before the first apply

1. Create the state bucket and the lock table by hand — a backend cannot create
   its own storage.
2. Create the GitHub OIDC role and set `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`,
   `TF_LOCK_TABLE` and `API_HOSTNAME` as repository variables.
3. `terraform apply` once without the services, then read
   `database_master_secret_arn`, build the two connection URLs from it, and put
   them in the `app_database_url` and `owner_database_url` secrets — along with
   a generated `JWT_ACCESS_SECRET` and `TOTP_ENCRYPTION_KEY`.
4. Create the login role the application connects as, and grant it
   `health24_app`. It must not be the owner: owners bypass row-level security,
   which would make tenant isolation decorative (`sp1-plan.md`).
5. Point DNS at the load balancer and put the certificate ARN in the
   environment's `.tfvars`.
6. Subscribe a person to the alerts topic. People change without a Terraform
   run, so this is not in Terraform.

Then deploy staging, run the restore drill against it, and read
`docs/runbooks/` end to end before anything real is loaded.
