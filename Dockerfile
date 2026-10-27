# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:25-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src/ src/

RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:25-alpine AS production
WORKDIR /app

RUN addgroup -S app && adduser -S app -G app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist dist/

USER app
EXPOSE 3000

CMD ["node", "dist/main"]
