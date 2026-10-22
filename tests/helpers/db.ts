import { Pool } from 'pg';
import { migrate } from '../../src/db/migrate';

let pool: Pool | undefined;

export function testPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL_TEST ||
        'postgres://drawdb:drawdb_local@localhost:5432/drawdb_test',
    });
  }
  return pool;
}

export async function resetDb(): Promise<void> {
  const p = testPool();
  await migrate(p);
  const { rows } = await p.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  const names = rows.map((r) => `"${r.tablename}"`).join(', ');
  await p.query(`truncate ${names} restart identity cascade`);
}
