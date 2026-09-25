import { Pool } from 'pg';
import { AccessAdmissionRegistry } from './modules/access/admission.ts';

const databaseUrl = Bun.env.ACCESS_DATABASE_URL;
if (!databaseUrl || process.argv.length !== 2) {
  throw new Error('usage: ACCESS_DATABASE_URL=<Access owner URL> yarn access:pending-search');
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const rows = await new AccessAdmissionRegistry(pool).unresolvedContributionSearchDeliveries();
  console.log(JSON.stringify({ kind: 'unresolved-private-search-deliveries',
    sampleLimit: 100, rows }));
} finally {
  await pool.end();
}
