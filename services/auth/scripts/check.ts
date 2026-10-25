import { resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { prepareCompilerDatabase } from '../../../scripts/compiler-database.ts';
import { betterAuthSchemaOptions } from '../src/better-auth.ts';
import { migrate, run, schemaDump, testDatabase } from './database.ts';

const database = testDatabase();
try {
  migrate(database.url);
  if (schemaDump(database.url, database) !== (await Bun.file('db/schema.sql').text())) {
    throw new Error('Auth schema dump differs; run db dump against a freshly migrated separate database');
  }
  const pool = new Pool({ connectionString: database.url });
  try {
    const plan = await getMigrations(
      betterAuthSchemaOptions(pool, 'https://auth.invalid', 'schema-verification-only-secret-32-bytes'),
    );
    if (
      plan.toBeCreated.length ||
      plan.toBeAdded.length ||
      plan.toBeAddedIndexes.length ||
      plan.unsafeChanges.length ||
      plan.schemaProblems.length
    ) {
      throw new Error('Committed schema differs from the installed Better Auth schema');
    }
  } finally {
    await pool.end();
  }
  const env = { ...process.env, AUTH_TEST_DATABASE_URL: database.url };
  const compilerDatabase = await prepareCompilerDatabase();
  try {
    run(resolve('../../node_modules/.bin/tsc'), ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], {
      ...env,
      DATABASE_URL: compilerDatabase.url,
    });
  } finally {
    await compilerDatabase.remove();
  }
  run(resolve('../../node_modules/.bin/oxlint'), ['--config', '../../.oxlintrc.json', '.'], env);
  run(resolve('../../node_modules/.bin/oxfmt'), ['--check', '.'], env);
  const tests = Bun.spawn(['bun', 'test'], { env, stdout: 'inherit', stderr: 'inherit' });
  const code = await tests.exited;
  if (code !== 0) throw new Error(`Auth tests failed with exit code ${code}`);
} finally {
  database.close();
}
