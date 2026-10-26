import { config } from './config';
import { getPrisma } from './db/prisma';
import { ensureSuperadmin } from './auth/bootstrap';
import { createServer } from './server';
import { createSmtpMailer } from './mail/mailer';
import { runDetached } from './http/background';
import { startHistoryPruning } from './history/scheduler';
import { recoverOrphanedGenerations, startAiRetention } from './ai/retention';

// Migrations are not run here: the container runs `prisma migrate deploy` before starting.
async function main() {
  const prisma = getPrisma();
  await ensureSuperadmin(prisma, config.admin);
  // Recover any orphaned AI generations BEFORE accepting new requests
  await recoverOrphanedGenerations(prisma);
  const stopPruning = startHistoryPruning(prisma);
  const stopAiRetention = startAiRetention(prisma);

  const { http, rooms, shutdownAi } = createServer({
    prisma,
    mailer: createSmtpMailer(config.mail),
    config,
    runInBackground: runDetached,
  });
  http.listen(config.port, () => {
    console.log(`Server is running on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    stopPruning();
    stopAiRetention();
    await shutdownAi().catch((err) => console.error(err));
    await rooms.flushAll().catch((err) => console.error(err));
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
