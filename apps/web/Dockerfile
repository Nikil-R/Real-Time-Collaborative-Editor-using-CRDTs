# Next.js web app. Build context: the REPOSITORY ROOT (it needs the workspace packages):
#   docker build -f apps/web/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://example.com .
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/crdt/package.json packages/crdt/
COPY packages/client/package.json packages/client/
COPY apps/web/package.json apps/web/
COPY loadtest/package.json loadtest/
RUN pnpm install --frozen-lockfile --filter @rce/web...

COPY packages/crdt packages/crdt
COPY packages/client packages/client
COPY apps/web apps/web

# NEXT_PUBLIC_* values are baked into the browser bundle at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @rce/web build

FROM node:24-alpine AS run
RUN corepack enable
WORKDIR /repo
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo /repo
USER node
EXPOSE 3000
CMD ["pnpm", "--filter", "@rce/web", "start"]
