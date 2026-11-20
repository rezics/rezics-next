import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { betterAuthOptions } from '../src/better-auth.ts';
import { recoveryDelivery } from '../src/recovery-delivery.ts';
import { readRecoveryCopySource, readRecoveryCopySourcePage } from '../src/recovery-copy-source.ts';
import { publishErasureProofs } from '../src/erasure-history.ts';
import { nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';
import { testDatabase } from '../scripts/database.ts';
import { issuer, nativeErasureFixtures, type nativeFixture } from './support/erasure-native.ts';

const startFixture = nativeErasureFixtures();

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

async function startDelivery(
  f: Awaited<ReturnType<typeof nativeFixture>>,
  person: { email: string; accountId: string },
) {
  expect((await f.call('/recovery/start', { email: person.email })).status).toBe(200);
  const until = Date.now() + 5000;
  for (;;) {
    const message = f.deliveries.find((delivery) => delivery.accountId === person.accountId);
    if (message) {
      const rows = (
        await f.pool.query<{ id: string; value: string; same_transaction: boolean }>(
          `SELECT v.id,v.value,v.erasure_role_xid=s.erasure_role_xid AS same_transaction
           FROM verification v JOIN auth_recovery_copy_source s ON s.delivery_id=v.id WHERE v.identifier=$1`,
          [`reset-password:${message.token}`],
        )
      ).rows;
      expect(rows).toHaveLength(1);
      const native = rows[0]!;
      expect(native).toMatchObject({ value: person.accountId, same_transaction: true });
      expect(message).toHaveProperty('deliveryId', native.id);
      const source = await readRecoveryCopySource(f.pool, native.id);
      if (source?.status === 'in-flight' && Date.now() < until) {
        await Bun.sleep(10);
        continue;
      }
      expect(source).toMatchObject({
        deliveryId: native.id,
        roles: { account_id: person.accountId },
        sinkGeneration: null,
        custody: 'unknown',
        status: 'unknown',
        code: 'legacy-void',
        attempts: 1,
      });
      const proofHash = hash(message.token);
      expect(JSON.stringify(source)).not.toContain(message.token);
      expect(JSON.stringify(source)).not.toContain(proofHash);
      expect(JSON.stringify(source)).not.toContain(person.email);
      expect(
        (await f.pool.query('SELECT account_id FROM auth_recovery WHERE proof_hash=$1', [proofHash])).rows,
      ).toEqual([{ account_id: person.accountId }]);
      return { deliveryId: native.id, proofHash };
    }
    if (Date.now() >= until) throw new Error('Native recovery producer did not invoke delivery');
    await Bun.sleep(10);
  }
}

test('recovery delivery keeps its exact copy identity through the native erasure handoff while physical receiving stays pending', async () => {
  const f = await startFixture();
  try {
    const victim = await f.person('external-retained');
    const living = await f.person('external-living');
    const victimCopy = await startDelivery(f, victim);
    const livingCopy = await startDelivery(f, living);
    expect(victimCopy.deliveryId).not.toBe(livingCopy.deliveryId);

    const route = f.routeOf(victim.accountId)!;
    const partition = Math.floor(route / 16);
    expect(
      (await f.kernel.query('SELECT access.initialize_auth_erasure_partition($1) AS ready', [partition])).rows[0]
        ?.ready,
    ).toBe(true);
    expect((await f.delete(victim)).status).toBe(200);
    const ports = f.bindings.trustedAccess;
    const barrier = await ports.readAuthErasureBarrier!(victim.accountId);
    if (!barrier) throw new Error('Missing native deletion barrier');
    const marker = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [victim.accountId])).rows[0]!;
    expect(marker).toMatchObject({
      applicable: true,
      kernel_version: barrier.version,
      kernel_at: barrier.at,
      source_discharged_at: expect.any(Date),
      source_published_at: expect.any(Date),
      recovery_copy_pending: 'recovery-copy-custody',
      consent_completed_at: null,
    });
    expect(
      (
        await f.kernel.query(
          'SELECT version,at,custody_revision,physical_closure,receiving_closure FROM access.auth_receiving_obligation WHERE route=$1 AND account_id=$2',
          [route, victim.accountId],
        )
      ).rows,
    ).toEqual([
      {
        version: barrier.version,
        at: new Date(barrier.at),
        custody_revision: null,
        physical_closure: null,
        receiving_closure: null,
      },
    ]);

    expect(await publishErasureProofs(f.pool, ports, marker.id)).toBe(1);
    expect(
      await ports.publishAuthReceivingClosure!({ barrier, nativeObligationId: marker.id, deadline: Date.now() + 5000 }),
    ).toBe(false);
    expect((await f.pool.query('SELECT 1 FROM auth_receiving_work WHERE obligation_id=$1', [marker.id])).rowCount).toBe(
      0,
    );
    expect(
      (
        await f.kernel.query('SELECT phase FROM access.auth_history_proof WHERE route=$1 AND account_id=$2', [
          route,
          victim.accountId,
        ])
      ).rows,
    ).toEqual([{ phase: 'native-consumed' }]);
    expect(
      (
        await f.pool.query('SELECT account_id FROM auth_recovery WHERE proof_hash=ANY($1)', [
          [victimCopy.proofHash, livingCopy.proofHash],
        ])
      ).rows,
    ).toEqual([{ account_id: living.accountId }]);
    for (const [person, copy] of [
      [victim, victimCopy],
      [living, livingCopy],
    ] as const) {
      expect(await readRecoveryCopySourcePage(f.pool, { accountId: person.accountId, role: 'account_id' })).toEqual([
        { deliveryId: copy.deliveryId, custody: 'unknown', status: 'unknown', code: 'legacy-void' },
      ]);
      expect(f.deliveries.filter((message) => message.accountId === person.accountId)).toHaveLength(1);
    }
  } finally {
    await f.close();
  }
}, 120_000);

