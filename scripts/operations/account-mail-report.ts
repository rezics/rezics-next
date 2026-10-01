import { Pool } from 'pg';
import { accountMailReport } from '../../services/account/src/mail-suppression.ts';

if (!process.env.ACCOUNT_DATABASE_URL) throw new Error('ACCOUNT_DATABASE_URL is required');
const pool = new Pool({
  connectionString: process.env.ACCOUNT_DATABASE_URL,
  connectionTimeoutMillis: 5_000,
});
try {
  console.log(JSON.stringify(await accountMailReport(pool), null, 2));
} finally {
  await pool.end();
}
