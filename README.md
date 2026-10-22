# drawDB server

The backend serves the DrawDB API, project collaboration over Socket.IO, account email, and the legacy GitHub Gist endpoints.

## Local development

Start PostgreSQL and, when testing verification or password-reset emails, Mailpit on SMTP port `1026`. Then configure and start the server:

```bash
cp .env.sample .env
npm ci
npm run migrate:dev
npm run dev
```

The API listens on port `5000`; the health endpoint is `http://localhost:5000/api/health`. `npm run migrate:dev` creates and applies local schema changes. Tests may use `DATABASE_URL_TEST` as configured by the test setup.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. In Dokploy, use the database service's internal hostname and port, for example `postgres://drawdb:<password>@<postgres-service-name>:5432/drawdb`. |
| `APP_URL` | Public frontend origin. Set it to the same HTTPS host served by the frontend in production; this controls email links and secure cookies. |
| `ALLOWED_EMAIL_DOMAINS` | Optional comma-separated email domains allowed to register. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional bootstrap superadmin credentials. If omitted, startup keeps existing users and warns only when there is no administrator. A verified existing administrator retains its password. |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM` | SMTP settings for account verification and password reset. For local Mailpit, use host `localhost`, port `1026`, and `MAIL_SECURE=false`. |
| `PORT` | HTTP port; defaults to `5000`. |
| `NODE_ENV` | Use `dev` for local development and `production` in Dokploy. |
| `GITHUB_TOKEN` | Optional token for the legacy GitHub Gist endpoint. |

Never commit a populated `.env` file. Set production values as Dokploy environment variables.

## Deploy with Dokploy

Deploy with `compose.dokploy.yaml`. The API joins the existing external `dokploy-network`, exposes container port `5000` to that network, and does not publish a host port. Reuse the PostgreSQL service already in Dokploy; do not add a second production database. Set `DATABASE_URL` to that service's internal DNS name and port, and set `APP_URL` to the frontend's public origin.

Configure the frontend and API on the same public host. Route `/api` and `/socket.io` to `drawdb-api:5000`, preserve the request path (no strip/replace-prefix middleware), and enable WebSocket proxying for `/socket.io`. Leave the frontend route for `/`. The API trusts one reverse proxy hop, so keep it behind the Dokploy proxy rather than publishing port `5000` directly.

The container applies committed migrations with `prisma migrate deploy` before starting the server. Migrations live in `prisma/migrations`; the Prisma 7 schema and config are `prisma/schema.prisma` and `prisma.config.ts`. Startup is safe to repeat. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` only when provisioning the initial administrator; omitting them does not replace an existing account's credentials.
