import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { config } from '../config';

export type { PrismaClient };

export function createPrisma(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

let prisma: PrismaClient | undefined;

/** Process-wide client for the entry point; business logic receives it via AppDeps. */
export function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = createPrisma(config.databaseUrl);
  }
  return prisma;
}
