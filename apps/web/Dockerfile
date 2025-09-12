FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@latest --activate && pnpm fetch

FROM no
de:20-alpine AS runner
WORKDIR /app
COPY --from=deps /root/.pnpm-store /root/.pnpm-store
COPY . .
RUN corepack enable && corepack prepare pnpm@latest --activate && pnpm install --offline
CMD ["pnpm","--filter","@bowdoin/web","dev","-p","3000"]
