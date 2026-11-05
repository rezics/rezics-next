import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { Pool } from 'pg';
import { betterAuthOptions } from '../src/better-auth.ts';
import { recoveryDelivery } from '../src/recovery-delivery.ts';
import { nativeErasurePage, startNativeErasure } from '../src/erasure-native.ts';
import { testDatabase } from '../scripts/database.ts';
import { issuer, nativeFixture } from './support/erasure-native.ts';

// Future native acceptance for src/external-custody-contract.md. Callback capture
// below observes the real producer; it never impersonates a receiving provider.
// Explicit missing-adoption failures must remain red until the actual owner API
// is composed. Do not replace them with test-only deletion certificates.
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

async function waitForDelivery(f: Awaited<ReturnType<typeof nativeFixture>>, accountId: string) {
  const until = Date.now() + 5000;
  for (;;) {
    const message = f.deliveries.find((delivery) => delivery.accountId === accountId);
    if (message) return message;
    if (Date.now() >= until) throw new Error('Native recovery producer did not invoke delivery');
    await Bun.sleep(10);
  }
}

test('actual recovery delivery admits the exact native copy identity before the adapter can retain mail or diagnostics', async () => {
  const f = await nativeFixture();
  try {
    const person = await f.person('external-delivery');
    expect((await f.call('/recovery/start', { email: person.email })).status).toBe(200);
    const message = await waitForDelivery(f, person.accountId);
    const proof = (
      await f.pool.query('SELECT account_id FROM auth_recovery WHERE proof_hash=$1', [hash(message.token)])
    ).rows[0];
    const rows = (
      await f.pool.query('SELECT id,value FROM verification WHERE identifier=$1', [`reset-password:${message.token}`])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(person.accountId);
    expect(proof.account_id).toBe(person.accountId);
    // The current Promise<void> producer has no stable receiving identity. This
    // assertion deliberately fails on its actual output, not on a mock receipt.
    expect(message).toHaveProperty('deliveryId', rows[0]!.id);
    throw new Error(
      'Missing adoption: atomic Auth delivery intent and actual adapter sink-generation/copy result binding; deliveryId alone is insufficient',
    );
  } finally {
    await f.close();
  }
}, 120_000);

test('a completed native send stays applicable after erasure and cannot certify deletion of provider diagnostics or unrelated living mail', async () => {
  const f = await nativeFixture();
  try {
    const victim = await f.person('external-retained');
    const living = await f.person('external-living');
    for (const person of [victim, living]) {
      expect((await f.call('/recovery/start', { email: person.email })).status).toBe(200);
      await waitForDelivery(f, person.accountId);
    }
    expect((await f.delete(victim)).status).toBe(200);
    const marker = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [victim.accountId])).rows[0]!;
    expect(marker.applicable).toBe(true);
    expect(marker.consent_completed_at).toBeNull();
    expect((await f.pool.query('SELECT 1 FROM auth_recovery WHERE account_id=$1', [victim.accountId])).rowCount).toBe(
      0,
    );
    expect((await f.pool.query('SELECT 1 FROM auth_recovery WHERE account_id=$1', [living.accountId])).rowCount).toBe(
      1,
    );
    // This array is source-call observation only. Clearing it would not erase a
    // provider queue, rotated log, diagnostic, versioned object or mailbox.
    expect(f.deliveries.some((message) => message.accountId === victim.accountId)).toBe(true);
    throw new Error(
      'Missing receiving interface: actual recovery mail adapter exact queue/message/diagnostic delete and irreversible verification, preserving living recipient copies',
    );
  } finally {
    await f.close();
  }
}, 120_000);

test('a late native reset callback crossing committed deletion needs receiver fencing and an exact late-copy result', async () => {
  const f = await nativeFixture();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let running: Promise<unknown> | undefined;
  try {
    const person = await f.person('external-late');
    const current = await f.bindings.trustedAccess.readAccount(person.accountId);
    let observed: unknown;
    const binding = recoveryDelivery(
      f.pool,
      {
        async deliver(message) {
          observed = message;
          entered();
          await held;
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
    running = binding.run({ accountId: person.accountId, epoch: current!.authnEpoch }, () =>
      auth.api.requestPasswordReset({ body: { email: person.email } }),
    );
    await Promise.race([
      reached,
      running.then(() => {
        throw new Error('Native reset returned without entering the callback');
      }),
      Bun.sleep(5000).then(() => {
        throw new Error('Native reset callback did not enter');
      }),
    ]);
    expect((await f.delete(person)).status).toBe(200);
    expect((await f.pool.query('SELECT 1 FROM auth_recovery WHERE account_id=$1', [person.accountId])).rowCount).toBe(
      0,
    );
    release();
    await running;
    expect(observed).toHaveProperty('accountId', person.accountId);
    throw new Error(
      'Missing receiving interface: a pre-T delivery crossing the closed receiver fence must refuse without a copy or erase its exact late copy before resolving the late item',
    );
  } finally {
    release();
    await running?.catch(() => {});
    await f.close();
  }
}, 120_000);

test('an absent native user and no configured delivery writer remain unknown, never sealed zero-data custody', async () => {
  const fixture = testDatabase();
  const pool = new Pool({ connectionString: fixture.url });
  try {
    const id = await startNativeErasure(pool, 'external-no-native-user', 7);
    const before = (await pool.query('SELECT applicable,inventory_coverage FROM auth_erasure WHERE id=$1', [id]))
      .rows[0];
    expect(before).toEqual({ applicable: false, inventory_coverage: 'unknown' });
    for (let page = 0; page < 100; page++) {
      const result = await nativeErasurePage(pool, id);
      if (result.state !== 'more') break;
      if (page === 99) throw new Error('Native empty inventory exceeded its fixed phase budget');
    }
    const saved = (await pool.query('SELECT applicable,inventory_coverage FROM auth_erasure WHERE id=$1', [id]))
      .rows[0];
    expect(saved).toEqual(before);
    throw new Error(
      'Missing producer interface: actual closed delivery/diagnostic writer generations and complete receiving coverage must prove sealed zero data; absent config/user/row cannot attest none',
    );
  } finally {
    await pool.end();
    fixture.close();
  }
}, 60_000);

for (const failure of ['unavailable', 'wrong sink generation', 'lost result after remote deletion'] as const) {
  test(`actual external diagnostics remain pending on ${failure}, including replay without payload redisclosure`, async () => {
    const fixture = testDatabase();
    const pool = new Pool({ connectionString: fixture.url });
    try {
      // Real native operating evidence establishes positive applicability even
      // when there is no native user. It must not become none on a second call.
      await pool.query(`INSERT INTO auth_effect_receipt (receipt_id,account_id,purpose,minimum_authn_epoch)
        VALUES ('diagnostic-source','diagnostic-subject','sessions',9)`);
      const id = await startNativeErasure(pool, 'diagnostic-subject', 9);
      expect(await startNativeErasure(pool, 'diagnostic-subject', 10)).toBe(id);
      expect((await pool.query('SELECT applicable,barrier FROM auth_erasure WHERE id=$1', [id])).rows[0]).toEqual({
        applicable: true,
        barrier: 9,
      });
      throw new Error(
        `Missing actual diagnostic receiving API: ${failure}; require exact original copy identity/version, bounded retry and verified result before closing custody, with unrelated living records preserved`,
      );
    } finally {
      await pool.end();
      fixture.close();
    }
  }, 60_000);
}
