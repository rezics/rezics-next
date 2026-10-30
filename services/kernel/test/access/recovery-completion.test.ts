import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createAuthHost,
  createBarrierProofVerifier,
  createProvisioningEvidenceVerifier,
  createNativeWorkflowProofPorts,
  type AuthService,
} from '@rezics/auth';
import { exportJWK, generateKeyPair, decodeJwt, type JWK } from 'jose';
import { Client, Pool } from 'pg';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createPool } from '../../src/database/pool.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeAccountBindings } from '../../src/access/native-account-bindings.ts';
import { createRecoveryCompletion } from '../../src/access/recovery-completion.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `recovery_complet_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

const pool = createPool(process.env.DATABASE_URL!);
const issuer = 'https://recovery.auth.test';
const password = 'original native recovery password';
const nextPassword = 'replacement native recovery password';
let database: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let service: AuthService;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let bindings: ReturnType<typeof createNativeAccountBindings>;
let delivery = '';
const deliveries = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>();
let fault: 'before' | 'after' | undefined;
const crashProcess = process.env.RECOVERY_CRASH_PHASE;
const key: JWK & { kid: string } = process.env.RECOVERY_CRASH_KEY
  ? JSON.parse(process.env.RECOVERY_CRASH_KEY)
  : {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'recovery',
    };
