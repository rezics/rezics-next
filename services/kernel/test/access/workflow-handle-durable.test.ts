import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { handleFixture, type FixtureConfiguration } from './workflow-handle-fixture.ts';
import { REGISTRATION_TTL_MS } from '../../src/access/lifecycle.ts';
import { newId } from '../../src/route/route.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `workflow_handle_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}_system" WITH (FORCE)`);
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

let deployment: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let fixture: Awaited<ReturnType<typeof handleFixture>>;
let config: FixtureConfiguration;
let system: Pool;
let instant = Date.now();
let childLogs = '';
const password = `durable-password-${randomBytes(16).toString('hex')}`;
const email = 'process-loss-handles@example.test';
const issuer = 'https://durable-handles.auth.test';
beforeEach(() => {
  instant = Date.now();
});
async function post(path: string, body: unknown, cookie?: string) {
  return fixture.auth.handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
}
async function token(accountId: string) {
  const signin = await post('/signin', {
    account_id: accountId,
    password,
    client_id: 'durable-web',
    scope: ['account:update', 'organization:create'],
  });
  expect(signin.status).toBe(200);
  const issued = await post('/token', {}, signin.headers.get('set-cookie')!.split(';')[0]!);
  expect(issued.status).toBe(200);
  return ((await issued.json()) as { access_token: string }).access_token;
}
beforeAll(async () => {
  // This issuer owns its migrated Auth fixture and DBOS database. It never uses
  // the foundation suite's AUTH_TEST_DATABASE_URL or key/client tables.
  deployment = await cloneAuthDatabase();
  const database = new Pool({ connectionString: deployment.url });
  const systemName = `${new URL(deployment.url).pathname.slice(1)}_system`;
  await database.query(`CREATE DATABASE "${systemName}"`);
  await database.end();
  const url = new URL(deployment.url);
  url.pathname = `/${systemName}`;
  system = new Pool({ connectionString: url.href });
  const signing = await generateKeyPair('ES256', { extractable: true });
  config = {
    kernelUrl: process.env.DATABASE_URL!,
    authUrl: deployment.url,
    systemUrl: url.href,
    stagingKey: randomBytes(32).toString('hex'),
    secret: randomBytes(48).toString('hex'),
    signing: { ...(await exportJWK(signing.privateKey)), kid: 'durable-handle-signer', alg: 'ES256' },
  };
  fixture = await handleFixture(config, () => new Date(instant));
}, 60000);
afterAll(async () => {
  await fixture?.close();
  await system?.end();
  await deployment?.close();
}, 60000);

