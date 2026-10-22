import { createPrisma, type PrismaClient } from '../../src/db/prisma';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST || 'postgres://drawdb:drawdb_local@localhost:5432/drawdb_test';

let prisma: PrismaClient | undefined;

export function testPrisma(): PrismaClient {
  if (!prisma) {
    prisma = createPrisma(TEST_DATABASE_URL);
  }
  return prisma;
}

/** Empties every table in the schema (the migrations are applied once by the vitest globalSetup). */
export async function resetDb(): Promise<void> {
  const db = testPrisma();
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.$executeRawUnsafe(`truncate ${names} restart identity cascade`);
}
