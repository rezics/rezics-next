import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readEnv, replacePrivate } from '../dev/config.ts';
import { compareMigrationPaths } from '../lib/migration-order.ts';
import { applySqlMigration, sqlMigration } from '../lib/concurrent-index.ts';
import { Client } from 'pg';
import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { initializeFreshGraph } from '../../services/main/src/modules/work/activate.ts';
import { expectedFusekiModuleVersion } from './core.ts';

const root = join(import.meta.dir, '../..');
const apps = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Record<string, string>;
const ownerUrls = {
  account: apps.ACCOUNT_DATABASE_URL,
  access: apps.ACCESS_DATABASE_URL,
  relay: apps.ACCOUNT_RELAY_DATABASE_URL,
};

async function migrateOwner(owner: 'access' | 'relay', dir: string) {
  const db = new Client({ connectionString: ownerUrls[owner] });
  await db.connect();
  try {
    for (const file of [...new Bun.Glob('*.sql').scanSync({ cwd: join(root, dir) })].sort(compareMigrationPaths)) {
      await applySqlMigration(db, sqlMigration(readFileSync(join(root, dir, file), 'utf8'), file));
    }
  } finally { await db.end(); }
}

async function migrateAccount() {
  const migration = Bun.spawn(['bun', 'services/account/src/migrate.ts'], {
    cwd: root, env: { ...process.env, ...apps }, stdout: 'ignore', stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([migration.exited, new Response(migration.stderr).text()]);
  if (code !== 0) throw new Error(`Account migration failed: ${stderr}`);
}

async function initializeGraph() {
  const fuseki = new FusekiClient(apps.FUSEKI_URL, apps.FUSEKI_MAINTENANCE_TOKEN,
    apps.FUSEKI_COMMAND_TOKEN);
  const moduleHealth = await fuseki.commandHealth();
  const expectedModuleVersion = expectedFusekiModuleVersion(
    readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8'));
  if (moduleHealth.moduleVersion !== expectedModuleVersion) {
    throw new Error(`Fuseki command module ${moduleHealth.moduleVersion} differs from Compose pin ${expectedModuleVersion}`);
  }
  await initializeFreshGraph(fuseki, {
    dataEpoch: apps.MAIN_DATA_EPOCH, routingEpoch: apps.MAIN_ROUTING_EPOCH,
  });
}

// Independent owners prepare together; each SQL owner's migrations remain ordered.
// Wait for every connection/process before cloning the consistent templates.
const prepared = await Promise.allSettled([
  migrateOwner('access', 'services/main/migrations/access'),
  migrateOwner('relay', 'services/main/migrations/relay'), migrateAccount(), initializeGraph(),
]);
const failures = prepared.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'QA owner bootstrap failed');

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

// The runner snapshots apps.env before this process starts. In-process Main
// reads the variable from this file when its own environment does not set it.
// Production preflight refuses the same variable.
const stackEnv = join(dirname(process.argv[2]!), 'apps.env');
const savedApps = readEnv(stackEnv);
if (savedApps.REZICS_PLATFORM_OPEN_GROUPS !== '*') {
  replacePrivate(stackEnv, { ...savedApps, REZICS_PLATFORM_OPEN_GROUPS: '*' });
}

console.log('QA owner templates and Fuseki graph initialized');
