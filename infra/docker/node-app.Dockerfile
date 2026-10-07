# Shared build stage for the Node apps (api + workers).
#
# Multi-stage: deps are installed once and copied into a slim runtime image, so the
# final image contains no TypeScript toolchain and no dev dependencies.
#
# Build args:
#   APP_DIR   workspace directory of the app (e.g. apps/api)
#   APP_NAME  turbo package name (e.g. @renderflow/api)

# ---- base ---------------------------------------------------------------
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /repo

# ---- deps ---------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc* ./
COPY apps/api/package.json apps/api/
COPY apps/content-worker/package.json apps/content-worker/
COPY apps/media-worker/package.json apps/media-worker/
COPY apps/publisher-worker/package.json apps/publisher-worker/
COPY apps/analytics-worker/package.json apps/analytics-worker/
COPY apps/outbox-relay/package.json apps/outbox-relay/
COPY apps/reaper/package.json apps/reaper/
COPY libs/common/package.json libs/common/
COPY libs/db/package.json libs/db/
COPY libs/queue/package.json libs/queue/
COPY libs/storage/package.json libs/storage/
COPY libs/observability/package.json libs/observability/
# `pnpm install --ignore-scripts` here; argon2's native binding is built during
# the build stage, once the workspace is fully present.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ---- build --------------------------------------------------------------
FROM deps AS build
ARG APP_DIR
ARG APP_NAME
COPY tsconfig.base.json ./
COPY libs ./libs
COPY apps ./apps
COPY packages ./packages
RUN pnpm turbo run build --filter="${APP_NAME}..."
# Prune dev dependencies but keep the pruned store for the runtime stage.
RUN pnpm --filter "${APP_NAME}..." deploy --prod /out

# ---- runtime ------------------------------------------------------------
FROM base AS runtime
ARG APP_DIR
# ffmpeg is required by media-worker; harmless elsewhere and keeps one image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/${APP_DIR}/dist ./dist
COPY --from=build /out/${APP_DIR}/package.json ./package.json
# Workspace libs are deployed alongside as @renderflow/* symlinks in node_modules.
ENV NODE_ENV=production
EXPOSE 4000
USER node
CMD ["node", "dist/main.js"]