import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { serializeSignedCookie } from 'better-call';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthService } from '../src/index.ts';
import { AUTH_MAINTENANCE_SCHEDULE, AUTH_SYSTEM_SCHEMA, registerAuthMaintenance } from '../src/maintenance.ts';
import { AUTH_WORKFLOW_APPLICATION, WORKFLOW_RETENTION_SCHEDULE } from '../src/retention.ts';
import { websiteMaintenanceModule, WEBSITE_MAINTENANCE_WORKFLOW } from '../src/website-maintenance.ts';
import { pruneExpiredProtocolState } from '../src/protocol-maintenance.ts';
import { composeWork } from '../../kernel/src/work/registry.ts';
import { createWorkClient } from '../../kernel/src/work/client.ts';
import {
  checkGrowth,
  GrowthBoundError,
  openGrowthDatabase,
  type GrowthCheck,
  type GrowthDatabase,
  type GrowthSample,
} from '../../kernel/test/support/growth.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';
import {
  consumableGrowth,
  prepareMaintenanceTarget,
  protocolRows,
  protocolTables,
} from './support/consumable-growth.ts';

const issuer = 'https://growth-revoke.auth.test';
const secret = 'growth-revoke-maintenance-secret-at-least-32-bytes';
const repetitions = 3;
const fixed = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;

async function makeAuth(db: GrowthDatabase): Promise<AuthService> {
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'current',
  };
  return createAuthService({
    database: db.pool,
    issuer,
    audience: 'https://growth-revoke.api.test',
    secret,
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      readAccount: async (accountId) => ({
        accountId,
        kind: 'actor',
        state: 'active',
        automated: false,
        authnEpoch: 1,
      }),
      authorizeProvisioning: async () => {
        throw new Error('Not used');
      },
    }),
  });
}

// Every growing relation in the proof/client/consent plans starts with a full
// representative population. Reductions belong to other clients, never the probe.
async function authHistory(db: GrowthDatabase, tag: string, from: number, to: number) {
  const range = [tag, from, to];
  await db.admin.query(
    `INSERT INTO "user" (id,name,"emailVerified")
    SELECT $1||i,'',false FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_client (client_id,first_party,scopes)
    SELECT $1||i,true,ARRAY['read'] FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_client_coverage (client_id,ready)
    SELECT $1||i,true FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_client_reduction (client_id,operation_id,scopes,first_party)
    SELECT $1||i,$1||i,ARRAY['read'],true FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO auth_consent (account_id,client_id,scopes)
    SELECT $1||i,$1||i,ARRAY['read'] FROM generate_series($2::int,$3::int) i`,
    range,
  );
  await db.admin.query(
    `INSERT INTO session
    (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
    SELECT $1||i,$1||i,$1||i,$1||i,'2099-01-01',now(),'read',1,1,'pwd'
    FROM generate_series($2::int,$3::int) i`,
    range,
  );
}

function series(samples: readonly GrowthSample[]) {
  return samples.map(({ scale, cost }) => ({
    scale,
    rows: cost.rows,
    blocks: cost.blocks,
    statements: cost.statements,
  }));
}

// Failure evidence comes from the original measured series; no extra destructive capture.
async function growth(db: GrowthDatabase, check: GrowthCheck) {
  try {
    const report = await checkGrowth(db, { repetitions, ...check });
    console.log(JSON.stringify({ name: report.name, bounds: report.bounds, samples: series(report.samples) }));
    return report;
  } catch (error) {
    if (error instanceof GrowthBoundError)
      console.error(JSON.stringify({ name: check.name, error: error.message, samples: error.samples }));
    throw error;
  }
}

