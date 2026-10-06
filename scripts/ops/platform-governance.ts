import { Pool } from 'pg';
import {
  assertPlatformGovernance,
  PLATFORM_GOVERNANCE_COST,
} from '../../services/main/src/modules/access/platform-governance.ts';
import { readProductionEnv } from './production-env.ts';

export async function checkPlatformGovernance(
  url: string,
  warn: (message: string) => void = console.warn,
): Promise<1 | 2> {
  if (!url) throw new Error('Platform governance verification requires ACCESS_DATABASE_URL');
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: PLATFORM_GOVERNANCE_COST.statementMs,
  });
  try {
    const holders = await assertPlatformGovernance(pool);
    if (holders === 1)
      warn(
        'Only one active permanent platform:grant holder; grant a second holder through the ordinary Access grant API',
      );
    return holders;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('ops:platform-governance requires an environment file');
  const env = readProductionEnv(path);
  const holders = await checkPlatformGovernance(env.ACCESS_DATABASE_URL!);
  console.log(
    `Platform governance verified: ${holders === 2 ? 'at least two' : 'one'} active permanent platform:grant holder${holders === 2 ? 's' : ''}`,
  );
}
