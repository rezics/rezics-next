import { afterAll, beforeAll, describe } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { advanceNativeErasure, openNativeErasure, NATIVE_ERASURE_GROUPS } from '../../src/access/erasure-native.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { nativeFixture, scopes } from './native-account-bindings-fixture.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { expect, test } from 'bun:test';
import type { AuthErasureObligation, AuthErasureObligationCursor } from '@rezics/auth-contract';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAuthErasureObligationBindings } from '../../src/access/auth-erasure-obligations.ts';
import { createAuthHistoryProofBindings } from '../../src/access/shared-history-auth.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { openGrowthDatabase } from '../support/growth.ts';

type Fixture = Awaited<ReturnType<typeof openGrowthDatabase>>;
const deadline = () => Date.now() + 10000;
async function person(db: Fixture, route: number) {
  const accountId = newId(route);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES($1,$2,'actor','active',$2)`,
    [route, accountId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$2,'account:delete','(,)'::tstzrange,$2)`,
    [route, accountId],
  );
  return accountId;
}
async function erase(db: Fixture, accountId: string) {
  const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const actor = await authenticateAccount(
    access,
    { pool: db.pool, deadline: deadline() },
    {
      accountId,
      clientId: 'auth-obligation-test',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
    },
  );
  return createLifecycleCommands({ pool: db.pool, access }).tombstone(
    { actor, deadline: deadline() },
    { accountId, key: Bun.randomUUIDv7() },
  );
}

