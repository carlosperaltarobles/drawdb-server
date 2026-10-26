FROM node:24-alpine AS build
WORKDIR /app

# Prisma 7 loads DATABASE_URL from prisma.config.ts even for client generation.
# This build-only placeholder is never copied to the runtime image.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json .env* ./
COPY prisma.config.ts ./
COPY prisma ./prisma
# Keep Prisma's CLI and generated runtime client available in production.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build npm ci --omit=dev \
    && npm cache clean --force

COPY --from=build /app/dist ./dist

EXPOSE 5000
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/index.js"]
