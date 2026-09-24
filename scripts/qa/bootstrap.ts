import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';

const root = join(import.meta.dir, '../..');
const apps = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Record<string, string>;
const ownerUrls = {
  account: apps.ACCOUNT_DATABASE_URL,
  access: apps.ACCESS_DATABASE_URL,
  relay: apps.ACCOUNT_RELAY_DATABASE_URL,
};

for (const [owner, dir] of [
  ['access', 'services/main/migrations/access'],
  ['relay', 'services/main/migrations/relay'],
] as const) {
  const db = new Client({ connectionString: ownerUrls[owner] });
  await db.connect();
  try {
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: join(root, dir) })].sort()) {
      await db.query(readFileSync(join(root, dir, file), 'utf8'));
    }
  } finally { await db.end(); }
}

const accountMigration = Bun.spawnSync(['bun', 'services/account/src/migrate.ts'], {
  cwd: root, env: { ...process.env, ...apps }, stdout: 'pipe', stderr: 'pipe',
});
if (accountMigration.exitCode !== 0) {
  throw new Error(`Account migration failed: ${accountMigration.stderr.toString()}`);
}

const compose = JSON.parse(readFileSync(process.argv[3], 'utf8')) as Record<string, string>;
const admin = new Client({ connectionString:
  `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres` });
await admin.connect();
try {
  for (const owner of ['account', 'access', 'content', 'relay']) {
    // The source database has no remaining open connection after migrations.
    await admin.query(`CREATE DATABASE ${owner}_tpl WITH TEMPLATE ${owner} OWNER ${owner}`);
  }
} finally { await admin.end(); }

await initializeFreshGraph(new FusekiClient(apps.FUSEKI_URL), {
  dataEpoch: apps.MAIN_DATA_EPOCH, routingEpoch: apps.MAIN_ROUTING_EPOCH,
});
console.log('QA owner templates and Fuseki graph initialized');
