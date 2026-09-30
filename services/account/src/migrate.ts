import { migrateAccount } from '../../../scripts/ops/migrate.ts';

console.log(JSON.stringify({ applied: await migrateAccount(process.env) }));