test('Trusted Auth restore reconciliation discovers exact committed Access erasure obligations absent from an old Auth snapshot using native bounded partition-led sealed feed and exact immutable source floor without scanning living accounts or acknowledging cleanup', async () => {
  const db = await openGrowthDatabase();
  try {
    let historical: AuthErasureObligation[] = [];
    {
      // Simulate genuine rows committed before feed installation, preserving native
      // tombstone receipts. Only the new producer is disabled in this isolated fixture.
      await db.admin.query('ALTER TABLE access.erasure DISABLE TRIGGER auth_erasure_producer');
      const ids: string[] = [];
      try {
        for (let i = 0; i < 49; i++) {
          const id = await person(db, 0);
          await erase(db, id);
          ids.push(id);
        }
      } finally {
        await db.admin.query('ALTER TABLE access.erasure ENABLE TRIGGER auth_erasure_producer');
      }
      // An old floor can be recovered only from its retained native tombstone
      // receipt, never this unrelated later current floor.
      await db.admin.query('UPDATE access.account SET minimum_authn_epoch=99 WHERE route=0');
      const bootstrapPorts = createAuthErasureObligationBindings(db.pool);
      const bootstrapCut = crypto.randomUUID();
      await bootstrapPorts.startAuthErasureObligationCut({ cutId: bootstrapCut, deadline: deadline() });
      const cursor = { partition: 0, afterOrdinal: '0' };
      const first = await bootstrapPorts.pageAuthErasureObligations({
        cutId: bootstrapCut,
        cursor,
        deadline: deadline(),
      });
      expect(first).toMatchObject({ state: 'initializing', next: cursor, obligations: [] });
      expect((await db.admin.query('SELECT 1 FROM access.auth_erasure_obligation WHERE partition_no=0')).rowCount).toBe(
        48,
      );
      const page = await bootstrapPorts.pageAuthErasureObligations({
        cutId: bootstrapCut,
        cursor,
        deadline: deadline(),
      });
      expect(page.obligations).toHaveLength(48);
      expect(page.obligations.every((o) => o.minimumAuthnEpoch === '2')).toBe(true);
      expect(page.state).toBe('page');
      const tail = await bootstrapPorts.pageAuthErasureObligations({
        cutId: bootstrapCut,
        cursor: page.next!,
        deadline: deadline(),
      });
      expect(tail.obligations).toHaveLength(1);
      expect(new Set([...page.obligations, ...tail.obligations].map((o) => o.accountId))).toEqual(new Set(ids));
      historical = [...page.obligations, ...tail.obligations];
    }
    const accountId = await person(db, 0);
    const living = await person(db, 16);
    const native = await erase(db, accountId);
    const ports = createAuthBindings({ pool: db.pool, ...createAuthHistoryProofBindings(db.pool) });
    const original = await ports.readAuthErasureObligation({ accountId, deadline: deadline() });
    expect(original.state).toBe('ready');
    if (original.state !== 'ready') throw new Error('Missing native obligation');
    expect(original.obligation).toMatchObject({
      route: 0,
      accountId,
      version: 1,
      receiptId: native.value.receiptId,
      minimumAuthnEpoch: native.value.minimumAuthnEpoch,
    });
    expect(original.obligation.at).toBe((await ports.readAuthErasureBarrier!(accountId))!.at);
    expect(await ports.readAuthErasureSource!({ accountId, receiptId: native.value.receiptId })).toBeNull();
    // Later native floors cannot relabel the original tombstone floor.
    await db.admin.query(
      'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+7 WHERE route=0 AND account_id=$1',
      [accountId],
    );
    expect(await ports.readAuthErasureObligation({ accountId, deadline: deadline() })).toEqual(original);
    expect(await ports.readAuthErasureObligation({ accountId: living, deadline: deadline() })).toEqual({
      state: 'absent',
    });
    const cutId = crypto.randomUUID();
    const initial = await ports.startAuthErasureObligationCut({ cutId, deadline: deadline() });
    expect(await ports.startAuthErasureObligationCut({ cutId, deadline: deadline() })).toEqual(initial);
    expect((await ports.verifyAuthErasureObligationCut({ cutId, partition: 0, deadline: deadline() })).state).toBe(
      'pending',
    );
    let cursor: AuthErasureObligationCursor | null = { partition: 0, afterOrdinal: '0' };
    const recovered: AuthErasureObligation[] = [];
    while (cursor) {
      const page = await ports.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() });
      expect(page.obligations.length).toBeLessThanOrEqual(48);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
      expect(page.pending).toEqual([]);
      expect(['page', 'partition-end']).toContain(page.state);
      recovered.push(...page.obligations);
      if (page.next) expect(page.next.partition).toBe(cursor.partition + (page.state === 'partition-end' ? 1 : 0));
      cursor = page.next;
    }
    expect(recovered).toEqual([...historical, original.obligation]);
    expect(await ports.verifyAuthErasureObligationCut({ cutId, partition: 0, deadline: deadline() })).toMatchObject({
      state: 'current',
      highWater: original.obligation.ordinal,
      sourceEpoch: 1,
      sourceOwner: 'b',
    });
    // Cut exhaustion is not an ACK or a history/native cleanup proof.
    expect(
      (
        await db.admin.query('SELECT 1 FROM access.erasure_acknowledgement WHERE route=0 AND account_id=$1', [
          accountId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await db.admin.query('SELECT 1 FROM access.auth_history_proof WHERE route=0 AND account_id=$1', [accountId]))
        .rowCount,
    ).toBe(0);
    const later = await person(db, 0);
    await erase(db, later);
    expect((await ports.verifyAuthErasureObligationCut({ cutId, partition: 0, deadline: deadline() })).state).toBe(
      'pending',
    );
    const replay = await ports.pageAuthErasureObligations({
      cutId,
      cursor: { partition: 0, afterOrdinal: '0' },
      deadline: deadline(),
    });
    expect(replay.obligations).toEqual(historical.slice(0, 48));
    const laterPoint = await ports.readAuthErasureObligation({ accountId: later, deadline: deadline() });
    expect(laterPoint.state).toBe('ready');
    if (laterPoint.state === 'ready')
      expect(BigInt(laterPoint.obligation.ordinal)).toBeGreaterThan(BigInt(original.obligation.ordinal));
    await expect(
      ports.pageAuthErasureObligations({ cutId, cursor: { partition: 0, afterOrdinal: '999' }, deadline: deadline() }),
    ).rejects.toThrow();
    await expect(ports.readAuthErasureObligation({ accountId, deadline: Date.now() - 1 })).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 120000);

test('missing original native floor evidence remains pending and ownership changes refuse the source', async () => {
  const db = await openGrowthDatabase();
  try {
    const ports = createAuthErasureObligationBindings(db.pool);
    const missing = await person(db, 16);
    // A permanent root without original native floor evidence cannot be certified
    // from its current floor, even when the account is terminal and fenced.
    await db.admin.query(
      "UPDATE access.account SET state='deleted',authn_fenced=true,minimum_authn_epoch=123 WHERE route=16 AND account_id=$1",
      [missing],
    );
    await db.admin.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES(16,$1,1,clock_timestamp())', [
      missing,
    ]);
    const cutId = crypto.randomUUID();
    await ports.startAuthErasureObligationCut({ cutId, deadline: deadline() });
    let cursor: AuthErasureObligationCursor = { partition: 0, afterOrdinal: '0' };
    while (cursor.partition === 0) {
      const page = await ports.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() });
      cursor = page.next!;
    }
    const pending = await ports.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() });
    expect(pending).toMatchObject({
      state: 'pending',
      obligations: [],
      cut: { sealedPartitions: 1 },
      pending: [{ accountId: missing, reason: 'original-floor-unavailable' }],
    });
    expect(await ports.readAuthErasureObligation({ accountId: missing, deadline: deadline() })).toMatchObject({
      state: 'pending',
      reason: 'original-floor-unavailable',
    });
    expect((await ports.verifyAuthErasureObligationCut({ cutId, partition: 1, deadline: deadline() })).state).toBe(
      'pending',
    );
    await expect(
      db.admin.query(
        'UPDATE access.auth_erasure_obligation SET minimum_authn_epoch=123 WHERE route=16 AND account_id=$1',
        [missing],
      ),
    ).rejects.toThrow();
    await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=1');
    const afterMove = await person(db, 16);
    await erase(db, afterMove);
    expect(await ports.readAuthErasureObligation({ accountId: afterMove, deadline: deadline() })).toMatchObject({
      state: 'pending',
      reason: 'source-unavailable',
    });
    expect(await ports.readAuthErasureObligation({ accountId: missing, deadline: deadline() })).toMatchObject({
      state: 'pending',
      reason: 'source-unavailable',
    });
    expect(await ports.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() })).toMatchObject({
      state: 'pending',
      reason: 'source-unavailable',
    });
  } finally {
    await db.close();
  }
}, 120000);

