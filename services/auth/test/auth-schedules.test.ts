import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { schemaDump, testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthServiceOptions } from '../src/index.ts';
import { createAuthHost, AuthHostConfigurationError } from '../src/host.ts';
import { AUTH_MAINTENANCE_SCHEDULE, AUTH_SYSTEM_SCHEMA } from '../src/maintenance.ts';
import type { AccountWorkflowPorts } from '../src/workflows.ts';

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
const trustedAccess: AuthServiceOptions['trustedAccess'] = trustedAccessPorts({
  readAccount: unused,
  readFencedAccount: unused,
  authorizeProvisioning: unused,
});

// Each replica has a real independent SDK registry, pool and executor identity.
if (process.argv.includes('--schedule-child')) {
  void runReplica();
} else {
  test('native scheduled recovery in two Auth replicas shares only the Auth database and bounds each purpose', async () => {
    const fixture = testDatabase();
    const pool = new Pool({ connectionString: fixture.url });
    const children: ReturnType<typeof replica>[] = [];
    const key = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'schedule-current',
    };
    const settings = {
      url: fixture.url,
      secret: randomBytes(48).toString('hex'),
      signing: { activeKid: key.kid, privateKeys: [key] },
      stagingKey: randomBytes(32).toString('hex'),
    };
    try {
      // Library construction performs no SDK registration or launch.
      const service = await createAuthService({
        database: pool,
        issuer: 'https://schedules.auth.test',
        audience: 'https://api.test',
        ...settings,
        trustedAccess,
      });
      expect(DBOS.isInitialized()).toBe(false);
      await service.internal.registerClient({ clientId: 'schedule-web', firstParty: true, scopes: ['read'] });
      await pool.query(
        `INSERT INTO "user" (id,name,"emailVerified") SELECT 'owner-'||i,'',false FROM generate_series(1,50) i`,
      );
      await pool.query(`INSERT INTO session (id,token,"userId","clientId","expiresAt","updatedAt","grantedScope","authnEpoch","authTime","authMethods")
        SELECT 'expired-'||i,'secret-token-'||i,'owner-'||(1+(i-1)/64),'schedule-web','2000-01-01',now(),'read',1,1,'pwd' FROM generate_series(1,2501) i`);
      await pool.query(`INSERT INTO verification (id,identifier,value,"expiresAt") SELECT 'expired-'||i,'identifier-'||i,'secret-verification-'||i,'2000-01-01' FROM generate_series(1,2501) i;
        INSERT INTO verification (id,identifier,value,"expiresAt") VALUES ('live','live','live-secret','2099-01-01')`);
      await pool.query(`INSERT INTO auth_signing_key (kid,slot,private_jwk,retain_until) SELECT 'schedule-retiring','retiring',private_jwk||'{"kid":"schedule-retiring"}'::jsonb,'2000-01-01' FROM auth_signing_key WHERE slot='current';
        UPDATE auth_signing_generation SET retiring_kid='schedule-retiring'`);
      // A kernel-looking sentinel is inaccessible to maintenance's product paths.
      await pool.query(
        `CREATE SCHEMA kernel; CREATE TABLE kernel.sentinel (value text); INSERT INTO kernel.sentinel VALUES ('unchanged')`,
      );
      const wake = new Date(Date.now() + 12000);
      const cron = `${wake.getUTCSeconds()} ${wake.getUTCMinutes()} ${wake.getUTCHours()} ${wake.getUTCDate()} ${wake.getUTCMonth() + 1} *`;
      const first = replica({ ...settings, executorId: 'auth-replica-1', cron, block: true });
      children.push(first);
      expect((await first.until('ready')).launches).toBe(1);
      const second = replica({ ...settings, executorId: 'auth-replica-2', cron, block: true });
      children.push(second);
      expect((await second.until('ready')).launches).toBe(1);
      const blocked = await Promise.race([first.until('blocked'), second.until('blocked')]);
      expect(blocked.id).toStartWith(`sched-${AUTH_MAINTENANCE_SCHEDULE}-`);
      expect(Number((await pool.query('SELECT count(*) FROM session')).rows[0].count)).toBe(1501);
      expect(Number((await pool.query('SELECT count(*) FROM verification')).rows[0].count)).toBe(2502);
      expect((await pool.query(`SELECT slot FROM auth_signing_key ORDER BY slot`)).rows).toEqual([{ slot: 'current' }]);
      expect(
        (
          await pool.query(
            `SELECT function_name FROM ${AUTH_SYSTEM_SCHEMA}.operation_outputs WHERE workflow_uuid=$1 ORDER BY function_id`,
            [blocked.id],
          )
        ).rows,
      ).toEqual([
        { function_name: 'auth.maintenance.sweepExpiredSessions' },
        { function_name: 'auth.maintenance.retireSigningKeys' },
      ]);
      // Kill both real processes, preserving native durable checkpoints.
      await Promise.all(children.map((child) => child.kill()));
      const restarted = replica({ ...settings, executorId: blocked.executorId, cron: '0 0 1 1 *', block: false });
      children.push(restarted);
      await restarted.until('ready');
      await eventually(
        async () =>
          (
            await pool.query(`SELECT status FROM ${AUTH_SYSTEM_SCHEMA}.workflow_status WHERE workflow_uuid=$1`, [
              blocked.id,
            ])
          ).rows[0]?.status === 'SUCCESS',
      );
      expect(Number((await pool.query('SELECT count(*) FROM session')).rows[0].count)).toBe(1501);
      expect(Number((await pool.query('SELECT count(*) FROM verification')).rows[0].count)).toBe(1502);
      expect((await pool.query(`SELECT id FROM verification WHERE id='live'`)).rows).toEqual([{ id: 'live' }]);
      expect((await pool.query('SELECT * FROM kernel.sentinel')).rows).toEqual([{ value: 'unchanged' }]);
      const schedules = (await pool.query(`SELECT * FROM ${AUTH_SYSTEM_SCHEMA}.workflow_schedules`)).rows;
      expect(schedules).toHaveLength(2);
      expect(schedules.map((schedule) => schedule.schedule_name).sort()).toEqual(
        [AUTH_MAINTENANCE_SCHEDULE, 'auth.workflowRetention.every-10-minutes'].sort(),
      );
      expect(JSON.stringify(schedules)).toContain('auth-maintenance');
      expect(
        (
          await pool.query(
            `SELECT workflow_uuid FROM ${AUTH_SYSTEM_SCHEMA}.workflow_status WHERE name='auth.maintenance.tick'`,
          )
        ).rows,
      ).toHaveLength(1);
      expect((await pool.query(`SELECT schemaname FROM pg_tables WHERE schemaname='dbos'`)).rows).toEqual([]);
      for (const { tablename } of (
        await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname=$1`, [AUTH_SYSTEM_SCHEMA])
      ).rows) {
        const history = JSON.stringify(
          (await pool.query(`SELECT row_to_json(t) FROM ${AUTH_SYSTEM_SCHEMA}."${tablename.replaceAll('"', '""')}" t`))
            .rows,
        );
        for (const secret of [
          settings.secret,
          settings.stagingKey,
          key.d!,
          'secret-token-',
          'secret-verification-',
          fixture.url,
        ])
          expect(history).not.toContain(secret);
      }
      restarted.send('stop');
      expect(await restarted.until('stopped')).toMatchObject({
        initialized: false,
        connections: 0,
        systemConnections: 0,
      });
      expect(await restarted.exit()).toBe(0);
      await pool.query('DROP SCHEMA kernel CASCADE');
      // Only the SDK schema is excluded; Better Auth's native tables remain checked.
      const dump = schemaDump(fixture.url, fixture);
      expect(dump).not.toContain(`${AUTH_SYSTEM_SCHEMA}.`);
      expect(dump).toContain('CREATE TABLE public.verification');
      expect(dump).toBe(await Bun.file(new URL('../db/schema.sql', import.meta.url)).text());
    } finally {
      await Promise.all(children.map((child) => child.kill()));
      await pool.end();
      fixture.close();
    }
  }, 120000);

  test('host rejects invalid or cross-database configuration with named nonsecret errors before launching', async () => {
    const pool = new Pool({ connectionString: 'postgres://user:secret@127.0.0.1/auth' });
    try {
      const base = {
        database: pool,
        issuer: 'https://auth.test',
        audience: 'https://api.test',
        secret: 'unused',
        signing: { activeKid: 'unused', privateKeys: [] },
        trustedAccess,
        access,
        stagingKey: randomBytes(32),
      };
      for (const extra of [
        { systemDatabaseUrl: 'bad-secret-url' },
        { systemDatabaseUrl: 'postgres://user:kernel-secret@127.0.0.1/kernel' },
        { systemDatabaseUrl: 'postgres://user:secret@127.0.0.1/auth?host=kernel.example' },
        { systemDatabaseUrl: 'postgres://user:secret@127.0.0.1/auth?host=/tmp/other-socket' },
        { stagingKey: new Uint8Array(3) },
        { maintenanceSchedule: 'invalid-secret-cron' },
      ]) {
        try {
          await createAuthHost({ ...base, ...extra });
          throw new Error('Expected rejection');
        } catch (error) {
          expect(error).toBeInstanceOf(AuthHostConfigurationError);
          expect((error as Error).message).not.toContain('secret');
        }
      }
      expect(DBOS.isInitialized()).toBe(false);
    } finally {
      await pool.end();
    }
  });
}

