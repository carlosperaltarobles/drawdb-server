import type { Pool } from 'pg';

// Implemented in Task 4.
export async function ensureSuperadmin(
  _pool: Pool,
  _admin: { email: string; password: string },
): Promise<void> {}
