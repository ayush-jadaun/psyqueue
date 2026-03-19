# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm install --frozen-lockfile
RUN pnpm build

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/ packages/
RUN pnpm install --frozen-lockfile --prod
EXPOSE 4000 50051 8080
CMD ["node", "packages/core/dist/index.js"]
