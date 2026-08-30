# Migration Sentinel — Fly.io image for @sentinel/web (Next.js 15 monorepo).
#
# Single-stage on purpose: this is a pnpm workspace whose packages ship raw .ts
# entrypoints that Next transpiles at build time (see next.config.mjs
# transpilePackages). Keeping the full install (incl. drizzle-kit) also lets the
# Fly release_command run `pnpm db:migrate` against the control-plane DB.
FROM node:22-slim AS app

# Needed by node-pg / TLS to Fly Postgres over flycast.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable

WORKDIR /app

# Install with the lockfile first (better layer caching), then build.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @sentinel/web build

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

# `next start -p 3000`, binds 0.0.0.0 by default.
CMD ["pnpm", "--filter", "@sentinel/web", "start"]
