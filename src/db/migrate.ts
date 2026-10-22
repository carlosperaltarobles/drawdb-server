import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';

const migrationsDir = path.resolve(__dirname, '../../migrations');
const LOCK_ID = 727274;

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      `create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`,
    );
    const { rows } = await client.query<{ name: string }>('select name from schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
