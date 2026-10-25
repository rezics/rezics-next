import { resolve } from 'node:path';
import { run, testDatabase } from './database.ts';

const database = testDatabase();
try {
  const env = { ...process.env, AUTH_TEST_DATABASE_URL: database.url };
  run(resolve('../../node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json'], env);
  run(resolve('../../node_modules/.bin/oxlint'), ['--config', '../../.oxlintrc.json', '.'], env);
  run(resolve('../../node_modules/.bin/oxfmt'), ['--check', '.'], env);
  console.log(run('bun', ['test'], env));
} finally {
  database.close();
}
