FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=23560
EXPOSE 23560

CMD ["node", "server.js"]
