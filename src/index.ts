import { config } from './config';
import { getPrisma } from './db/prisma';
import { ensureSuperadmin } from './auth/bootstrap';
import { createServer } from './server';
import { createSmtpMailer } from './mail/mailer';
import { runDetached } from './http/background';

// Migrations are not run here: the container runs `prisma migrate deploy` before starting.
async function main() {
  const prisma = getPrisma();
  await ensureSuperadmin(prisma, config.admin);

  const { http } = createServer({
    prisma,
    mailer: createSmtpMailer(config.mail),
    config,
    runInBackground: runDetached,
  });
  http.listen(config.port, () => {
    console.log(`Server is running on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    // Task 8: await rooms.flushAll() here.
    await prisma.$disconnect().catch((err) => console.error(err));
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
