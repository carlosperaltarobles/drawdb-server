import { execFileSync } from 'child_process';
import { TEST_DATABASE_URL } from './helpers/db';

export default function setup(): void {
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
      stdio: 'pipe',
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    // Also printed directly: vitest 5 can crash while formatting globalSetup errors.
    process.stderr.write(stderr);
    throw new Error(`prisma migrate deploy failed on the test database:\n${stderr}`);
  }
}