async function revokeGrowth(db: GrowthDatabase) {
  const auth = await makeAuth(db);
  await auth.internal.registerClient({ clientId: 'probe', firstParty: true, scopes: ['read'] });
  await auth.internal.registerClient({ clientId: 'other', firstParty: true, scopes: ['read'] });
  const targets = consumableGrowth({
    name: 'revoke',
    async setup(_database, scale, owner) {
      const connection = await db.admin.connect();
      try {
        await connection.query('BEGIN');
        // This is pre-upgrade history, as in the existing bounded-session check.
        // Restore the capacity trigger before any production operation executes.
        await connection.query('ALTER TABLE session DISABLE TRIGGER session_capacity');
        {
          await connection.query(
            `INSERT INTO "user" (id,name,"emailVerified",sessions_bounded) VALUES ($1,'',false,false)`,
            [owner],
          );
          await connection.query(
            `INSERT INTO session
            (id,token,"userId","clientId","expiresAt","createdAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
            SELECT $1||'-live-'||i,$1||'-live-'||i,$1,'probe','2099-01-01',now(),now(),'read',1,
              floor(extract(epoch FROM now()))::int,'pwd' FROM generate_series(1,64) i`,
            [owner],
          );
          await connection.query(
            `INSERT INTO session
            (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
            SELECT $1||'-expired-'||i,$1||'-expired-'||i,$1,CASE WHEN i%2=0 THEN 'probe' ELSE 'other' END,
              '2000-01-01',now(),'read',1,1,'pwd' FROM generate_series(1,$2::int) i`,
            [owner, scale * 1000],
          );
        }
        await connection.query('ALTER TABLE session ENABLE TRIGGER session_capacity');
        await connection.query('COMMIT');
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
    async run(_database, _scale, owner) {
      const id = `${owner}-live-1`;
      const cookie = (await serializeSignedCookie('__Secure-better-auth.session_token', id, secret)).split(';')[0]!;
      const response = await auth.handler(
        new Request(`${issuer}/sessions/revoke`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json', cookie },
          body: JSON.stringify({ session_id: id }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
      expect(response.headers.getSetCookie().filter((value) => value.includes('Max-Age=0'))).toHaveLength(3);
      expect((await db.admin.query('SELECT id FROM session WHERE id=$1', [id])).rowCount).toBe(0);
      expect(
        (
          await db.admin.query(`SELECT count(*)::int AS n FROM session WHERE "userId"=$1 AND "expiresAt">now()`, [
            owner,
          ])
        ).rows[0].n,
      ).toBe(63);
    },
  });
  const report = await growth(db, {
    name: 'session revoke with native human proof and exact owner deletion',
    // R/S=O(1): token/user/client/consent point reads, owner read and delete.
    // Blocks are O(log N), including expired history belonging to this owner.
    bounds: fixed,
    async grow(_, scale, previous) {
      await authHistory(db, 'unrelated-', previous * 1000 + 1, scale * 1000);
    },
    ...targets.hooks,
  });
  for (const sample of report.samples)
    for (const cost of [sample.cost, ...sample.repetitions]) {
      expect(cost.statements).toBeGreaterThanOrEqual(5);
      expect(cost.rows).toBeLessThanOrEqual(32);
      for (const table of [
        'session',
        'user',
        'auth_client',
        'auth_client_coverage',
        'auth_client_reduction',
        'auth_consent',
      ])
        expect(cost.relations[`public.${table}`]?.sequentialScans ?? 0).toBe(0);
    }
}

async function durableHistory(
  db: GrowthDatabase,
  schema: string,
  queue: string,
  tag: string,
  from: number,
  to: number,
) {
  await db.admin.query(
    `WITH inserted AS (
    INSERT INTO ${schema}.workflow_status
      (workflow_uuid,status,name,queue_name,authenticated_roles,recovery_attempts,created_at,updated_at,inputs,queue_partition_key,serialization)
    SELECT $1||i,'SUCCESS','history',CASE WHEN i%2=0 THEN $4 ELSE 'other-queue' END,'[]',0,i,i,'[]',
      CASE WHEN i%2=0 THEN 'hot' ELSE 'other-'||i END,'JSON' FROM generate_series($2::int,$3::int) i
    RETURNING workflow_uuid
  ), inputs AS (
    INSERT INTO ${schema}.workflow_input (workflow_uuid,inputs) SELECT workflow_uuid,'[]' FROM inserted
  ), outputs AS (
    INSERT INTO ${schema}.workflow_output (workflow_uuid,output,error) SELECT workflow_uuid,'null','' FROM inserted
  ) INSERT INTO ${schema}.operation_outputs (workflow_uuid,function_id,function_name,output,error)
    SELECT workflow_uuid,1,'history','null','' FROM inserted`,
    [tag, from, to, queue],
  );
}

async function completed(db: GrowthDatabase, schema: string, workflowID: string) {
  // Synchronize the fixture through the uncaptured admin pool. Repeated SDK
  // result polling would measure elapsed execution time instead of tick work.
  // The native runner and its step/output persistence remain captured; callers
  // then perform exactly one native result read, including error propagation.
  while (true) {
    const result = await db.admin.query(`SELECT status FROM ${schema}.workflow_status WHERE workflow_uuid=$1`, [
      workflowID,
    ]);
    if (['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'].includes(result.rows[0]?.status)) return;
    await Bun.sleep(10);
  }
}

async function maintenanceGrowth(db: GrowthDatabase) {
  const auth = await makeAuth(db);
  const system = db.openPool({ max: 8 });
  DBOS.setConfig({
    name: AUTH_WORKFLOW_APPLICATION,
    systemDatabaseUrl: db.url,
    systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA,
    systemDatabasePool: system,
    logLevel: 'warn',
  });
  const maintenance = registerAuthMaintenance(auth);
  try {
    await DBOS.launch();
    await maintenance.start('0 0 1 1 *');
    await DBOS.pauseSchedule(AUTH_MAINTENANCE_SCHEDULE);
    await DBOS.pauseSchedule(WORKFLOW_RETENTION_SCHEDULE);
    for (const axis of ['history', 'clients'] as const) {
      const scales = axis === 'history' ? ([1, 8, 64] as const) : ([1, 4, 16] as const);
      const targets = consumableGrowth({
        name: `maintenance-${axis}`,
        setup: (database, scale, id) =>
          prepareMaintenanceTarget(database, id, `${axis}-history-`, axis === 'history' ? 16 : scale),
        async run(_database, scale, id) {
          // Dispatch the registered schedule's native workflow with a fresh
          // explicit ID. Automatic schedule IDs are background in the harness.
          const schedule = (await DBOS.getSchedule(AUTH_MAINTENANCE_SCHEDULE))!;
          expect(schedule.workflowName).toBe('auth.maintenance.tick');
          expect(schedule.queueName).toBe(AUTH_MAINTENANCE_SCHEDULE);
          const tick = await DBOS.enqueueWorkflowWithOptions(
            {
              workflowName: schedule.workflowName,
              queueName: schedule.queueName!,
              workflowID: id,
            },
            new Date(0),
            schedule.context,
          );
          await completed(db, AUTH_SYSTEM_SCHEMA, tick.workflowID);
          await tick.getResult();
          const outputs = (
            await db.admin.query(
              `SELECT output FROM ${AUTH_SYSTEM_SCHEMA}.operation_outputs WHERE workflow_uuid=$1 ORDER BY function_id`,
              [tick.workflowID],
            )
          ).rows;
          expect(outputs.map((row) => JSON.parse(row.output).json)).toEqual([1000, 0, 1000, 100]);
          const tag = `${id}-%`;
          expect(
            (await db.admin.query('SELECT account_id FROM auth_consent WHERE account_id LIKE $1', [tag])).rowCount,
          ).toBe(0);
          expect(
            (await db.admin.query('SELECT account_id FROM auth_consent_erasure WHERE account_id LIKE $1', [tag]))
              .rowCount,
          ).toBe(0);
          expect((await db.admin.query('SELECT id FROM session WHERE id LIKE $1', [tag])).rowCount).toBe(0);
          expect((await db.admin.query('SELECT id FROM verification WHERE id LIKE $1', [tag])).rowCount).toBe(0);
          for (const [table, key, count] of [
            ['auth_consent', 'account_id', scale * 1000],
            ['auth_consent_erasure', 'account_id', scale * 1000],
            ['session', 'id', scale * 2000],
            ['verification', 'id', scale * 2000],
          ] as const)
            expect(
              (
                await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${key} LIKE $1`, [
                  `${axis}-history-%`,
                ])
              ).rows[0].n,
            ).toBe(count);
        },
      });
      const report = await growth(db, {
        name: `due consent native maintenance tick: ${axis}`,
        scales,
        // B=100 owners; C is fixed at 16 for history and grows with the client axis.
        // Erasure performs 3+2C statements per owner: R/S=O(B*C),
        // blocks O(B*C*log N). With B,C fixed only indexed blocks may grow.
        bounds: axis === 'history' ? fixed : { rows: 'linear', blocks: 'linear', statements: 'linear' },
        async grow(_, scale, previous) {
          await authHistory(db, `${axis}-history-`, previous * 1000 + 1, scale * 1000);
          await durableHistory(
            db,
            AUTH_SYSTEM_SCHEMA,
            AUTH_MAINTENANCE_SCHEDULE,
            `${axis}-durable-`,
            previous * 1000 + 1,
            scale * 1000,
          );
          await db.admin.query(
            `INSERT INTO auth_consent_erasure (account_id,due_at)
            SELECT $1||i,'2099-01-01' FROM generate_series($2::int,$3::int) i`,
            [`${axis}-history-`, previous * 1000 + 1, scale * 1000],
          );
          await db.admin.query(
            `INSERT INTO verification (id,identifier,value,"expiresAt")
            SELECT $1||i,$1||i,'history','2099-01-01' FROM generate_series($2::int,$3::int) i`,
            [`${axis}-history-`, previous * 1000 + 1, scale * 1000],
          );
          // Growing expired backlogs use different keys and later expiry than the
          // admitted cohorts; they also include the same owners as live history.
          await db.admin.query(
            `INSERT INTO session
            (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
            SELECT $1||'expired-'||i,$1||'expired-'||i,$1||i,$1||i,'2000-01-01',now(),'read',1,1,'pwd'
            FROM generate_series($2::int,$3::int) i`,
            [`${axis}-history-`, previous * 1000 + 1, scale * 1000],
          );
          await db.admin.query(
            `INSERT INTO verification (id,identifier,value,"expiresAt")
            SELECT $1||'expired-'||i,$1||i,'history','2000-01-01' FROM generate_series($2::int,$3::int) i`,
            [`${axis}-history-`, previous * 1000 + 1, scale * 1000],
          );
        },
        ...targets.hooks,
      });
      for (const sample of report.samples)
        for (const cost of [sample.cost, ...sample.repetitions]) {
          expect(cost.relations['public.auth_consent']!.rows).toBeGreaterThanOrEqual(100);
          expect(cost.relations[`${AUTH_SYSTEM_SCHEMA}.operation_outputs`]!.nodes).toBeGreaterThan(0);
        }
    }
  } finally {
    await DBOS.shutdown();
  }
}

async function websiteGrowth(db: GrowthDatabase) {
  await DBOS.migrate(db.url);
  const system = db.openPool({ max: 8 });
  const client = await createWorkClient(db.url, system);
  const work = await composeWork(
    [
      websiteMaintenanceModule({
        pruneExpiredProtocolState: (batch) => pruneExpiredProtocolState(db.pool, batch),
      }),
    ],
    { databaseUrl: db.url, pool: system, client },
  );
  try {
    await client.pauseSchedule(WEBSITE_MAINTENANCE_WORKFLOW);
    await db.admin
      .query(`INSERT INTO "user" (id,name,"emailVerified") VALUES ('protocol-hot','',false),('protocol-other','',false);
      INSERT INTO auth_client (client_id,first_party,scopes) VALUES ('protocol-hot',true,ARRAY['read']),('protocol-other',true,ARRAY['read'])`);
    await work.launch();
    const targets = consumableGrowth({
      name: 'website-probe',
      setup: (database, _scale, id) => protocolRows(database, `${id}-`, 1, 1000, new Date('1990-01-01')),
      async run(_database, scale, id) {
        const handle = await client.enqueue(
          { workflowName: WEBSITE_MAINTENANCE_WORKFLOW, queueName: 'maintenance', workflowID: id },
          new Date(0),
          null,
        );
        await completed(db, 'dbos', handle.workflowID);
        expect(await handle.getResult()).toBe(5000);
        const outputs = (
          await db.admin.query('SELECT output FROM dbos.operation_outputs WHERE workflow_uuid=$1', [handle.workflowID])
        ).rows;
        expect(outputs.map((row) => JSON.parse(row.output).json)).toEqual([5000]);
        for (const table of protocolTables) {
          const key = table === 'auth_recent_oidc_session' ? 'session_id' : 'id';
          expect((await db.admin.query(`SELECT ${key} FROM ${table} WHERE ${key} LIKE $1`, [`${id}-%`])).rowCount).toBe(
            0,
          );
          for (const prefix of ['expired-', 'live-'])
            expect(
              (await db.admin.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${key} LIKE $1`, [`${prefix}%`]))
                .rows[0].n,
            ).toBe(scale * 1000);
        }
      },
    });
    const report = await growth(db, {
      name: 'registered website maintenance sweep with dispatch and step persistence',
      // Five fixed batches of 1000, <=2000 candidates/kind, exact TID locks
      // and deletes plus indexed FK probes and a constant number of DBOS writes.
      bounds: fixed,
      async grow(_, scale, previous) {
        await protocolRows(db, 'expired-', previous * 1000 + 1, scale * 1000, new Date('2000-01-01'));
        await protocolRows(db, 'live-', previous * 1000 + 1, scale * 1000, new Date('2099-01-01'));
        await durableHistory(db, 'dbos', 'maintenance', 'website-history-', previous * 1000 + 1, scale * 1000);
      },
      ...targets.hooks,
    });
    for (const sample of report.samples)
      for (const cost of [sample.cost, ...sample.repetitions]) {
        expect(cost.statements).toBeGreaterThan(5);
        for (const table of [
          'oauthAccessToken',
          'oauthRefreshToken',
          'oauthRefreshFamily',
          'oauthClientAssertion',
          'auth_recent_oidc_session',
        ])
          expect(cost.relations[`public.${table}`]!.rows).toBeGreaterThanOrEqual(1000);
        expect(cost.relations['dbos.operation_outputs']!.nodes).toBeGreaterThan(0);
      }
  } finally {
    await work.shutdown();
    await client.close();
  }
}

const child = process.argv.find((arg) => arg.startsWith('--revoke-maintenance-child='))?.split('=')[1];
if (child) {
  const db = await openGrowthDatabase(process.env.REVOKE_MAINTENANCE_DATABASE_URL!);
  try {
    if (child === 'maintenance') await maintenanceGrowth(db);
    else if (child === 'website') await websiteGrowth(db);
    else throw new Error(`Unknown growth child: ${child}`);
  } finally {
    await db.close();
  }
} else {
  test("Session revoke stays within its bound as the owner's expired and unrelated sessions grow", async () => {
    const fixture = testDatabase();
    const db = await openGrowthDatabase(fixture.url);
    try {
      await revokeGrowth(db);
    } finally {
      await db.close();
      fixture.close();
    }
  }, 240000);

  for (const [kind, title] of [
    [
      'maintenance',
      'Maintenance tick with due consent erasure stays within its bound as consent and session history grows',
    ],
    ['website', 'Website maintenance sweep stays within its bound as protocol state history grows'],
  ]) {
    test(
      title!,
      async () => {
        const fixture = testDatabase();
        try {
          const process = Bun.spawn([Bun.which('bun')!, import.meta.path, `--revoke-maintenance-child=${kind}`], {
            env: { ...globalThis.process.env, REVOKE_MAINTENANCE_DATABASE_URL: fixture.url },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const [output, errors, code] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ]);
          console.log(output);
          if (errors) console.error(errors);
          expect(code).toBe(0);
        } finally {
          fixture.close();
        }
      },
      360000,
    );
  }
}
