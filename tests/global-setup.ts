import { execFileSync } from 'child_process';
import { TEST_DATABASE_URL } from './helpers/db';

export default function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  });
}
