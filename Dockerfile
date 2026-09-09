FROM oven/bun:1.4.0-alpine

WORKDIR /app

ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown

COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY llms.txt ./
COPY src ./src
# The scripts run inside the container too: the offline genesis importer
# (scripts/importGenesisState.ts) is started with `docker compose run --rm backend ...`.
COPY scripts ./scripts

ENV NODE_ENV=production
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}

# Override CMD per-service in docker-compose.
CMD ["bun", "run", "serve"]