async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 60000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Durable Auth outcome did not arrive');
    await Bun.sleep(20);
  }
}
function replica(settings: object) {
  const messages: Record<string, any>[] = [];
  let errors = '';
  const child = Bun.spawn([process.execPath, import.meta.path, '--schedule-child'], {
    env: { ...process.env, AUTH_SCHEDULE_FIXTURE: JSON.stringify(settings) },
    stdout: 'ignore',
    stderr: 'pipe',
    ipc(message) {
      messages.push(message as Record<string, any>);
    },
  });
  const read = (async () => {
    for await (const chunk of child.stderr) errors += new TextDecoder().decode(chunk);
  })();
  return {
    send(command: string) {
      child.send({ command });
    },
    async until(event: string) {
      await eventually(async () => {
        if (messages.some((message) => message.event === event)) return true;
        if (child.exitCode !== null) throw new Error(`Auth replica exited: ${errors}`);
        return false;
      });
      return messages.find((message) => message.event === event)!;
    },
    async kill() {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
      await read;
    },
    exit: () => child.exited,
  };
}

async function runReplica() {
  const settings = JSON.parse(process.env.AUTH_SCHEDULE_FIXTURE!);
  const pool = new Pool({ connectionString: settings.url });
  const system = new Pool({ connectionString: settings.url, max: 8 });
  const host = await createAuthHost({
    database: pool,
    systemDatabasePool: system,
    issuer: 'https://schedules.auth.test',
    audience: 'https://api.test',
    secret: settings.secret,
    signing: settings.signing,
    trustedAccess,
    access,
    stagingKey: Buffer.from(settings.stagingKey, 'hex'),
    executorId: settings.executorId,
    maintenanceSchedule: settings.cron,
  });
  if (settings.block) {
    host.service.internal.pruneExpiredVerifications = async () => {
      process.send!({ event: 'blocked', id: DBOS.workflowID, executorId: settings.executorId });
      return new Promise<never>(() => {});
    };
  }
  const launch = DBOS.launch.bind(DBOS);
  let launches = 0;
  DBOS.launch = async (...args) => {
    launches++;
    await launch(...args);
  };
  await Promise.all([host.start(), host.start()]);
  await host.start();
  process.send!({ event: 'ready', launches, config: host.config });
  process.on('message', async (message: { command: string }) => {
    if (message.command === 'stop') {
      await Promise.all([host.stop(), host.stop()]);
      process.send!({
        event: 'stopped',
        initialized: DBOS.isInitialized(),
        connections: pool.totalCount,
        systemConnections: system.totalCount,
      });
      process.exit(0);
    }
  });
}
