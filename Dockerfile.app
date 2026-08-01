# SchedulePoint — application image (image 1 of 3).
#
# ############################################################################
# # SKELETON. Structure and syntax only. NOT BUILT in this environment       #
# # (FAD-7: no Docker daemon). Nothing here has been executed.               #
# ############################################################################
#
# Runs the Fastify API and serves the built web bundle's static assets. Per
# SPEC-10 this is one image with several process classes (api, worker), selected
# by the command — not several images, because they share the same code and the
# same migration state.
#
# Deliberate properties, each of which a later slice depends on:
#  - multi-stage: the runtime layer carries no build toolchain and no dev deps;
#  - non-root user: the runtime never needs to write to its own filesystem;
#  - no database credential baked in: secrets arrive from the secret store
#    (TDG-13) at start, never from the image.

# --- Stage 1: dependencies ---------------------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
RUN pnpm install --frozen-lockfile

# --- Stage 2: build ----------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm run gate:typecheck && pnpm run gate:build

# --- Stage 3: runtime --------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json

USER node
EXPOSE 3001

# The boot path re-asserts that no route lacks a policy before it listens
# (apps/api/src/index.ts). A container that would serve an undeclared route
# exits instead.
CMD ["node", "apps/api/dist/src/index.js"]
