import { getPool } from './pool';
import { migrate } from './migrate';

const pool = getPool();
migrate(pool)
  .then(() => console.log('Migrations applied'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
