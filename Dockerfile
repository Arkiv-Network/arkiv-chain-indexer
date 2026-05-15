FROM oven/bun:1.3.14-alpine

WORKDIR /app

ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}

# Override CMD per-service in docker-compose.
CMD ["bun", "run", "serve"]
