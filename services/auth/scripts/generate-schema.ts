import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { betterAuthSchemaOptions } from '../src/better-auth.ts';

// Use a fresh, separate Auth database to regenerate the Better Auth baseline.
const url = process.env.AUTH_DATABASE_URL;
if (!url) throw new Error('Set AUTH_DATABASE_URL to an empty separate Auth database');
const database = new Pool({ connectionString: url });
try {
  const plan = await getMigrations(
    betterAuthSchemaOptions(database, 'https://auth.invalid', 'schema-generation-only-secret-32-bytes'),
  );
  console.log(await plan.compileMigrations());
} finally {
  await database.end();
}