describe('Access native terminal cleanup', () => {
  const pool = createPool(process.env.DATABASE_URL!);
  let auth: Awaited<ReturnType<typeof nativeFixture>>;
  let kernel: ReturnType<typeof createKernel>;
  const key = () => crypto.randomUUID();
  let prefix = 0;
  const person = () => auth.person(`native_erase_${key().replaceAll('-', '_')}_${prefix++}`);
  const context = async (bearer: string) => ({
    pool,
    deadline: Date.now() + 10000,
    actor: await auth.access.authenticate(bearer, { pool, deadline: Date.now() + 10000 }),
  });
  async function preferences(accountId: string, bearer: string, idempotencyKey: string) {
    return kernel.handle(
      new Request(`http://kernel.test/v1/accounts/${accountId}/preferences`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'idempotency-key': JSON.stringify(idempotencyKey),
        },
        body: JSON.stringify({
          expectedVersion: 0,
          spoilerLevel: 2,
          suitability: 'show',
          shelf: { gridSize: 'large', layouts: { all: 'table' }, tableColumns: ['title'] },
        }),
      }),
    );
  }
  async function snapshot(store: string, accountId: string) {
    // Independent exact locators, not discovery's output or participant completion.
    return (
      await pool.query(`SELECT * FROM access.${store} WHERE route=$1 AND account_id=$2`, [
        routeOf(accountId),
        accountId,
      ])
    ).rows;
  }
  async function ownerGroups(progressId: string) {
    // Stop at the first foreign role: this is a native page test, not a coverage waiver.
    while (
      (await pool.query('SELECT phase FROM access.erasure_native_progress WHERE progress_id=$1', [progressId])).rows[0]
        .phase < 2
    )
      await advanceNativeErasure(pool, progressId);
  }

  beforeAll(async () => {
    scopes.push('account:read', 'account:update', 'account:delete');
    auth = await nativeFixture(pool);
    kernel = createKernel({
      pool,
      routeKey: new Uint8Array(32).fill(28),
      tokens: auth.referenceKeys,
      receiptKeys: testReceiptKeys(),
      access: () => auth.access,
      writeRate: createWriteRateLimiter({
        secret: 'erasure-native-write-limiter-secret',
        overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
      }),
    });
  }, 120000);
  afterAll(async () => {
    try {
      await auth?.close();
    } finally {
      await pool.end();
    }
  });

  test('confirmed native deletion purges exact account resources, preserves survivors, and old bearer/replay cannot restore preferences', async () => {
    const erased = await person();
    const survivor = await person();
    const preferenceKey = key();
    expect((await preferences(erased.accountId, erased.bearer, preferenceKey)).status).toBe(200);
    expect((await preferences(survivor.accountId, survivor.bearer, key())).status).toBe(200);
    const survivorBefore = await snapshot('account_preferences', survivor.accountId);
    // A grant to a surviving account/resource survives even though its granter is erased.
    const ctx = await context(erased.bearer);
    await createGrantCommands({ pool, access: auth.access, managementAction: 'account:manage' }).create(ctx, {
      resource: { route: routeOf(erased.accountId)!, id: erased.accountId },
      subject: { kind: 'account', id: survivor.accountId },
      actions: ['account:read'],
      valid: '(,)',
      key: key(),
    });
    const target = await person();
    await createGrantCommands({ pool, access: auth.access, managementAction: 'account:manage' }).create(
      await context(target.bearer),
      {
        resource: { route: routeOf(target.accountId)!, id: target.accountId },
        subject: { kind: 'account', id: erased.accountId },
        actions: ['account:read'],
        valid: '(,)',
        key: key(),
      },
    );
    // Give the erasing human grant authority on a surviving resource via the ordinary command.
    await createGrantCommands({ pool, access: auth.access, managementAction: 'account:manage' }).create(
      await context(target.bearer),
      {
        resource: { route: routeOf(target.accountId)!, id: target.accountId },
        subject: { kind: 'account', id: erased.accountId },
        actions: ['account:manage'],
        valid: '(,)',
        key: key(),
      },
    );
    await createGrantCommands({ pool, access: auth.access, managementAction: 'account:manage' }).create(ctx, {
      resource: { route: routeOf(target.accountId)!, id: target.accountId },
      subject: { kind: 'account', id: survivor.accountId },
      actions: ['account:read'],
      valid: '(,)',
      key: key(),
    });
    const survivingGrant = (
      await pool.query('SELECT * FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
        routeOf(target.accountId),
        target.accountId,
        survivor.accountId,
      ])
    ).rows;
    expect(survivingGrant).toHaveLength(1);
    await deletePersona({ pool, auth }, erased);
    const progressId = await openNativeErasure(pool, erased.accountId);
    await ownerGroups(progressId);
    expect(await snapshot('account_preferences', erased.accountId)).toEqual([]);
    expect(
      (
        await pool.query('SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
          routeOf(erased.accountId),
          erased.accountId,
        ])
      ).rows,
    ).toEqual([]);
    expect(await snapshot('account_preferences', survivor.accountId)).toEqual(survivorBefore);
    expect(
      (
        await pool.query('SELECT * FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3', [
          routeOf(target.accountId),
          target.accountId,
          survivor.accountId,
        ])
      ).rows,
    ).toEqual(survivingGrant);
    expect((await preferences(erased.accountId, erased.bearer, preferenceKey)).status).toBe(401);
    expect((await preferences(erased.accountId, erased.bearer, key())).status).toBe(401);
    expect(await snapshot('account_preferences', erased.accountId)).toEqual([]);
    expect((await readErasureStatus(pool, erased.accountId))?.participants.access?.outcome).toBe('pending');
  }, 120000);

  test('purge and checkpoint roll back together; a lost committed response resumes from native state in a fresh pool', async () => {
    const erased = await person();
    await deletePersona({ pool, auth }, erased);
    const progressId = await openNativeErasure(pool, erased.accountId);
    await advanceNativeErasure(pool, progressId); // preferences: next phase owns default grants
    const before = (
      await pool.query('SELECT phase,page FROM access.erasure_native_progress WHERE progress_id=$1', [progressId])
    ).rows;
    await pool.query(`CREATE FUNCTION public.reject_native_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.phase <> OLD.phase OR NEW.page <> OLD.page THEN RAISE EXCEPTION 'native checkpoint failed'; END IF;
      RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER reject_native_checkpoint BEFORE UPDATE ON access.erasure_native_progress
      FOR EACH ROW EXECUTE FUNCTION public.reject_native_checkpoint()`);
    try {
      await expect(advanceNativeErasure(pool, progressId)).rejects.toThrow('native checkpoint failed');
    } finally {
      await pool.query('DROP TRIGGER reject_native_checkpoint ON access.erasure_native_progress');
      await pool.query('DROP FUNCTION public.reject_native_checkpoint()');
    }
    expect(
      (await pool.query('SELECT phase,page FROM access.erasure_native_progress WHERE progress_id=$1', [progressId]))
        .rows,
    ).toEqual(before);
    expect(
      (
        await pool.query('SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
          routeOf(erased.accountId),
          erased.accountId,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);
    await advanceNativeErasure(pool, progressId); // committed page, simulate losing its response
    const restarted = createPool(process.env.DATABASE_URL!);
    try {
      expect(await openNativeErasure(restarted, erased.accountId)).toBe(progressId);
      await advanceNativeErasure(restarted, progressId);
    } finally {
      await restarted.end();
    }
    expect(
      (
        await pool.query('SELECT 1 FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
          routeOf(erased.accountId),
          erased.accountId,
        ])
      ).rowCount,
    ).toBe(0);
    const copiedKeys = await pool.query(
      `SELECT result FROM access.erasure_progress
      WHERE route=$1 AND account_id=$2 AND store='resource_grant' AND role='resource_id'`,
      [routeOf(erased.accountId), erased.accountId],
    );
    expect(copiedKeys.rows[0].result).toBeNull();
  }, 120000);

  test('missing permanent obligation cannot open native work or mutate a surviving account', async () => {
    const survivor = await person();
    const before = await snapshot('account', survivor.accountId);
    await expect(openNativeErasure(pool, survivor.accountId)).rejects.toThrow();
    expect(await snapshot('account', survivor.accountId)).toEqual(before);
    expect(NATIVE_ERASURE_GROUPS()).toContainEqual(['resource_grant', 'subject_id']);
    expect(NATIVE_ERASURE_GROUPS()).toContainEqual(['resource_role_grant', 'subject_id']);
    expect(NATIVE_ERASURE_GROUPS()).toContainEqual(['resource_denial', 'subject_id']);
  });

  test('native cleanup severs bootstrap attribution and rate associations without reopening either owner', async () => {
    const erased = await person();
    const survivor = await person();
    const { bootstrapGovernance, BootstrapGovernanceUnavailableError, PLATFORM_RESOURCE } =
      await import('../../src/access/bootstrap-governance.ts');
    await bootstrapGovernance(pool, erased.accountId);
    const retained = await context(erased.bearer);
    const surviving = await context(survivor.bearer);
    const limiter = createWriteRateLimiter({ secret: 'native-erasure-account-binding-secret' });
    expect(await limiter.spend(retained, 'write')).toEqual({ allowed: true });
    expect(await limiter.spend(surviving, 'write')).toEqual({ allowed: true });
    const nativeRates = (accountId: string) =>
      pool.query(
        `SELECT identity_digest,family,count,expires_at,account_id FROM access.write_rate_counter
       WHERE route=$1 AND account_id=$2 ORDER BY identity_digest,family`,
        [routeOf(accountId), accountId],
      );
    expect((await nativeRates(erased.accountId)).rows.length).toBeGreaterThan(0);
    const survivorBefore = (await nativeRates(survivor.accountId)).rows;
    await deletePersona({ pool, auth }, erased);
    // This object was authenticated before T. No bearer reauthentication is used
    // to obtain the denial: the counter's own transaction must enforce the fence.
    await expect(limiter.spend(retained, 'write')).rejects.toThrow();
    const progressId = await openNativeErasure(pool, erased.accountId);
    const lastRate = NATIVE_ERASURE_GROUPS().findIndex(([store]) => store === 'write_rate_counter');
    for (;;) {
      const progress = await pool.query('SELECT phase FROM access.erasure_native_progress WHERE progress_id=$1', [
        progressId,
      ]);
      if (progress.rows[0].phase > lastRate) break;
      await advanceNativeErasure(pool, progressId);
    }
    expect((await nativeRates(erased.accountId)).rows).toEqual([]);
    const bootstrap = await pool.query(
      'SELECT route,resource_id,account_id,transaction_id FROM access.governance_bootstrap WHERE route=$1 AND resource_id=$2',
      [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id],
    );
    expect(bootstrap.rows).toEqual([
      { route: 0, resource_id: PLATFORM_RESOURCE.id, account_id: null, transaction_id: null },
    ]);
    await expect(bootstrapGovernance(pool, survivor.accountId)).rejects.toBeInstanceOf(
      BootstrapGovernanceUnavailableError,
    );
    expect((await nativeRates(survivor.accountId)).rows).toEqual(survivorBefore);
    await expect(limiter.spend(retained, 'write')).rejects.toThrow();
    expect((await nativeRates(erased.accountId)).rows).toEqual([]);
    expect((await readErasureStatus(pool, erased.accountId))?.participants.access?.outcome).toBe('pending');
  }, 600000);
});
