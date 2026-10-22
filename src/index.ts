import { config } from './config';
import { getPool } from './db/pool';
import { migrate } from './db/migrate';
import { ensureSuperadmin } from './auth/bootstrap';
import { createServer } from './server';
import type { Mailer } from './mail/mailer';

// Placeholder until Task 3 adds the SMTP mailer.
const logMailer: Mailer = {
  async send(m) {
    console.log(`[mail] to=${m.to} subject=${m.subject}`);
  },
};

async function main() {
  const pool = getPool();
  await migrate(pool);
  await ensureSuperadmin(pool, config.admin);

  const { http } = createServer({ pool, mailer: logMailer });
  http.listen(config.port, () => {
    console.log(`Server is running on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    // Task 8: await rooms.flushAll() here.
    await pool.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
