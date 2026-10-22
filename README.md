This is a simple server that serves as the backend for drawDB. It has 2 functions:

1. Send bug reports via email
2. Handle interfacing with the GitHub REST API

### Getting Started

Set up the environment variables by following `.env.sample`

```bash
git clone https://github.com/drawdb-io/drawdb-server.git
cd drawdb-server
npm install
npm run migrate:dev   # applies prisma/migrations to DATABASE_URL (local dev)
npm run dev
```

### Database (Prisma)

The schema lives in `prisma/schema.prisma` and the SQL migrations in `prisma/migrations`.
`npm install` / `npm run build` run `prisma generate`, which writes the client to `src/generated/prisma` (git-ignored).

- Local development: `npm run migrate:dev` (creates and applies migrations; needs a role with `CREATEDB` for Prisma's shadow database).
- Production / container: `npm run migrate` (`prisma migrate deploy`) runs before `node dist/index.js`. The server never runs migrations on startup.
- Tests use `DATABASE_URL_TEST` (default `postgres://drawdb:drawdb_local@localhost:5432/drawdb_test`); vitest applies the migrations to it before running.

### Docker Compose run in dev

```bash
docker compose up -d
```