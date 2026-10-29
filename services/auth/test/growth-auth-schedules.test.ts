import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService } from '../src/index.ts';
import { createAccountWorkflows, type AccountWorkflowPorts } from '../src/workflows.ts';
import { AUTH_MAINTENANCE_SCHEDULE, AUTH_SYSTEM_SCHEMA, registerAuthMaintenance } from '../src/maintenance.ts';
import { WORKFLOW_RETENTION_SCHEDULE } from '../src/retention.ts';
import {
  checkGrowth,
  GrowthSettleInfrastructureError,
  openGrowthDatabase,
} from '../../kernel/test/support/growth.ts';

if (process.argv.includes('--growth-child')) {
  void runGrowth();
} else {
  test('checkGrowth captures one fixed native durable tick as unrelated and expired purpose histories grow', async () => {
    const fixture = testDatabase();
    try {
      const child = Bun.spawn([process.execPath, import.meta.path, '--growth-child'], {
        env: {
          ...process.env,
          AUTH_SCHEDULE_GROWTH_URL: fixture.url,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 170000,
      });
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`Native scheduled growth failed: ${output}\n${errors}`);
      expect(output).toContain('one durable Auth tick');
    } finally {
      fixture.close();
    }
  }, 180000);
}

async function runGrowth() {
  const db = await openGrowthDatabase(process.env.AUTH_SCHEDULE_GROWTH_URL!);
  const system = db.openPool({ max: 8 });
  const unused = async (): Promise<never> => {
    throw new Error('Maintenance must not call Access');
  };
  const access: AccountWorkflowPorts = {
    registrationTarget: () => {
      throw new Error('Maintenance must not call Access');
    },
    reserveHandle: unused,
    createPending: unused,
    claimHandle: unused,
    activate: unused,
    expireRegistration: unused,
    releaseExpiredRegistrationHandle: unused,
    provisioningReference: unused,
    provisioningEvidence: unused,
    raiseFence: unused,
    readAccount: unused,
  };
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'growth-current',
  };
  const auth = await createAuthService({
    database: db.pool,
    issuer: 'https://growth.auth.test',
    audience: 'https://api.test',
    secret: randomBytes(48).toString('hex'),
    signing: { activeKid: key.kid, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      readAccount: unused,
      readFencedAccount: unused,
      authorizeProvisioning: unused,
    }),
  });
  let maintenance: ReturnType<typeof registerAuthMaintenance>;
  let seedHistory: () => Promise<number>;
  let lastMeasuredStart: Date | undefined;
  const workflows = createAccountWorkflows({
    database: db.pool,
    systemDatabaseUrl: db.url,
    systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA,
    systemDatabasePool: system,
    auth,
    access,
    stagingKey: randomBytes(32),
    registerWorkflows: () => {
      maintenance = registerAuthMaintenance(auth);
      const count = DBOS.registerStep(async () => 1, { name: 'growth.history.count' });
      seedHistory = DBOS.registerWorkflow(async () => count(), { name: 'growth.history' });
    },
  });
  try {
    await workflows.start();
    await maintenance!.start('0 0 1 1 *');
    await DBOS.pauseSchedule(AUTH_MAINTENANCE_SCHEDULE);
    await DBOS.pauseSchedule(WORKFLOW_RETENTION_SCHEDULE);
    await db.admin.query(`INSERT INTO auth_client VALUES ('growth-web',true,ARRAY['read']);
      INSERT INTO "user" (id,name,"emailVerified") SELECT 'fixed-'||i,'',false FROM generate_series(1,16) i`);
    const reports = [];
    let seededHistory = 0;
    for (const dimension of ['unrelated', 'sessions', 'verifications', 'keys']) {
      const report = await checkGrowth(db, {
        name: `one durable Auth tick against ${dimension}`,
        warmups: 1,
        repetitions: 2,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        // One native queue/schedule wake can overlap capture (at most six reads).
        slack: { statements: { absolute: 6, relative: 0 } },
        async grow(_, scale, previous) {
          // Give both SDK tables production-shaped history before the first
          // planner sample, then grow unrelated history in every dimension.
          // Native runs persist status, step and workflow outputs together.
          const historyCount = (seededHistory === 0 ? 2048 : 0) + (scale - previous) * 32;
          for (let offset = 0; offset < historyCount; offset += 32) {
            await Promise.all(
              Array.from({ length: Math.min(32, historyCount - offset) }, async () => {
                const handle = await DBOS.startWorkflow(seedHistory!)();
                expect(await handle.getResult()).toBe(1);
              }),
            );
          }
          seededHistory += historyCount;
          for (const table of ['workflow_status', 'workflow_output']) {
            expect(
              Number((await db.admin.query(`SELECT count(*) FROM ${AUTH_SYSTEM_SCHEMA}.${table}`)).rows[0].count),
            ).toBeGreaterThanOrEqual(seededHistory);
            await db.admin.query(`VACUUM ANALYZE ${AUTH_SYSTEM_SCHEMA}.${table}`);
          }
          const from = previous * 2048 + 1;
          const to = scale * 2048;
          if (dimension === 'sessions' || dimension === 'unrelated') {
            await db.admin.query(
              `INSERT INTO "user" (id,name,"emailVerified") SELECT $1||i,'',false FROM generate_series($2::int,$3::int) i`,
              [dimension, from, to],
            );
            await db.admin.query(
              `INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
              SELECT $1||i,$1||i,$1||i,'growth-web',CASE WHEN $1='sessions' THEN '2000-01-01'::timestamptz ELSE '2099-01-01'::timestamptz END,now(),'read',1,1,'pwd' FROM generate_series($2::int,$3::int) i`,
              [dimension, from, to],
            );
          }
          if (dimension === 'verifications' || dimension === 'unrelated')
            await db.admin.query(
              `INSERT INTO verification (id,identifier,value,"expiresAt") SELECT $1||i,$1||i,'background',CASE WHEN $1='verifications' THEN '2000-01-01'::timestamptz ELSE '2099-01-01'::timestamptz END FROM generate_series($2::int,$3::int) i`,
              [dimension, from, to],
            );
          if (dimension === 'keys')
            await db.admin.query(
              `INSERT INTO auth_signing_key_archive (kid,private_jwk) SELECT 'archive-'||i,$3::jsonb||jsonb_build_object('kid','archive-'||i) FROM generate_series($1::int,$2::int) i`,
              [from, to, key],
            );
          for (const table of ['session', 'verification', 'auth_signing_key_archive', '"user"'])
            await db.admin.query(`VACUUM ANALYZE ${table}`);
        },
        async operation(_, scale) {
          if (scale === 64) lastMeasuredStart = new Date();
          // Preparation and affected-row checks use only the uncaptured admin pool.
          // The same oldest 1000 rows are admitted regardless of background size.
          await db.admin
            .query(`INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
            SELECT 'admitted-'||i,'admitted-'||i,'fixed-'||(1+(i-1)/64),'growth-web','1990-01-01',now(),'read',1,1,'pwd' FROM generate_series(1,1000) i;
            INSERT INTO verification (id,identifier,value,"expiresAt") SELECT 'admitted-'||i,'admitted-'||i,'private-value','1990-01-01' FROM generate_series(1,1000) i;
            INSERT INTO auth_signing_key (kid,slot,private_jwk,retain_until) SELECT 'growth-retiring','retiring',private_jwk||'{"kid":"growth-retiring"}'::jsonb,'1990-01-01' FROM auth_signing_key WHERE slot='current';
            UPDATE auth_signing_generation SET retiring_kid='growth-retiring'`);
          const before = (
            await db.admin.query(
              `SELECT (SELECT count(*) FROM session)::int AS sessions,(SELECT count(*) FROM verification)::int AS verifications`,
            )
          ).rows[0];
          // Enqueue the installed scheduled workflow explicitly: the harness
          // treats sched-* IDs (including triggerSchedule) as background work.
          const schedule = await DBOS.getSchedule(AUTH_MAINTENANCE_SCHEDULE);
          expect(schedule).not.toBeNull();
          const tick = await DBOS.enqueueWorkflowWithOptions(
            { workflowName: schedule!.workflowName, queueName: schedule!.queueName! },
            new Date(),
            null,
          );
          await tick.getResult();
          const after = (
            await db.admin.query(
              `SELECT (SELECT count(*) FROM session)::int AS sessions,(SELECT count(*) FROM verification)::int AS verifications`,
            )
          ).rows[0];
          expect(before.sessions - after.sessions).toBe(1000);
          expect(before.verifications - after.verifications).toBe(1000);
          const outputs = (
            await db.admin.query(
              `SELECT output FROM ${AUTH_SYSTEM_SCHEMA}.operation_outputs WHERE workflow_uuid=$1 ORDER BY function_id`,
              [tick.workflowID],
            )
          ).rows;
          expect(outputs).toHaveLength(3);
          expect(outputs.map((row) => JSON.parse(row.output).json)).toEqual([1000, 1, 1000]);
          expect((await db.admin.query(`SELECT kid FROM auth_signing_key WHERE slot='retiring'`)).rows).toEqual([]);
        },
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
      for (const sample of report.samples) {
        for (const cost of sample.repetitions) {
          for (const table of ['workflow_status', 'workflow_output']) {
            const relation = cost.relations[`${AUTH_SYSTEM_SCHEMA}.${table}`];
            expect(relation?.nodes).toBeGreaterThan(0);
            expect(relation?.sequentialScans).toBe(0);
          }
        }
      }
      expect(report.samples.every((sample) => sample.cost.statements > 3 && sample.cost.statements < 100)).toBe(true);
      expect(report.samples.every((sample) => (sample.cost.relations?.['public.session']?.rows ?? 0) >= 1000)).toBe(
        true,
      );
      expect(
        report.samples.every(
          (sample) => !Object.keys(sample.cost.relations ?? {}).some((relation) => relation.startsWith('kernel.')),
        ),
      ).toBe(true);
      reports.push(report);
    }
    console.log(
      JSON.stringify({
        reports: reports.map((report) => ({
          name: report.name,
          samples: report.samples.map((sample) => ({
            scale: sample.scale,
            rows: sample.cost.rows,
            blocks: sample.cost.blocks,
            statements: sample.cost.statements,
            relations: sample.cost.relations,
          })),
        })),
      }),
    );
  } catch (error) {
    if (error instanceof GrowthSettleInfrastructureError && lastMeasuredStart) {
      const writers = await db.admin.query(
        `SELECT name,workflow_uuid,status,queue_name,created_at
        FROM ${AUTH_SYSTEM_SCHEMA}.workflow_status WHERE created_at >= $1 ORDER BY created_at,workflow_uuid`,
        [lastMeasuredStart],
      );
      const workflowIds = writers.rows.map((row) => row.workflow_uuid);
      const operations = workflowIds.length
        ? await db.admin.query(
            `SELECT workflow_uuid,function_name FROM ${AUTH_SYSTEM_SCHEMA}.operation_outputs
            WHERE workflow_uuid = ANY($1::text[]) ORDER BY workflow_uuid,function_id`,
            [workflowIds],
          )
        : { rows: [] };
      console.error(JSON.stringify({ writers: writers.rows, operationOutputs: operations.rows }));
    }
    throw error;
  } finally {
    await workflows.close();
    await db.close();
  }
}