const access = createAccess({
  actions: new Map([['account:update', { anonymous: false }]]),
  auth: {
    issuer,
    audience: 'https://recovery.api.test',
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
  },
});
async function interruptCompletion(): Promise<never> {
  if (crashProcess) {
    process.stdout.write('RECOVERY_CRASH_READY\n');
    await new Promise<never>(() => {});
  }
  throw new Error('Completion acknowledgement lost');
}
async function build() {
  authPool = new Pool({ connectionString: database.url, max: 1 });
  bindings = createNativeAccountBindings({
    pool,
    access,
    actions: new Map([
      ['account:manage', { anonymous: false }],
      ['access:grant', { anonymous: false }],
    ]),
    routeKey: new Uint8Array(32).fill(71),
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) },
    auth: () => service,
    proofs: {
      workflow: createNativeWorkflowProofPorts({ database: authPool }),
      provisioning: createProvisioningEvidenceVerifier({ database: authPool }),
      barriers: createBarrierProofVerifier({ database: authPool }),
    },
  });
  const complete = bindings.trustedAccess.completeRecovery;
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: new Pool({ connectionString: database.url }),
    issuer,
    audience: 'https://recovery.api.test',
    secret: 'persistent-native-recovery-secret-at-least-32-bytes',
    signing: { activeKid: key.kid, privateKeys: [key] },
    stagingKey: new Uint8Array(32).fill(73),
    trustedAccess: {
      ...bindings.trustedAccess,
      async completeRecovery(reference) {
        expect(typeof reference).toBe('string');
        expect(await service.internal.resolveRecoveryEstablishment(reference)).not.toBeNull();
        if (fault === 'before') await interruptCompletion();
        if (!complete) throw new Error('Native completion missing');
        await complete(reference);
        if (fault === 'after') await interruptCompletion();
      },
    },
    access: bindings.workflowPorts,
    recoveryDelivery: {
      async deliver({ accountId, token }) {
        deliveries.get(accountId)?.resolve(token);
      },
    },
    maintenanceSchedule: '0 0 1 1 *',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'recovery-client', firstParty: true, scopes: ['account:update'] });
  await host.start();
}
const request = (path: string, body: unknown, cookie = '') =>
  service.handler(
    new Request(issuer + path, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
async function signin(name: string, selectedPassword: string) {
  return request('/signin', {
    email: `${name}@recovery.test`,
    password: selectedPassword,
    client_id: 'recovery-client',
    scope: ['account:update'],
  });
}
const cookieOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
async function startRecovery(accountId: string, email: string) {
  const pending = Promise.withResolvers<string>();
  deliveries.set(accountId, pending);
  try {
    expect((await request('/recovery/start', { email })).status).toBe(200);
    // The non-disclosing response deliberately precedes lookup and delivery.
    delivery = await pending.promise;
  } finally {
    deliveries.delete(accountId);
  }
}
async function person(name: string) {
  const email = `${name}@recovery.test`;
  const { accountId } = await host.workflows.register({
    key: name,
    handle: name,
    email,
    password,
  });
  const signed = await signin(name, password);
  expect(signed.status).toBe(200);
  const cookie = cookieOf(signed);
  const token = await request('/token', {}, cookie);
  expect(token.status).toBe(200);
  return { accountId, email, cookie, bearer: ((await token.json()) as { access_token: string }).access_token };
}
async function snapshot(accountId: string) {
  return {
    witness: (await authPool.query('SELECT * FROM auth_recovery_establishment WHERE account_id=$1', [accountId])).rows,
    credential: (await authPool.query('SELECT id,password,"updatedAt" FROM account WHERE "userId"=$1', [accountId]))
      .rows,
    proof: (await authPool.query('SELECT * FROM auth_recovery WHERE account_id=$1', [accountId])).rows,
    effects: (
      await authPool.query("SELECT * FROM auth_effect_receipt WHERE account_id=$1 AND purpose='recovery'", [accountId])
    ).rows,
    clears: (
      await pool.query(
        "SELECT * FROM core.receipt WHERE response->>'accountId'=$1 AND command_kind='access.authentication-established'",
        [accountId],
      )
    ).rows,
    fence: await bindings.internalLifecycle.readFenceState(accountId),
    events: (await pool.query(`SELECT type,id FROM core.outbox WHERE subject=$1 ORDER BY id`, [accountId])).rows,
  };
}
beforeAll(async () => {
  database = crashProcess ? { url: process.env.RECOVERY_CRASH_DATABASE!, async close() {} } : await cloneAuthDatabase();
  if (crashProcess === 'before' || crashProcess === 'after') fault = crashProcess;
  await build();
});
afterAll(async () => {
  await host?.stop();
  await pool.end();
  await database?.close();
});

if (crashProcess) {
  test('recovery crash child', async () => {
    await request('/recovery/complete', JSON.parse(process.env.RECOVERY_CRASH_BODY!));
  });
} else {
  test('actual Auth recovery commits credential witness then clears exact Access fence', async () => {
    const human = await person('native_recovery');
    const other = await person('unrelated_recovery');
    await bindings.internalLifecycle.raiseFence({ accountId: human.accountId, key: `${human.accountId}:initial` });
    await startRecovery(human.accountId, human.email);
    const body = { account_id: human.accountId, token: delivery, new_password: nextPassword };
    expect((await request('/recovery/complete', { ...body, token: 'wrong' })).status).toBe(401);
    expect((await request('/recovery/complete', { ...body, account_id: other.accountId })).status).toBe(401);
    expect((await signin('native_recovery', 'wrong password')).status).toBe(401);
    expect((await request('/recovery/complete', body)).status).toBe(200);
    const saved = await snapshot(human.accountId);
    expect(saved.fence).toMatchObject({ fenced: false, minimumAuthnEpoch: '3' });
    expect(saved.witness).toHaveLength(1);
    expect(saved.effects).toHaveLength(1);
    expect(saved.clears).toHaveLength(1);
    const witness = saved.witness[0]!;
    expect(witness.receipt_id).toBe(saved.fence!.receiptId);
    await expect(bindings.trustedAccess.completeRecovery!(JSON.stringify(witness))).rejects.toThrow();
    await expect(access.authenticate(human.bearer, { pool, deadline: Date.now() + 10000 })).rejects.toThrow();
    expect((await request('/token', {}, human.cookie)).status).toBe(401);
    expect((await signin('native_recovery', password)).status).toBe(401);
    const signed = await signin('native_recovery', nextPassword);
    expect(signed.status).toBe(200);
    const token = ((await (await request('/token', {}, cookieOf(signed))).json()) as { access_token: string })
      .access_token;
    const claims = decodeJwt(token);
    expect(claims.exp! - claims.iat!).toBe(300);
    expect((await access.authenticate(token, { pool, deadline: Date.now() + 10000 })).accountId).toBe(human.accountId);
    expect((await request('/recovery/complete', body)).status).toBe(200);
    expect(await snapshot(human.accountId)).toEqual(saved);
    expect((await request('/recovery/complete', { ...body, new_password: 'changed intended password' })).status).toBe(
      401,
    );
  });

  test('lost acknowledgement resumes one exact receipt and usable new session across both adapter restarts', async () => {
    for (const phase of ['before', 'after'] as const) {
      const name = `resume_${phase}`;
      const human = await person(name);
      await bindings.internalLifecycle.raiseFence({ accountId: human.accountId, key: `${human.accountId}:initial` });
      await startRecovery(human.accountId, human.email);
      const body = { account_id: human.accountId, token: delivery, new_password: nextPassword };
      await host.stop();
      const child = Bun.spawn(
        [process.execPath, 'test', '--timeout', '60000', 'test/access/recovery-completion.test.ts'],
        {
          cwd: import.meta.dir + '/../..',
          env: {
            ...process.env,
            RECOVERY_CRASH_PHASE: phase,
            RECOVERY_CRASH_DATABASE: database.url,
            RECOVERY_CRASH_KEY: JSON.stringify(key),
            RECOVERY_CRASH_BODY: JSON.stringify(body),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      try {
        const reader = child.stdout.getReader();
        let output = '';
        while (!output.includes('RECOVERY_CRASH_READY')) {
          const next = await reader.read();
          if (next.done)
            throw new Error(
              `Recovery host exited before crash boundary: ${output}\n${await new Response(child.stderr).text()}`,
            );
          output += new TextDecoder().decode(next.value);
        }
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }
      await build();
      const saved = await snapshot(human.accountId);
      expect(saved.witness).toHaveLength(1);
      expect(saved.fence!.fenced).toBe(phase === 'before');
      expect(await bindings.trustedAccess.readRecoveryAccount!(human.accountId)).not.toBeNull();
      if (phase === 'before') {
        expect(await bindings.trustedAccess.readAccount(human.accountId)).toBeNull();
        expect((await signin(name, nextPassword)).status).toBe(401);
      }
      await expect(access.authenticate(human.bearer, { pool, deadline: Date.now() + 10000 })).rejects.toThrow();
      await host.stop();
      fault = undefined;
      await build();
      expect((await request('/recovery/complete', body)).status).toBe(200);
      const recovered = await snapshot(human.accountId);
      expect(recovered.witness).toEqual(saved.witness);
      expect(recovered.credential).toEqual(saved.credential);
      expect(recovered.proof).toEqual(saved.proof);
      expect(recovered.effects).toEqual(saved.effects);
      expect(recovered.effects).toHaveLength(1);
      expect(recovered.clears).toHaveLength(1);
      if (phase === 'after') expect(recovered.clears).toEqual(saved.clears);
      expect(recovered.fence).toEqual({ ...saved.fence!, fenced: false });
      const signed = await signin(name, nextPassword);
      expect(signed.status).toBe(200);
      const token = ((await (await request('/token', {}, cookieOf(signed))).json()) as { access_token: string })
        .access_token;
      expect((await access.authenticate(token, { pool, deadline: Date.now() + 10000 })).accountId).toBe(
        human.accountId,
      );
      expect((await request('/recovery/complete', body)).status).toBe(200);
      expect(await snapshot(human.accountId)).toEqual(recovered);
      const completion = createRecoveryCompletion({ pool, routeKey: new Uint8Array(32).fill(71), auth: () => service });
      await bindings.internalLifecycle.raiseFence({
        accountId: human.accountId,
        key: `${human.accountId}:later-floor`,
      });
      await expect(completion.completeRecovery(saved.witness[0]!.reference)).rejects.toThrow();
      expect((await request('/recovery/complete', body)).status).toBe(401);
    }
  });

  test('failed or superseded Auth success cannot clear later floor or changed current authority', async () => {
    const human = await person('failed_native_recovery');
    await bindings.internalLifecycle.raiseFence({ accountId: human.accountId, key: `${human.accountId}:initial` });
    await startRecovery(human.accountId, human.email);
    const body = { account_id: human.accountId, token: delivery, new_password: nextPassword };
    const before = await snapshot(human.accountId);
    await authPool.query(`ALTER TABLE auth_recovery_establishment ADD CONSTRAINT test_fail_establishment
    CHECK (account_id <> '${human.accountId}') NOT VALID`);
    try {
      expect((await request('/recovery/complete', body)).status).toBe(503);
    } finally {
      await authPool.query('ALTER TABLE auth_recovery_establishment DROP CONSTRAINT test_fail_establishment');
    }
    const failed = await snapshot(human.accountId);
    expect(failed.credential).toEqual(before.credential);
    expect(failed.witness).toHaveLength(0);
    expect(failed.fence!.fenced).toBe(true);
    expect(await service.internal.resolveRecoveryEstablishment('a'.repeat(64))).toBeNull();
    fault = 'before';
    expect((await request('/recovery/complete', body)).status).toBe(503);
    fault = undefined;
    const committed = await snapshot(human.accountId);
    expect(committed.witness).toHaveLength(1);
    const reference = committed.witness[0]!.reference;
    const witness = await service.internal.resolveRecoveryEstablishment(reference);
    expect(witness).not.toBeNull();
    const expiredClock = createRecoveryCompletion({
      pool,
      routeKey: new Uint8Array(32).fill(71),
      auth: () => service,
      clock: () => new Date(witness!.expiresAt),
    });
    await expect(expiredClock.completeRecovery(reference)).rejects.toThrow();
    expect((await bindings.internalLifecycle.readFenceState(human.accountId))!.fenced).toBe(true);
    await bindings.internalLifecycle.raiseFence({ accountId: human.accountId, key: `${human.accountId}:superseded` });
    await expect(bindings.trustedAccess.completeRecovery!(reference)).rejects.toThrow();
    expect((await request('/recovery/complete', body)).status).toBe(401);
    expect((await snapshot(human.accountId)).credential).toEqual(committed.credential);
    for (const change of ['suspended', 'operator'] as const) {
      const id = (await person(`authority_${change}`)).accountId;
      await bindings.internalLifecycle.raiseFence({ accountId: id, key: `${id}:initial` });
      await startRecovery(id, `authority_${change}@recovery.test`);
      fault = 'before';
      expect(
        (await request('/recovery/complete', { account_id: id, token: delivery, new_password: nextPassword })).status,
      ).toBe(503);
      fault = undefined;
      const saved = await snapshot(id);
      if (change === 'suspended') await suspendAccount(pool, id);
      else
        await pool.query(`UPDATE access.account SET state=$2,operator_account_id=$3 WHERE account_id=$1`, [
          id,
          'active',
          change === 'operator' ? human.accountId : null,
        ]);
      await expect(bindings.trustedAccess.completeRecovery!(saved.witness[0]!.reference)).rejects.toThrow();
      expect((await bindings.internalLifecycle.readFenceState(id))!.fenced).toBe(true);
    }
  });
}
