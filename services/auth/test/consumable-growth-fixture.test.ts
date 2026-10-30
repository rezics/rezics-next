import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';
import { AUTH_MAINTENANCE_SCHEDULE, AUTH_SYSTEM_SCHEMA, registerAuthMaintenance } from '../src/maintenance.ts';
import { AUTH_WORKFLOW_APPLICATION, WORKFLOW_RETENTION_SCHEDULE } from '../src/retention.ts';
import { pruneExpiredProtocolState } from '../src/protocol-maintenance.ts';
import { websiteMaintenanceModule, WEBSITE_MAINTENANCE_WORKFLOW } from '../src/website-maintenance.ts';
import { composeWork } from '../../kernel/src/work/registry.ts';
import { createWorkClient } from '../../kernel/src/work/client.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';
import { consumableGrowth, prepareMaintenanceTarget, protocolRows, protocolTables } from './support/consumable-growth.ts';

const child = process.argv.find((arg) => arg.startsWith('--consumable-child='))?.split('=')[1];
if (child) {
  const db = await openGrowthDatabase(process.env.CONSUMABLE_DATABASE_URL!);
  try {
    await nativeFixture(db, child === 'website');
  } finally {
    await db.close();
  }
} else {
  for (const kind of ['auth', 'website'])
    test(`${kind} full native targets survive extra warmup, adaptive repetitions and workflow replay`, async () => {
      const fixture = testDatabase();
      try {
        const runner = Bun.spawn([process.execPath, import.meta.path, `--consumable-child=${kind}`], {
          env: { ...process.env, CONSUMABLE_DATABASE_URL: fixture.url },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
          new Response(runner.stdout).text(), new Response(runner.stderr).text(), runner.exited,
        ]);
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
        expect(code).toBe(0);
      } finally { fixture.close(); }
    }, 240000);
}

