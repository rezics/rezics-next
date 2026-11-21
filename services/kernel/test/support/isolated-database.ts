import { Pool } from 'pg';
import { dropTestDatabase } from './drop-test-database.ts';

/** Clone the migrated fixture without connecting to its source or leaving a live session on it. */
export async function openIsolatedDatabase() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated Kernel test database');
  const url = new URL(process.env.DATABASE_URL);
  const template = decodeURIComponent(url.pathname.slice(1));
  if (!template) throw new Error('DATABASE_URL must name the migrated Kernel test database');
  const name = `kernel_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const postgres = new URL(url);
  postgres.pathname = '/postgres';
  const admin = new Pool({ connectionString: postgres.href, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template.replaceAll('"', '""')}"`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  url.pathname = `/${name}`;
  return {
    url: url.href,
    admin,
    async close() {
      try {
        await dropTestDatabase(admin, name);
      } finally {
        await admin.end();
      }
    },
  };
}
