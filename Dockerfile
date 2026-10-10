FROM oven/bun:1.4.3 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/shared/src packages/shared/src
COPY apps/bot/package.json apps/bot/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/relay/package.json apps/relay/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY packages packages
COPY apps apps
RUN bun run --cwd apps/bot build

FROM oven/bun:1.4.3
RUN apt-get update && apt-get install -y --no-install-recommends docker.io ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/bot ./apps/bot
COPY --from=build /app/apps/api ./apps/api
WORKDIR /app/apps/bot
ENV NODE_ENV=production HIBANA_DATA_DIR=/var/lib/hibana
CMD ["bun", "src/main.ts"]
