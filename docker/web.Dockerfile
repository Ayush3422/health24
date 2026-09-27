# The clinical app and the patient portal (sp7-plan.md, T14).
#
# One Dockerfile, built twice: `--build-arg APP=clinical` and
# `--build-arg APP=portal`. They are the same kind of thing — a bundle of
# static files and a server that sends them with the right headers — and
# keeping one definition means the portal cannot quietly lose a header the
# clinical app has.

ARG NODE_VERSION=22.12.0
ARG NGINX_VERSION=1.27-alpine

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS deps

# pnpm installed directly rather than through corepack: the corepack bundled
# with this Node cannot verify the registry's current signing keys, and an
# image build is the wrong place to depend on a key rotation somewhere else.
# The version is the one in the lockfile's `packageManager`.
ARG PNPM_VERSION=10.11.0
RUN npm install --global "pnpm@${PNPM_VERSION}"

WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/clinical/package.json apps/clinical/
COPY apps/portal/package.json apps/portal/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build the bundle, and the header snippet that serves it
# ---------------------------------------------------------------------------
FROM deps AS build

ARG APP
RUN test -n "$APP" || (echo "APP build argument is required (clinical or portal)" && exit 1)

COPY tsconfig.base.json ./
COPY scripts scripts
COPY packages/shared packages/shared
COPY apps/${APP} apps/${APP}

RUN pnpm --filter @health24/shared build \
 && pnpm --filter @health24/${APP} exec vite build

# Generated rather than hand-written, so the deployed policy is the one the
# browser suites ran against (T10).
RUN node scripts/render-nginx-headers.mjs "${APP}" /security-headers.conf

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM nginx:${NGINX_VERSION} AS runtime

ARG APP

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY --from=build /repo/apps/${APP}/dist /usr/share/nginx/html

# The stock image's default site, which would otherwise shadow ours.
RUN rm -f /etc/nginx/conf.d/default.conf \
 && mkdir -p /tmp/client_body \
 && chown -R nginx:nginx /tmp /var/cache/nginx /usr/share/nginx/html

USER nginx

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