async function completed(db: GrowthDatabase, schema: string, id: string) {
  const deadline = Date.now() + 60000;
  while (true) {
    const status = (await db.admin.query(`SELECT status FROM ${schema}.workflow_status WHERE workflow_uuid=$1`, [id])).rows[0]?.status;
    if (['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(status)) return;
    if (Date.now() > deadline) throw new Error(`Native fixture workflow did not complete: ${id}`);
    await Bun.sleep(10);
  }
}

async function nativeFixture(db: GrowthDatabase, website: boolean) {
  // Later-expiring backlog and live state must survive every selected full batch.
  await db.admin.query(`INSERT INTO "user" (id,name,"emailVerified")
    SELECT 'history-'||i,'',false FROM generate_series(1,1000) i;
    INSERT INTO auth_client (client_id,first_party,scopes)
    SELECT 'history-'||i,true,ARRAY['read'] FROM generate_series(1,1000) i;
    INSERT INTO auth_consent (account_id,client_id,scopes)
    SELECT 'history-'||i,'history-1',ARRAY['read'] FROM generate_series(1,1000) i;
    INSERT INTO auth_consent_erasure (account_id,due_at)
    SELECT 'history-'||i,'2099-01-01' FROM generate_series(1,1000) i;
    INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
    SELECT 'history-'||i,'history-'||i,'history-'||i,'history-'||i,'2099-01-01',now(),'read',1,1,'pwd' FROM generate_series(1,1000) i;
    INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
    SELECT 'backlog-'||i,'backlog-'||i,'history-'||i,'history-'||i,'2000-01-01',now(),'read',1,1,'pwd' FROM generate_series(1,1000) i;
    INSERT INTO verification (id,identifier,value,"expiresAt")
    SELECT 'history-'||i,'history-'||i,'sentinel','2099-01-01' FROM generate_series(1,1000) i;
    INSERT INTO verification (id,identifier,value,"expiresAt")
    SELECT 'backlog-'||i,'backlog-'||i,'sentinel','2000-01-01' FROM generate_series(1,1000) i;`);
  const system = db.openPool({ max: 8 });
  let dispatch: (id: string) => Promise<void>;
  let shutdown: () => Promise<void>;
  let schema: string;
  if (website) {
    await db.admin.query(`INSERT INTO "user" (id,name,"emailVerified") VALUES ('protocol-hot','',false),('protocol-other','',false);
      INSERT INTO auth_client (client_id,first_party,scopes) VALUES ('protocol-hot',true,ARRAY['read']),('protocol-other',true,ARRAY['read'])`);
    await protocolRows(db, 'backlog-', 1, 1000, new Date('2000-01-01'));
    await protocolRows(db, 'live-', 1, 1000, new Date('2099-01-01'));
    await DBOS.migrate(db.url);
    const client = await createWorkClient(db.url, system);
    const work = await composeWork([websiteMaintenanceModule({ pruneExpiredProtocolState: (batch) => pruneExpiredProtocolState(db.pool, batch) })], { databaseUrl: db.url, pool: system, client });
    await client.pauseSchedule(WEBSITE_MAINTENANCE_WORKFLOW);
    await work.launch();
    schema = 'dbos';
    dispatch = async (id) => {
      const handle = await client.enqueue({ workflowName: WEBSITE_MAINTENANCE_WORKFLOW, queueName: 'maintenance', workflowID: id }, new Date(0), null);
      await completed(db, schema, id);
      expect(await handle.getResult()).toBe(5000);
    };
    shutdown = async () => { await work.shutdown(); await client.close(); };
  } else {
    const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: 'current' };
    const auth = await createAuthService({ database: db.pool, issuer: 'https://fixture.auth.test', audience: 'https://fixture.api.test', secret: 'consumable-native-fixture-secret-at-least-32-bytes', signing: { activeKid: key.kid, privateKeys: [key] }, trustedAccess: trustedAccessPorts({ readAccount: async () => null, authorizeProvisioning: async () => { throw new Error('Not used'); } }) });
    DBOS.setConfig({ name: AUTH_WORKFLOW_APPLICATION, systemDatabaseUrl: db.url, systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA, systemDatabasePool: system, logLevel: 'warn' });
    const maintenance = registerAuthMaintenance(auth);
    await DBOS.launch();
    await maintenance.start('0 0 1 1 *');
    await DBOS.pauseSchedule(AUTH_MAINTENANCE_SCHEDULE);
    await DBOS.pauseSchedule(WORKFLOW_RETENTION_SCHEDULE);
    schema = AUTH_SYSTEM_SCHEMA;
    const schedule = (await DBOS.getSchedule(AUTH_MAINTENANCE_SCHEDULE))!;
    expect(schedule.queueName).toBe(AUTH_MAINTENANCE_SCHEDULE);
    dispatch = async (id) => {
      const handle = await DBOS.enqueueWorkflowWithOptions({ workflowName: schedule.workflowName, queueName: schedule.queueName!, workflowID: id }, new Date(0), schedule.context);
      await completed(db, schema, id);
      await handle.getResult();
    };
    shutdown = () => DBOS.shutdown();
  }
  const tables = website ? protocolTables.map((table) => [table, table === 'auth_recent_oidc_session' ? 'session_id' : 'id'] as const) : [
    ['auth_consent', 'account_id'], ['auth_consent_erasure', 'account_id'], ['session', 'id'], ['verification', 'id'],
  ] as const;
  async function counts(tag: string) {
    return Promise.all(tables.map(async ([table, key]) => (await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${key} LIKE $1`, [`${tag}%`])).rows[0].n as number));
  }
  const setup = (database: GrowthDatabase, _scale: number, id: string) => website ? protocolRows(database, `${id}-`, 1, 1000, new Date('1990-01-01')) : prepareMaintenanceTarget(database, id, 'history-', 16);
  const full = website ? [1000,1000,1000,1000,1000] : [1600,100,1000,1000];
  const targets = consumableGrowth({ name: 'fixture', setup, async run(_database, _scale, id) {
    expect(await counts(`${id}-`)).toEqual(full);
    await dispatch(id);
    expect(await counts(`${id}-`)).toEqual(full.map(() => 0));
    const outputs = (await db.admin.query(`SELECT output FROM ${schema}.operation_outputs WHERE workflow_uuid=$1 ORDER BY function_id`, [id])).rows;
    expect(outputs.map((row) => JSON.parse(row.output).json)).toEqual(website ? [5000] : [1000,0,1000,100]);
    expect(await counts(website ? 'live-' : 'history-')).toEqual(website ? [1000,1000,1000,1000,1000] : [1000,1000,1000,1000]);
    expect(await counts('backlog-')).toEqual(website ? [1000,1000,1000,1000,1000] : [0,0,1000,1000]);
  } });
  try {
    await expect(targets.hooks.operation(db, 1, 0)).rejects.toThrow('Fresh native target required');
    // Two explicit warm-ups, followed by seven physical measured invocations:
    // beyond the former repetitions+1 allocation, with a repeated caller index.
    await targets.hooks.warmup(db, 1, 0);
    await targets.hooks.warmup(db, 1, 1);
    for (let repetition = 2; repetition < 9; repetition++) {
      await targets.hooks.prepare(db, 1, repetition);
      await expect(targets.hooks.warmup(db, 1, repetition)).rejects.toThrow('Warmup cannot consume a measured target');
      await targets.hooks.operation(db, 1, repetition);
      await expect(targets.hooks.operation(db, 1, repetition)).rejects.toThrow('Fresh native target required');
    }
    await targets.hooks.prepare(db, 1, 2);
    await targets.hooks.operation(db, 1, 2);
    expect(new Set(targets.invocations.map(({ id }) => id)).size).toBe(10);
    expect(targets.invocations.filter(({ kind }) => kind === 'measured')).toHaveLength(8);
    // Native DBOS replay returns its old result without doing new physical work.
    // A fresh invocation must use a new workflow ID as well as a fresh cohort.
    const replayTarget = 'replay-target';
    await setup(db, 1, replayTarget);
    await dispatch(targets.invocations[2]!.id);
    expect(await counts(`${replayTarget}-`)).toEqual(full);
    await dispatch('fresh-after-replay');
    expect(await counts(`${replayTarget}-`)).toEqual(full.map(() => 0));
    const completedRuns = (await db.admin.query(`SELECT count(*)::int AS n FROM ${schema}.workflow_status WHERE status='SUCCESS' AND (workflow_uuid LIKE 'fixture-%' OR workflow_uuid='fresh-after-replay')`)).rows[0].n;
    expect(completedRuns).toBe(11);
    expect(await counts('fixture-')).toEqual(full.map(() => 0));
  } finally { await shutdown(); }
}
