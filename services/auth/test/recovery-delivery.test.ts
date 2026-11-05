import { trustedAccessPorts } from './support/trusted-access.ts';
import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { betterAuthOptions } from '../src/better-auth.ts';
import { recoveryDelivery } from '../src/recovery-delivery.ts';
import { readRecoveryCopySource, readRecoveryCopySourcePage } from '../src/recovery-copy-source.ts';
import { startNativeErasure } from '../src/erasure-native.ts';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount } from '../src/index.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const mailKey = (accountId: string) =>
  createHmac('sha256', 'persistent-recovery-delivery-secret-32-bytes')
    .update(JSON.stringify(['auth-recovery-mail-v1', accountId]))
    .digest('hex');

function trackQueries(target: Pool) {
  let inflight = 0;
  const query = target.query.bind(target);
  const connect = target.connect.bind(target) as {
    (): Promise<PoolClient>;
    (...args: unknown[]): void;
  };
  const tracked = (run: () => unknown) => {
    inflight++;
    try {
      return Promise.resolve(run()).finally(() => {
        inflight--;
      });
    } catch (error) {
      inflight--;
      throw error;
    }
  };
  const hasCallback = (args: unknown[]) => typeof args.at(-1) === 'function';
  const trackClient = (client: PoolClient) => {
    if (Object.hasOwn(client, 'trackedQuery')) return client;
    const clientQuery = client.query.bind(client);
    Object.defineProperty(client, 'trackedQuery', { value: true });
    client.query = ((...args: unknown[]) =>
      hasCallback(args)
        ? clientQuery(...(args as [string]))
        : tracked(() => clientQuery(...(args as [string])))) as PoolClient['query'];
    return client;
  };
  target.query = ((...args: unknown[]) =>
    hasCallback(args) ? query(...(args as [string])) : tracked(() => query(...(args as [string])))) as Pool['query'];
  target.connect = ((...args: unknown[]) =>
    hasCallback(args) ? connect(...args) : connect().then(trackClient)) as Pool['connect'];
  return async function settled() {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      if (inflight === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (inflight === 0) return;
      }
    }
  };
}