test('a native reset callback that returns after deletion leaves its original delivery unresolved', async () => {
  const f = await startFixture();
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<string>();
  let running: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let calls = 0;
  try {
    const person = await f.person('external-late');
    const current = await f.bindings.trustedAccess.readAccount(person.accountId);
    const binding = recoveryDelivery(
      f.pool,
      {
        async deliver(message) {
          calls++;
          entered.resolve(message.deliveryId);
          await held.promise;
        },
      },
      issuer,
    );
    const options = betterAuthOptions(f.pool, issuer, 'late-delivery-native-test-secret-at-least-32-bytes');
    const auth = betterAuth({
      ...options,
      emailAndPassword: {
        ...options.emailAndPassword,
        resetPasswordTokenExpiresIn: 300,
        sendResetPassword: binding.send,
      },
      databaseHooks: { verification: binding.hooks },
    });
    const reset = () =>
      binding.run({ accountId: person.accountId, epoch: current!.authnEpoch }, () =>
        auth.api.requestPasswordReset({ body: { email: person.email } }),
      );
    running = reset();
    const deliveryId = await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error('Native reset returned without entering the callback');
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Native reset callback did not enter')), 5000);
      }),
    ]);
    expect(await readRecoveryCopySource(f.pool, deliveryId)).toMatchObject({
      deliveryId,
      roles: { account_id: person.accountId },
      status: 'in-flight',
      code: 'receiving-result-unavailable',
      attempts: 1,
    });
    expect((await f.delete(person)).status).toBe(200);
    expect((await f.pool.query('SELECT 1 FROM auth_recovery WHERE account_id=$1', [person.accountId])).rowCount).toBe(
      0,
    );
    held.resolve();
    await running;
    await reset();
    expect(calls).toBe(1);
    expect(await readRecoveryCopySourcePage(f.pool, { accountId: person.accountId, role: 'account_id' })).toEqual([
      { deliveryId, status: 'unknown', custody: 'unknown', code: 'legacy-void' },
    ]);
    expect(
      (
        await f.pool.query('SELECT applicable,recovery_copy_pending FROM auth_erasure WHERE account_id=$1', [
          person.accountId,
        ])
      ).rows,
    ).toEqual([{ applicable: true, recovery_copy_pending: 'recovery-copy-custody' }]);
  } finally {
    clearTimeout(timer);
    held.resolve();
    await running?.catch(() => {});
    await f.close();
  }
}, 120_000);

test('an absent native user and no configured delivery writer leave coverage unknown across replay', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    const accountId = 'external-no-native-user';
    const id = await startNativeErasure(pool, accountId, 7);
    const read = async () =>
      (
        await pool.query(
          'SELECT applicable,barrier,inventory_coverage,recovery_copy_pending FROM auth_erasure WHERE id=$1',
          [id],
        )
      ).rows[0];
    const expected = {
      applicable: false,
      barrier: 7,
      inventory_coverage: 'unknown',
      recovery_copy_pending: 'recovery-copy-coverage',
    };
    expect(await read()).toEqual(expected);
    expect(await readRecoveryCopySourcePage(pool, { accountId, role: 'account_id' })).toEqual([]);
    for (let page = 0; page < 100; page++) {
      const result = await nativeErasurePage(pool, id);
      if (result.state !== 'more') break;
      if (page === 99) throw new Error('Native empty inventory exceeded its fixed phase budget');
    }
    expect(await startNativeErasure(pool, accountId, 9)).toBe(id);
    expect(await read()).toEqual(expected);
  } finally {
    await pool.end();
    fixture.close();
  }
}, 60_000);
