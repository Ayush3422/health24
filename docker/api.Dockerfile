# The API and the worker (sp7-plan.md, T14).
#
# One image, two commands. They share every line of code and every dependency;
# building them separately would mean two things to keep in step and two
# chances for the worker to be running last week's code.
#
# Debian rather than Alpine on purpose: argon2 is a native module, and a glibc
# base uses its prebuilt binary instead of compiling it — which needs a
# toolchain in the image and takes minutes per build.

ARG NODE_VERSION=22.12.0

# ---------------------------------------------------------------------------
# Dependencies, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS deps

# pnpm installed directly rather than through corepack: the corepack bundled
# with this Node cannot verify the registry's current signing keys, and an
# image build is the wrong place to depend on a key rotation somewhere else.
# The version is the one in the lockfile's `packageManager`.
ARG PNPM_VERSION=10.11.0
RUN npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /repo

# Only the manifests, so that a source change does not reinstall the world.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/clinical/package.json apps/clinical/
COPY apps/portal/package.json apps/portal/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @health24/api... build

# What the runtime needs, and nothing else: the built API, the built shared
# package, and the production dependency tree with its workspace links
# resolved into real directories.
RUN pnpm --filter @health24/api --prod --legacy deploy /deploy \
 && cp -r apps/api/dist /deploy/dist \
 && cp -r apps/api/drizzle /deploy/drizzle

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# curl for the health check, and nothing else. Every other package is a
# package somebody has to patch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# What `/version` reports. Passed by the image build — a deploy that cannot say
# which commit is serving is a deploy nobody can reason about during an
# incident (T8).
ARG BUILD_SHA=unknown
ARG BUILD_TIME=unknown

ENV NODE_ENV=production
ENV PORT=3000
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}

WORKDIR /app

# `node` exists in the base image as uid 1000 and owns nothing here: the
# process can read its code and write nowhere.
COPY --from=build --chown=root:root /deploy/node_modules ./node_modules
COPY --from=build --chown=root:root /deploy/dist ./dist
COPY --from=build --chown=root:root /deploy/package.json ./package.json
# The migration journal, which the readiness probe compares against the
# database, and the SQL the migration job applies.
COPY --from=build --chown=root:root /deploy/drizzle ./drizzle

USER node

EXPOSE 3000

# Liveness, asked the way a load balancer asks it. Readiness is a separate
# question and is asked by the orchestrator, not by Docker (DF6).
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "dist/main.js"]