test('native failed mail deletes only its newly committed verification and proof; earlier and concurrent recovery remain valid', async () => {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url, max: 2 });
  const drain = trackQueries(database);
  try {
    const issuer = 'https://delivery.auth.test';
    const password = 'original sufficiently long password';
    const accounts = new Map<string, AccessAccount>(
      ['owner', 'independent'].map((accountId) => [
        accountId,
        {
          accountId,
          kind: 'actor',
          automated: false,
          state: 'pending',
          authnEpoch: 7,
        },
      ]),
    );
    const key = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'delivery',
    };
    let fail = false;
    let failedToken = '';
    let failedId = '';
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered = new Map<string, string>();
    let authorizations = 0;
    let recoveryReceipt: { accountId: string; receiptId: string; minimumAuthnEpoch: number } | undefined;
    const service = await createAuthService({
      database,
      issuer,
      audience: 'https://api.test',
      secret: 'persistent-recovery-delivery-secret-32-bytes',
      signing: { activeKid: key.kid, privateKeys: [key] },
      trustedAccess: trustedAccessPorts({
        async readFencedAccount(id) {
          return (await this.readAccount(id)) ?? (await this.readRecoveryAccount!(id));
        },
        readAccount: async (id) => accounts.get(id) ?? null,
        readRecoveryAccount: async (id) => accounts.get(id) ?? null,
        authorizeProvisioning: async (id) => ({ accountId: id }),
        async authorizeRecovery(input) {
          authorizations++;
          const account = accounts.get(input.accountId)!;
          expect(account.authnEpoch).toBe(input.proofEpoch);
          account.authnEpoch++;
          recoveryReceipt = {
            accountId: input.accountId,
            receiptId: input.operationKey!,
            minimumAuthnEpoch: account.authnEpoch,
          };
          return recoveryReceipt;
        },
        async completeRecovery(reference) {
          const witness = await service.internal.resolveRecoveryEstablishment(reference);
          if (
            !witness ||
            !recoveryReceipt ||
            witness.accountId !== recoveryReceipt.accountId ||
            witness.receiptId !== recoveryReceipt.receiptId ||
            witness.authnEpoch !== recoveryReceipt.minimumAuthnEpoch
          )
            throw new Error('Invalid completion');
        },
      }),
      recoveryDelivery: {
        async deliver(value) {
          const source = (await database.query('SELECT * FROM auth_recovery WHERE proof_hash=$1', [hash(value.token)]))
            .rows[0];
          const native = (
            await database.query('SELECT * FROM verification WHERE identifier=$1', [`reset-password:${value.token}`])
          ).rows;
          expect(native).toHaveLength(1);
          expect(source.account_id).toBe(value.accountId);
          expect(source.authn_epoch).toBe(7);
          expect(native[0].value).toBe(value.accountId);
          expect(native[0].expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300000);
          expect(value.expiresAt.getTime()).toBeLessThanOrEqual(native[0].expiresAt.getTime() + 1000);
          if (fail && value.accountId === 'owner') {
            failedToken = value.token;
            failedId = native[0].id;
            // Both earlier and later duplicate identifiers are legal in the real schema.
            // None of these rows was created by this native reset request.
            await database.query(
              `INSERT INTO verification (id,identifier,value,"createdAt","expiresAt")
              VALUES ('earlier-duplicate',$1,'owner',now()-interval '1 day',now()+interval '1 day'),
              ('later-duplicate',$1,'owner',now()+interval '1 day',now()+interval '2 days'),
              ('other-owner-duplicate',$1,'independent',now(),now()+interval '1 day')`,
              [`reset-password:${value.token}`],
            );
            entered();
            await held;
            throw new Error('Mail sink unavailable');
          }
          delivered.set(value.accountId, value.token);
        },
      },
    });
    const request = (path: string, body: unknown) =>
      service.handler(
        new Request(`${issuer}${path}`, {
          method: 'POST',
          headers: { origin: issuer, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    for (const account of accounts.values()) {
      await service.internal.provisionPassword({
        authorization: account.accountId,
        email: `${account.accountId}@example.test`,
        password,
      });
      account.state = 'active';
    }
    expect((await request('/recovery/start', { email: 'owner@example.test' })).status).toBe(200);
    await drain();
    const earlier = delivered.get('owner')!;
    expect(earlier).toBeString();
    const before = (await database.query('SELECT id,password,"updatedAt" FROM account ORDER BY id')).rows;
    fail = true;
    await database.query('DELETE FROM auth_attempt_counter WHERE key=$1', [mailKey('owner')]);
    const failing = request('/recovery/start', { email: 'owner@example.test' });
    await waiting;
    expect((await request('/recovery/start', { email: 'independent@example.test' })).status).toBe(200);
    release();
    expect((await failing).status).toBe(200);
    await drain();
    expect((await database.query('SELECT id FROM verification WHERE id=$1', [failedId])).rows).toHaveLength(0);
    expect(
      (await database.query('SELECT proof_hash FROM auth_recovery WHERE proof_hash=$1', [hash(failedToken)])).rows,
    ).toHaveLength(0);
    expect(
      (
        await database.query('SELECT id FROM verification WHERE id=ANY($1::text[])', [
          ['earlier-duplicate', 'later-duplicate', 'other-owner-duplicate'],
        ])
      ).rows,
    ).toHaveLength(3);
    expect((await database.query('SELECT id,password,"updatedAt" FROM account ORDER BY id')).rows).toEqual(before);
    expect(authorizations).toBe(0);
    expect([...accounts.values()].map((a) => a.authnEpoch)).toEqual([7, 7]);
    expect(
      (await request('/recovery/complete', { account_id: 'owner', token: failedToken, new_password: password })).status,
    ).toBe(401);
    for (const [id, token] of [
      ['owner', earlier],
      ['independent', delivered.get('independent')!],
    ]) {
      expect(
        (
          await request('/recovery/complete', {
            account_id: id,
            token,
            new_password: 'replacement sufficiently long password',
          })
        ).status,
      ).toBe(200);
    }
    expect(authorizations).toBe(2);
  } finally {
    await database.end();
    fixture.close();
  }
}, 60000);

test('actual native recovery INSERT commits typed Source before hooks and disclosure; void, ambiguous and late results retain the original custody', async () => {
  const fixture = testDatabase();
  // A callback can use this sole slot only if the native transaction/lease ended.
  const database = new Pool({ connectionString: fixture.url, max: 1 });
  try {
    for (const mode of ['void', 'throw', 'result', 'timeout', 'late'] as const) {
      const accountId = `source-${mode}`;
      const email = `${accountId}@example.test`;
      await database.query('INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,\'\',$2,false)', [
        accountId,
        email,
      ]);
      let deliveryId = '';
      let token = '';
      let calls = 0;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const binding = recoveryDelivery(
        database,
        {
          async deliver(message) {
            calls++;
            expect(message.deliveryId).toBe(deliveryId);
            expect(message.token).toBe(token);
            const source = (await readRecoveryCopySource(database, deliveryId))!;
            expect(source).toMatchObject({
              deliveryId,
              status: 'in-flight',
              custody: 'unknown',
              sinkGeneration: null,
              attempts: 1,
              code: 'receiving-result-unavailable',
              sourceComponent: 'verification',
            });
            expect(source.roles).toEqual({
              account_id: accountId,
              erasure_human_id: null,
              erasure_operator_id: null,
              erasure_client_owner_id: null,
              erasure_source_client_owner_id: null,
            });
            expect(JSON.stringify(source)).not.toContain(email);
            expect(JSON.stringify(source)).not.toContain(token);
            if (mode === 'throw') throw new Error(`private ${email} ${token}`);
            if (mode === 'timeout') await held;
            if (mode === 'result') return { erased: true, sinkGeneration: 'unverified-caller-claim' } as never;
            if (mode === 'late') {
              const obligation = await startNativeErasure(database, accountId, 7);
              expect(
                (
                  await database.query('SELECT applicable,recovery_copy_pending FROM auth_erasure WHERE id=$1', [
                    obligation,
                  ])
                ).rows[0],
              ).toEqual({ applicable: true, recovery_copy_pending: 'recovery-copy-custody' });
            }
          },
        },
        'https://source.auth.test',
      );
      const options = betterAuthOptions(
        database,
        'https://source.auth.test',
        'persistent-source-native-secret-at-least-32-bytes',
      );
      const native = betterAuth({
        ...options,
        emailAndPassword: { enabled: true, resetPasswordTokenExpiresIn: 300, sendResetPassword: binding.send },
        databaseHooks: {
          verification: {
            create: {
              async after(row, context) {
                deliveryId = row.id;
                token = row.identifier.slice('reset-password:'.length);
                const source = (await readRecoveryCopySource(database, deliveryId))!;
                expect(source).toMatchObject({ status: 'intent', attempts: 0, custody: 'unknown' });
                expect(source.expiresAt).toEqual(row.expiresAt);
                const nativeRows = (
                  await database.query(
                    `SELECT v.erasure_role_xid=s.erasure_role_xid AS same_transaction
                  FROM verification v JOIN auth_recovery_copy_source s ON s.delivery_id=v.id WHERE v.id=$1`,
                    [row.id],
                  )
                ).rows;
                expect(nativeRows).toEqual([{ same_transaction: true }]);
                await binding.hooks.create!.after!(row, context);
              },
            },
          },
        },
      });
      const outcome = { failed: false };
      try {
        await binding.run({ accountId, epoch: 7 }, () => native.api.requestPasswordReset({ body: { email } }), outcome);
      } finally {
        release();
      }
      expect(calls).toBe(1);
      expect(outcome.failed).toBe(mode === 'throw' || mode === 'timeout');
      const code =
        mode === 'throw'
          ? 'callback-failed'
          : mode === 'timeout'
            ? 'callback-timeout'
            : mode === 'result'
              ? 'unsupported-result'
              : 'legacy-void';
      expect(await readRecoveryCopySource(database, deliveryId)).toMatchObject({
        deliveryId,
        status: 'unknown',
        custody: 'unknown',
        attempts: 1,
        code,
      });
      const page = await readRecoveryCopySourcePage(database, { accountId, role: 'account_id' });
      expect(page).toEqual([{ deliveryId, status: 'unknown', custody: 'unknown', code }]);
      expect(Buffer.byteLength(JSON.stringify(page[0]))).toBeLessThanOrEqual(1024);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
      // Native cleanup/TTL does not remove a potentially retained external copy.
      await database.query('DELETE FROM auth_recovery WHERE account_id=$1', [accountId]);
      await database.query('DELETE FROM verification WHERE id=$1', [deliveryId]);
      expect(await readRecoveryCopySource(database, deliveryId)).toMatchObject({ custody: 'unknown', code });
      await expect(
        database.query('DELETE FROM auth_recovery_copy_source WHERE delivery_id=$1', [deliveryId]),
      ).rejects.toThrow('receiving disposition unavailable');
      await expect(binding.send({ user: { id: accountId, email }, token })).rejects.toThrow('provenance unavailable');
      expect(calls).toBe(1);
    }
    expect(await readRecoveryCopySourcePage(database, { accountId: 'unrelated', role: 'account_id' })).toEqual([]);
  } finally {
    await database.end();
    fixture.close();
  }
}, 60000);

test('Source recording failure rolls back the actual native verification INSERT and cannot be replaced with a later observation', async () => {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url, max: 1 });
  try {
    const options = betterAuthOptions(
      database,
      'https://atomic-source.auth.test',
      'persistent-atomic-source-secret-at-least-32-bytes',
    );
    await database.query(
      `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('atomic-source','','atomic@example.test',false)`,
    );
    await database.query(`CREATE FUNCTION reject_recovery_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected Source interruption'; END $$;
      CREATE TRIGGER aa_reject_source BEFORE INSERT ON auth_recovery_copy_source
      FOR EACH ROW EXECUTE FUNCTION reject_recovery_source()`);
    let hooks = 0;
    let calls = 0;
    const binding = recoveryDelivery(database, {
      async deliver() {
        calls++;
      },
    });
    const native = betterAuth({
      ...options,
      emailAndPassword: { enabled: true, resetPasswordTokenExpiresIn: 300, sendResetPassword: binding.send },
      databaseHooks: {
        verification: {
          create: {
            async after(row, context) {
              hooks++;
              await binding.hooks.create!.after!(row, context);
            },
          },
        },
      },
    });
    await expect(
      binding.run({ accountId: 'atomic-source', epoch: 7 }, () =>
        native.api.requestPasswordReset({ body: { email: 'atomic@example.test' } }),
      ),
    ).rejects.toThrow();
    expect(hooks).toBe(0);
    expect(calls).toBe(0);
    expect((await database.query('SELECT id FROM verification')).rows).toEqual([]);
    expect((await database.query('SELECT delivery_id FROM auth_recovery_copy_source')).rows).toEqual([]);
    expect((await database.query('SELECT proof_hash FROM auth_recovery')).rows).toEqual([]);
    await database.query('DROP TRIGGER aa_reject_source ON auth_recovery_copy_source');
    await database.query(`INSERT INTO verification (id,identifier,value,"expiresAt")
      VALUES ('historical-source','reset-password:old-proof','atomic-source',now()+interval '5 minutes')`);
    await expect(
      database.query(`INSERT INTO auth_recovery_copy_source(delivery_id) VALUES ('historical-source')`),
    ).rejects.toThrow('Source provenance unavailable');
  } finally {
    await database.end();
    fixture.close();
  }
}, 60000);

