FROM oven/bun:1.3.14-alpine AS sdk-builder

WORKDIR /sdk

ARG ARKIV_JS_SDK=develop

RUN apk add --no-cache git

RUN git clone https://github.com/Arkiv-Network/arkiv-sdk-js.git . \
  && git checkout "${ARKIV_JS_SDK}" \
  && bun install --frozen-lockfile \
  && bun run package:test

FROM oven/bun:1.3.14-alpine

WORKDIR /app

ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown

COPY --from=sdk-builder /sdk/arkiv-network-sdk-latest.tgz ./arkiv-sdk-js/arkiv-network-sdk-latest.tgz
COPY package.json ./
RUN bun install

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV BUILD_COMMIT=${BUILD_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}

# Override CMD per-service in docker-compose.
CMD ["bun", "run", "serve"]