test('process loss after real Auth credential and Access handle barrier recovers the same DBOS registration', async () => {
  const child = Bun.spawn(['bun', './test/access/workflow-handle-fixture.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      HANDLE_WORKFLOW_FIXTURE: JSON.stringify(config),
      HANDLE_WORKFLOW_EMAIL: email,
      HANDLE_WORKFLOW_PASSWORD: password,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  try {
    const reader = child.stdout.getReader();
    const deadline = AbortSignal.timeout(30000);
    while (!output.split('\n').some((line) => line.startsWith('{'))) {
      const data = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          deadline.addEventListener('abort', () => reject(new Error('Registration child did not reach its barrier')), {
            once: true,
          }),
        ),
      ]);
      if (data.done) throw new Error(`Registration child exited: ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(data.value);
    }
    reader.releaseLock();
    const pending = JSON.parse(output.split('\n').find((line) => line.startsWith('{'))!) as {
      accountId: string;
      registrationId: string;
      workflowId: string;
    };
    child.kill('SIGKILL');
    await child.exited;
    childLogs += output + (await new Response(child.stderr).text());
    expect(
      (await system.query('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [pending.workflowId])).rows,
    ).toEqual([{ status: 'PENDING' }]);
    expect(await fixture.read(pending.accountId)).toMatchObject({ state: 'pending', handle: 'process_loss' });
    expect(await fixture.internal.resolveHandle('process_loss')).toEqual({
      accountId: pending.accountId,
      redirect: false,
    });
    expect(
      (
        await post('/signin', {
          account_id: pending.accountId,
          password,
          client_id: 'durable-web',
          scope: ['account:update'],
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    await fixture.workflows.start();
    expect(await fixture.workflows.activateRegistration(pending.registrationId)).toEqual({
      accountId: pending.accountId,
    });
    expect(await fixture.workflows.activateRegistration(pending.registrationId)).toEqual({
      accountId: pending.accountId,
    });
    expect((await fixture.database.query('SELECT "userId" FROM account')).rows).toEqual([
      { userId: pending.accountId },
    ]);
    expect((await fixture.database.query('SELECT account_id FROM auth_provisioning_receipt')).rows).toEqual([
      { account_id: pending.accountId },
    ]);
    expect(
      (await fixture.kernel.query("SELECT response FROM core.receipt WHERE command_kind='access.actor-activated'"))
        .rows,
    ).toHaveLength(1);
    expect(
      (await system.query('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [pending.workflowId])).rows,
    ).toEqual([{ status: 'SUCCESS' }]);
    expect(await token(pending.accountId)).toBeString();
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
}, 60000);

test('loss after credential commit before its DBOS checkpoint reuses the Auth owner or safely expires it', async () => {
  for (const expired of [false, true]) {
    await fixture.workflows.close();
    const key = expired ? 'commit_expired' : 'commit_recovered';
    const child = Bun.spawn(['bun', './test/access/workflow-handle-fixture.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        HANDLE_WORKFLOW_FIXTURE: JSON.stringify(config),
        HANDLE_WORKFLOW_EMAIL: `${key}@example.test`,
        HANDLE_WORKFLOW_PASSWORD: password,
        HANDLE_WORKFLOW_COMMIT_LOSS: '1',
        HANDLE_WORKFLOW_KEY: key,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      let output = '';
      const reader = child.stdout.getReader();
      const deadline = AbortSignal.timeout(30000);
      while (!output.split('\n').some((line) => line.startsWith('{'))) {
        const data = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            deadline.addEventListener('abort', () => reject(new Error('Credential commit checkpoint missing')), {
              once: true,
            }),
          ),
        ]);
        if (data.done) throw new Error(await new Response(child.stderr).text());
        output += new TextDecoder().decode(data.value);
      }
      reader.releaseLock();
      const ref = JSON.parse(output.split('\n').find((line) => line.startsWith('{'))!) as {
        accountId: string;
        registrationId: string;
        workflowId: string;
      };
      child.kill('SIGKILL');
      await child.exited;
      childLogs += output + (await new Response(child.stderr).text());
      expect(
        (await fixture.database.query('SELECT "userId" FROM account WHERE "userId"=$1', [ref.accountId])).rows,
      ).toEqual([{ userId: ref.accountId }]);
      expect(
        (await system.query('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [ref.workflowId])).rows,
      ).toEqual([{ status: 'PENDING' }]);
      if (expired) {
        const stage = (
          await fixture.database.query<{ expires_at: Date }>(
            'SELECT expires_at FROM auth_registration_stage WHERE registration_id=$1',
            [ref.registrationId],
          )
        ).rows[0]!;
        instant = Math.max(instant, stage.expires_at.getTime() + 1);
      }
      await fixture.restart();
      if (expired) {
        await fixture.workflows.expireDueRegistrations();
        expect(await fixture.read(ref.accountId)).toMatchObject({ state: 'deleted', fenced: true });
        expect(await fixture.internal.resolveHandle(key)).toBeNull();
        expect((await fixture.database.query('SELECT id FROM "user" WHERE id=$1', [ref.accountId])).rows).toEqual([]);
      } else {
        expect(
          await fixture.workflows.installRegistrationCredential({
            registrationId: ref.registrationId,
            email: `${key}@example.test`,
            password,
          }),
        ).toEqual({ accountId: ref.accountId });
        expect(await fixture.workflows.activateRegistration(ref.registrationId)).toEqual({ accountId: ref.accountId });
        expect((await fixture.database.query('SELECT id FROM "user" WHERE id=$1', [ref.accountId])).rows).toEqual([
          { id: ref.accountId },
        ]);
      }
      expect(
        (
          await fixture.database.query('SELECT account_id FROM auth_provisioning_receipt WHERE account_id=$1', [
            ref.accountId,
          ])
        ).rows,
      ).toHaveLength(1);
      expect(
        (await system.query('SELECT status FROM dbos.workflow_status WHERE workflow_uuid=$1', [ref.workflowId])).rows,
      ).toEqual([{ status: 'SUCCESS' }]);
    } finally {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}, 60000);

test('DBOS recovery replays native receipts after every handle phase and paused holds cannot be stolen', async () => {
  const phases = [
    'reserveHandle',
    'holdHandle',
    'transitionAccountHandle',
    'finalizeHandleTransition',
    'redirectTransitionHandle',
    'completeHandleTransition',
  ];
  for (const [index, phase] of phases.entries()) {
    const oldHandle = `durable_old_${index}`,
      handle = `durable_new_${index}`;
    const owner = await fixture.workflows.register({
      key: `durable-owner-${index}`,
      handle: oldHandle,
      email: `durable-${index}@example.test`,
      password,
    });
    fixture.approve(`approval-${index}`, await token(owner.accountId));
    const request = {
      key: `durable-rename-${index}`,
      accountId: owner.accountId,
      handle,
      expectedHandle: oldHandle,
      authorization: `approval-${index}`,
    };
    fixture.failAfter(phase);
    await expect(fixture.workflows.renameHandle(request)).rejects.toThrow();
    const committed = fixture.effects.filter((effect) => effect.phase === phase).at(-1)!;
    if (phase === 'holdHandle' || phase === 'transitionAccountHandle') {
      instant += REGISTRATION_TTL_MS + 1;
      await expect(
        fixture.internal.reserveHandle({ handle, accountId: newId(0x8844), key: `steal-${index}` }),
      ).rejects.toThrow();
      await expect(fixture.internal.expireHandle({ handle, key: `expire-${index}` })).rejects.toThrow();
    }
    await fixture.restart();
    expect(await fixture.workflows.resumeOperation(request.key)).toEqual({ accountId: owner.accountId });
    const recovered = fixture.effects.filter(
      (effect) => effect.phase === phase && effect.transactionId === committed.transactionId,
    );
    expect(recovered.some((effect) => effect.replayed)).toBe(true);
    expect(await fixture.internal.resolveHandle(handle)).toEqual({ accountId: owner.accountId, redirect: false });
    expect(await fixture.internal.resolveHandle(oldHandle)).toEqual({ accountId: owner.accountId, redirect: true });
    expect(await fixture.read(owner.accountId)).toMatchObject({ handle });
  }
}, 60000);

test('organization bootstrap and authorized rename sequence actual owner, organization and handle anchors', async () => {
  const owner = await fixture.workflows.register({
    key: 'durable-org-owner',
    handle: 'durable_org_owner',
    email: 'durable-org-owner@example.test',
    password,
  });
  fixture.approve('organization-owner', await token(owner.accountId));
  const organization = await fixture.workflows.createOrganization({
    key: 'durable-organization',
    handle: 'durable_organization',
    authorization: 'organization-owner',
  });
  expect(await fixture.read(organization.accountId!)).toMatchObject({
    kind: 'organization',
    handle: 'durable_organization',
  });
  await fixture.workflows.renameHandle({
    key: 'durable-org-rename',
    accountId: organization.accountId!,
    expectedHandle: 'durable_organization',
    handle: 'durable_organization_new',
    authorization: 'organization-owner',
  });
  expect(await fixture.internal.resolveHandle('durable_organization_new')).toEqual({
    accountId: organization.accountId,
    redirect: false,
  });
  expect((await fixture.database.query('SELECT id FROM "user" WHERE id=$1', [organization.accountId])).rows).toEqual(
    [],
  );
  await expect(
    fixture.workflows.beginRegistration({ key: 'steal-organization', handle: 'durable_organization_new' }),
  ).rejects.toThrow();
}, 60000);

test('registration paused beyond TTL after its active claim is terminalized and releases only the failed claim', async () => {
  const ref = await fixture.workflows.beginRegistration({ key: 'durable-expired', handle: 'durable_expired' });
  await fixture.workflows.installRegistrationCredential({
    registrationId: ref.registrationId,
    email: 'durable-expired@example.test',
    password,
  });
  await fixture.restart();
  instant += REGISTRATION_TTL_MS + 1;
  await expect(fixture.workflows.activateRegistration(ref.registrationId)).rejects.toThrow();
  await fixture.workflows.expireDueRegistrations();
  expect(await fixture.read(ref.accountId)).toMatchObject({ state: 'deleted', fenced: true });
  expect(await fixture.internal.resolveHandle('durable_expired')).toBeNull();
  expect(
    (
      await post('/signin', {
        account_id: ref.accountId,
        password,
        client_id: 'durable-web',
        scope: ['account:update'],
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  const next = await fixture.workflows.beginRegistration({ key: 'durable-replacement', handle: 'durable_expired' });
  expect(next.accountId).not.toBe(ref.accountId);
  await expect(
    fixture.internal.releaseExpiredRegistrationHandle({
      accountId: ref.accountId,
      handle: 'durable_expired',
      reservationId: (
        await fixture.database.query('SELECT reservation_id FROM auth_registration_stage WHERE registration_id=$1', [
          ref.registrationId,
        ])
      ).rows[0]!.reservation_id,
      key: 'stale-terminal-release',
    }),
  ).rejects.toThrow();
  expect(await fixture.internal.resolveHandle('durable_expired')).toEqual({
    accountId: next.accountId,
    redirect: false,
  });
}, 60000);

test('real revocation receipt and floor are visible before Auth effects and survive an Auth outage', async () => {
  const owner = await fixture.workflows.register({
    key: 'durable-revocation',
    handle: 'durable_revocation',
    email: 'durable-revocation@example.test',
    password,
  });
  const bearer = await token(owner.accountId);
  let barrier: Awaited<ReturnType<typeof fixture.internal.readFenceState>>;
  let fail = true;
  fixture.beforeRevocation(async (accountId) => {
    // These independent reads happen only after the Access command returned.
    barrier = await fixture.internal.readFenceState(accountId);
    expect(barrier).toMatchObject({ fenced: true, minimumAuthnEpoch: '2' });
    expect(await fixture.internal.readFenceReceipt(accountId, barrier!.receiptId!)).toMatchObject({
      accountId,
      minimumAuthnEpoch: '2',
    });
    if (fail) throw new Error('Auth unavailable');
  });
  await expect(
    fixture.workflows.revokeSessions({ accountId: owner.accountId, key: 'durable-revoke' }),
  ).rejects.toThrow();
  const committed = barrier!;
  await expect(fixture.authenticate(bearer)).rejects.toThrow();
  expect(
    (
      await post('/signin', {
        account_id: owner.accountId,
        password,
        client_id: 'durable-web',
        scope: ['account:update'],
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  await expect(
    fixture.internal.clearFence({ accountId: owner.accountId, evidence: 'stale-proof', key: 'stale-recovery-proof' }),
  ).rejects.toThrow();
  fail = false;
  await fixture.restart();
  await fixture.workflows.resumeOperation('durable-revoke');
  expect(await fixture.internal.readFenceState(owner.accountId)).toEqual(committed);
  expect((await fixture.database.query('SELECT id FROM session WHERE "userId"=$1', [owner.accountId])).rows).toEqual(
    [],
  );
  fixture.beforeRevocation();
}, 60000);

test('real integrated DBOS history and child output contain no plaintext Auth material', async () => {
  let serialized = '';
  for (const { tablename } of (
    await system.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='dbos'")
  ).rows)
    serialized += JSON.stringify(
      (await system.query(`SELECT row_to_json(t) FROM dbos."${tablename.replaceAll('"', '""')}" t`)).rows,
    );
  serialized += childLogs;
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(email);
  expect(serialized).not.toContain(config.secret);
  expect(serialized).not.toContain(config.stagingKey);
  expect(serialized).not.toContain(config.signing.d!);
});