test('missing or mismatched native provenance fails closed; conflict preserves an earlier proof and repeated failure is idempotent', async () => {
  const fixture = testDatabase();
  const database = new Pool({ connectionString: fixture.url, max: 1 });
  try {
    await database.query(
      `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('owner','','owner@example.test',false)`,
    );
    for (const mode of ['missing', 'owner', 'token', 'expiry', 'path', 'ambiguous', 'conflict', 'failure'] as const) {
      await database.query('TRUNCATE auth_recovery,verification');
      let calls = 0;
      let token = '';
      let nativeId = '';
      let expiresAt = new Date();
      const delivery = recoveryDelivery(database, {
        async deliver(input) {
          calls++;
          expect(input.expiresAt).toEqual(expiresAt);
          expect(
            (await database.query('SELECT proof_hash FROM auth_recovery WHERE proof_hash=$1', [hash(token)])).rows,
          ).toHaveLength(1);
          throw new Error('Private mail contents must not escape');
        },
      });
      const options: BetterAuthOptions = {
        ...betterAuthOptions(database, 'https://provenance.auth.test', 'persistent-native-provenance-secret-32-bytes'),
        emailAndPassword: { enabled: true, resetPasswordTokenExpiresIn: 300, sendResetPassword: delivery.send },
        databaseHooks: {
          verification: {
            create: {
              async after(row, context) {
                token = row.identifier.slice('reset-password:'.length);
                nativeId = row.id;
                expiresAt = row.expiresAt;
                if (mode === 'missing') return;
                await delivery.hooks.create!.after!(
                  {
                    ...row,
                    value: mode === 'owner' ? 'other-owner' : row.value,
                    identifier: mode === 'token' ? 'reset-password:other-token' : row.identifier,
                    expiresAt: mode === 'expiry' ? new Date(0) : row.expiresAt,
                  },
                  mode === 'path' && context ? { ...context, path: '/elsewhere' } : context,
                );
                if (mode === 'ambiguous') await delivery.hooks.create!.after!(row, context);
                if (mode === 'conflict')
                  await database.query(
                    'INSERT INTO auth_recovery (proof_hash,account_id,authn_epoch,expires_at) VALUES ($1,$2,7,$3)',
                    [hash(token), 'owner', expiresAt],
                  );
              },
            },
          },
        },
      };
      const native = betterAuth(options);
      await delivery.run({ accountId: 'owner', epoch: 7 }, async () => {
        await native.api.requestPasswordReset({ body: { email: 'owner@example.test' } });
        if (mode === 'failure') {
          // Re-entering the callback cannot recreate an undelivered proof or
          // send again. Its exact cleanup already completed and stays complete.
          await expect(delivery.send({ user: { id: 'owner', email: 'owner@example.test' }, token })).rejects.toThrow(
            'provenance unavailable',
          );
        }
      });
      expect(calls).toBe(mode === 'failure' ? 1 : 0);
      expect((await database.query('SELECT id FROM verification WHERE id=$1', [nativeId])).rows).toHaveLength(
        mode === 'failure' || mode === 'conflict' ? 0 : 1,
      );
      const proofs = (await database.query('SELECT proof_hash,account_id,expires_at FROM auth_recovery')).rows;
      expect(proofs).toEqual(
        mode === 'conflict' ? [{ proof_hash: hash(token), account_id: 'owner', expires_at: expiresAt }] : [],
      );
      await expect(delivery.send({ user: { id: 'owner', email: 'owner@example.test' }, token })).rejects.toThrow(
        'provenance unavailable',
      );
    }
  } finally {
    await database.end();
    fixture.close();
  }
}, 60000);
