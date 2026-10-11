import { resolve } from 'node:path';
import { readEnv } from '../dev/config.ts';
import { assertOwnerMigrationsComplete, migrateOwnerData } from '../fixture/migrate.ts';

const root = resolve(import.meta.dir, '../..');
const environmentFile = process.argv[2];
if (!environmentFile) throw new Error('A restored QA apps.env path is required');

// QA bootstrap already applies owner SQL migrations before the corpus is built.
// Copies carry those schemas, so restore only the idempotent owner data migrations.
const evidence = await migrateOwnerData(readEnv(resolve(root, environmentFile)));
assertOwnerMigrationsComplete(evidence);
console.log('Restored corpus owner data migrations complete');
