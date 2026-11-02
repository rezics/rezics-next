import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { drainIdentityTerminalClosure, cleanIdentityTerminalClosure, releaseIdentityTerminalClaim } from '../../src/semantic/identity-terminal-closure.ts';
import { home } from './support/identity-epoch.ts';
import { seedLegacyRoot } from './support/identity-epoch.ts';
import { runCommand } from '../../src/command/command.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../../src/command/dispatch-lifetime.ts';
import { IDENTITY_EPOCH_BOOTSTRAP } from '../../src/semantic/events.ts';
import { bindSemanticProducerRoles } from '../../src/semantic/erasure-producer.ts';
import { recordIdentityEpochNativeCommit } from '../../src/semantic/identity-epoch-store.ts';
import { withIdentityTerminalBootstrapOriginal, readIdentityTerminalOriginalOwner, retireIdentityTerminalOriginal,
  type IdentityTerminalOriginal } from '../../src/semantic/identity-terminal-closure-original.ts';
import { addIdentityTerminalCosts, IDENTITY_TERMINAL_AXES, IDENTITY_TERMINAL_OWNER_READ_PLAN,
  IDENTITY_TERMINAL_OWNER_READ_TOTAL, IDENTITY_TERMINAL_ORIGINAL_COSTS,
  requireIdentityTerminalExecutor } from '../../src/semantic/identity-terminal-closure-cost.ts';
import { atBoundary, isolatedDeployment, seedChain, settle } from './support/identity-terminal-closure.ts';
import { recordIdentityTerminalOriginalMaintenance, withIdentityTerminalMaintenanceOriginal,
  cleanupIdentityTerminalMaintenanceOriginal, type IdentityTerminalMaintenanceOriginal } from '../../src/semantic/identity-terminal-closure-maintenance.ts';
import { IDENTITY_TERMINAL_MAINTENANCE_PLAN, IDENTITY_TERMINAL_MAINTENANCE_TOTAL } from '../../src/semantic/identity-terminal-closure-maintenance-cost.ts';
import { reserveIdentityTerminalClosure } from '../../src/semantic/identity-epoch-mapping.ts';
import { runIdentityTerminalCommand } from '../../src/semantic/identity-terminal-closure-command.ts';

test('receipt-free source commands refuse the missing executor profile before checkout or body IO', async () => {
  const pool = new Pool();
  let entered = false;
  try {
    await expect(runIdentityTerminalCommand(pool, { partition: 1 }, async () => {
      entered = true;
      return { value: null, events: [] };
    })).rejects.toMatchObject({ code: 'identity_epoch_unavailable', operand: {
      owner: 'Core', callable: 'withCommandDispatchLifetime', profile: 'mutation-events-native-callbacks',
      producer: 'runIdentityTerminalCommand source discovery/attempt',
    } });
    expect(entered).toBe(false);
    expect(pool.totalCount).toBe(0);
    expect(pool.waitingCount).toBe(0);
  } finally { await pool.end(); }
});

async function inventory(db: Awaited<ReturnType<typeof isolatedDeployment>>) {
  const rows = (await db.admin.query(`SELECT partition_no,slot,generation,closure_copies
    FROM semantic.identity_epoch_mapping_generation ORDER BY partition_no,slot`)).rows;
  const byHome = new Map<number, number>();
  for (const row of rows) {
    expect(row.slot).toBeGreaterThanOrEqual(0);
    expect(row.slot).toBeLessThan(4);
    expect(row.closure_copies).toBeGreaterThanOrEqual(0);
    expect(row.closure_copies).toBeLessThanOrEqual(4096);
    byHome.set(row.partition_no, (byHome.get(row.partition_no) ?? 0) + row.closure_copies);
  }
  for (const copies of byHome.values()) expect(copies).toBeLessThanOrEqual(16384);
  const unreserved = (await db.admin.query(`SELECT o.original FROM semantic.identity_epoch_original o
    LEFT JOIN semantic.identity_epoch_mapping_generation g
      ON g.partition_no=o.partition_no AND g.generation=o.closure_reservation
    WHERE o.closure_reservation IS NOT NULL AND g.generation IS NULL
    UNION ALL SELECT m.original FROM semantic.identity_epoch_mapping m
    LEFT JOIN semantic.identity_epoch_mapping_generation g
      ON g.partition_no=m.route/16 AND g.generation=m.closure_source_reservation
    WHERE m.closure_source_reservation IS NOT NULL AND g.generation IS NULL`)).rows;
  expect(unreserved).toEqual([]);
  return rows;
}

test('lost provisional registration keeps its same paid physical reservation until native ACK', async () => {
  const db = await isolatedDeployment();
  try {
    const ids = await seedChain(db, 2);
    await db.install();
    const lost = new Error('test loses actual registration commit');
    await expect(atBoundary(db, 'receive', 'after-commit', async () => { throw lost; }, async () => {
      for (let round = 0; round < 128; round++)
        for (const partition of [...new Set([...ids].reverse().map(home))]) await stepIdentityEpochBootstrap(db.pool, partition);
    }, home(ids.at(-1)!), ids[0])).rejects.toThrow(lost.message);
    await inventory(db);
    const pending = (await db.admin.query(`SELECT closure_enrollment,closure_reservation,
      closure_registration_transaction FROM semantic.identity_epoch_original WHERE original=$1`, [ids[0]])).rows[0]!;
    expect(pending.closure_reservation).not.toBeNull();
    expect((await settle(db, ids, ids[0], 512)).observed).toMatchObject({ state: 'mapped', terminal: ids.at(-1) });
    const installed = (await db.admin.query(`SELECT closure_enrollment,closure_reservation,
      closure_registration_transaction FROM semantic.identity_epoch_original WHERE original=$1`, [ids[0]])).rows[0]!;
    expect(installed).toEqual({ ...pending, closure_reservation: null });
    await inventory(db);
  } finally { await db.close(); }
});

test('cohome drain replay does not allocate a fifth slot or repay retired members', async () => {
  const db = await isolatedDeployment();
  try {
    const ids = await seedChain(db, 105, 0x7510, 1);
    await db.install();
    expect((await settle(db, ids, ids[0], 1024)).observed).toMatchObject({ state: 'mapped', terminal: ids.at(-1) });
    const terminal = ids.at(-1)!;
    const claim = randomUUID();
    expect(await drainIdentityTerminalClosure(db.pool, terminal, claim)).toBeNull();
    const first = await inventory(db);
    expect(first.some(row => row.generation === claim && row.closure_copies === ids.length)).toBe(true);
    const drained = await drainIdentityTerminalClosure(db.pool, terminal, claim);
    expect(drained).not.toBeNull();
    const sealed = await inventory(db);
    expect(sealed.find(row => row.generation === claim)?.closure_copies).toBe(ids.length);
    const replay = await drainIdentityTerminalClosure(db.pool, terminal, claim);
    expect(replay).not.toBeNull();
    expect(await inventory(db)).toEqual(sealed);
    for (let page = 0; page < 4; page++) {
      await releaseIdentityTerminalClaim(db.pool, drained!);
      await cleanIdentityTerminalClosure(db.pool, terminal);
    }
    expect((await db.admin.query(`SELECT 1 FROM semantic.identity_epoch_original
      WHERE terminal=$1 AND closure_claim=$2`, [terminal, claim])).rows).toEqual([]);
    expect((await inventory(db)).some(row => row.generation === claim)).toBe(false);
  } finally { await db.close(); }
});

/** Produce a real retained bootstrap position through Core. The fixture does
 * not insert an original, spent ticket, native commit or owner receipt by hand.
 */
async function originalFixture() {
  const db = await isolatedDeployment();
  const id = await seedLegacyRoot(db, 0x7610);
  await db.install();
  const partition = home(id);
  const exported = await runCommand(db.pool, { partition }, async (tx, { transactionId }) => {
    bindSemanticProducerRoles(tx, []);
    await tx.query(`INSERT INTO semantic.identity_epoch_bootstrap_home
      (partition_no,phase,after_route,after_original,after_member,generation,owner_epoch)
      SELECT $1,'subjects',-1,$2,$2,1,epoch FROM core.partition WHERE partition_no=$1`,
    [partition, '00000000-0000-0000-0000-000000000000']);
    await tx.query(`INSERT INTO semantic.identity_epoch_bootstrap_page
      (partition_no,transaction_id,generation,phase,caught_up) VALUES($1,$2,1,'subjects',false)`,
    [partition, transactionId]);
    recordIdentityEpochNativeCommit(tx, 'bootstrap');
    return { value: null, events: [{ type: IDENTITY_EPOCH_BOOTSTRAP, data: { partition, generation: '1' } }] };
  });
  return { db, exported, partition, deadline: Date.now() + 5000,
    async acknowledge() {
      await runCommand(db.pool, { partition }, async (tx) => {
        bindSemanticProducerRoles(tx, []);
        await tx.query(`UPDATE semantic.identity_epoch_bootstrap_page SET acknowledged=true
          WHERE partition_no=$1 AND transaction_id=$2`, [partition, exported.transactionId]);
        return { value: null, events: [{ type: IDENTITY_EPOCH_BOOTSTRAP, data: { partition, generation: '1' } }] };
      });
    },
  };
}

const numbers = (values: readonly string[]) => values.map(Number);
const workVector = (cost: typeof IDENTITY_TERMINAL_OWNER_READ_TOTAL) => IDENTITY_TERMINAL_AXES.map(axis => cost[axis]);

test('native original commits before handle escape and debits the actual Core effect and cleanup before checkout', async () => {
  const f = await originalFixture();
  try {
    let escaped: IdentityTerminalOriginal | undefined;
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => {
      escaped = original;
      const admitted = (await f.db.admin.query(`SELECT ordinal,price,spent FROM semantic.identity_terminal_closure_original
        WHERE partition_no=$1 AND original_id=$2`, [f.partition, original.id])).rows[0]!;
      expect(admitted.ordinal).toBe(0);
      expect(numbers(admitted.price)).toEqual(workVector(IDENTITY_TERMINAL_OWNER_READ_TOTAL));
      expect(numbers(admitted.spent)).toEqual(workVector(IDENTITY_TERMINAL_OWNER_READ_PLAN.admission));
      expect(await readIdentityTerminalOriginalOwner(original)).toMatchObject({ partition: f.partition, epoch: f.exported.epoch });
      await expect(readIdentityTerminalOriginalOwner(original)).rejects.toThrow('unspent');
      const spent = (await f.db.admin.query(`SELECT o.ordinal,o.spent,t.price FROM semantic.identity_terminal_closure_original o
        JOIN semantic.identity_terminal_closure_ticket t USING(partition_no,original_id)
        WHERE o.partition_no=$1 AND o.original_id=$2`, [f.partition, original.id])).rows[0]!;
      expect(spent.ordinal).toBe(1);
      expect(numbers(spent.price)).toEqual(workVector(addIdentityTerminalCosts(
        IDENTITY_TERMINAL_OWNER_READ_PLAN.debit, IDENTITY_TERMINAL_OWNER_READ_PLAN.effect)));
      expect(numbers(spent.spent)).toEqual(workVector(addIdentityTerminalCosts(
        IDENTITY_TERMINAL_OWNER_READ_PLAN.admission, IDENTITY_TERMINAL_OWNER_READ_PLAN.debit,
        COMMAND_DISPATCH_ALLOWANCE.total.work,
        IDENTITY_TERMINAL_ORIGINAL_COSTS.ownerRead,
      )));
      await expect(readIdentityTerminalOriginalOwner({ ...original })).rejects.toThrow('copied');
      expect((await inventory(f.db)).reduce((sum, row) => sum + row.closure_copies, 0)).toBe(3);
    });
    await expect(readIdentityTerminalOriginalOwner(escaped!)).rejects.toThrow('escaped');
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => {
      expect(original.id).toBe(escaped!.id);
      await expect(readIdentityTerminalOriginalOwner(original)).rejects.toThrow('unspent');
    });
    await expect(withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline + 1, async () => null))
      .rejects.toThrow('immutable payload');
  } finally { await f.db.close(); }
});

for (const boundary of ['original-admission', 'original-debit', 'original-owner-read'] as const) {
  test(`native ${boundary} lost response or rollback does not refill the original`, async () => {
    const f = await originalFixture();
    try {
      const lost = new Error(`lost ${boundary}`);
      await expect(atBoundary(f.db, boundary, boundary === 'original-owner-read' ? 'before' : 'after-commit',
        async () => { throw lost; }, () => withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline,
          original => readIdentityTerminalOriginalOwner(original)), f.partition)).rejects.toThrow(lost.message);
      const before = (await f.db.admin.query(`SELECT original_id,ordinal,spent FROM semantic.identity_terminal_closure_original
        WHERE partition_no=$1`, [f.partition])).rows[0]!;
      expect(before.ordinal).toBe(boundary === 'original-admission' ? 0 : 1);
      const ledger = await inventory(f.db);
      await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => {
        if (boundary === 'original-admission') await readIdentityTerminalOriginalOwner(original);
        else await expect(readIdentityTerminalOriginalOwner(original)).rejects.toThrow('unspent');
      });
      expect(await inventory(f.db)).toEqual(ledger);
      if (boundary !== 'original-admission') {
        expect((await f.db.admin.query(`SELECT original_id,ordinal,spent FROM semantic.identity_terminal_closure_original
          WHERE partition_no=$1`, [f.partition])).rows[0]).toEqual(before);
      }
    } finally { await f.db.close(); }
  });
}

test('only native ACK and empty payload retire charged original and tickets; old position cannot readmit', async () => {
  const f = await originalFixture();
  try {
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => {
      await readIdentityTerminalOriginalOwner(original);
      await expect(f.db.admin.query(`UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1`, [f.partition]))
        .rejects.toThrow('identity_epoch_unavailable');
      await f.db.admin.query(`UPDATE core.partition SET position=position+1 WHERE partition_no=$1`, [f.partition]);
      await f.acknowledge();
      await retireIdentityTerminalOriginal(original);
    });
    expect((await f.db.admin.query(`SELECT 1 FROM semantic.identity_terminal_closure_original WHERE partition_no=$1`, [f.partition])).rows).toEqual([]);
    expect((await f.db.admin.query(`SELECT 1 FROM semantic.identity_terminal_closure_ticket WHERE partition_no=$1`, [f.partition])).rows).toEqual([]);
    expect((await inventory(f.db)).reduce((sum, row) => sum + row.closure_copies, 0)).toBe(0);
    expect(await inventory(f.db)).toEqual([]);
    await expect(withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async () => null))
      .rejects.toThrow('cannot admit');
  } finally { await f.db.close(); }
});

test('unavailable retirement remains spent and charged, and SQL cannot reset spent vectors', async () => {
  const f = await originalFixture();
  try {
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => {
      await readIdentityTerminalOriginalOwner(original);
      await expect(retireIdentityTerminalOriginal(original)).rejects.toThrow('native page ACK');
      const row = (await f.db.admin.query(`SELECT ordinal,spent FROM semantic.identity_terminal_closure_original
        WHERE partition_no=$1 AND original_id=$2`, [f.partition, original.id])).rows[0]!;
      expect(row.ordinal).toBe(2);
      expect(numbers(row.spent)).toEqual(workVector(IDENTITY_TERMINAL_OWNER_READ_TOTAL));
      await expect(f.db.admin.query(`UPDATE semantic.identity_terminal_closure_original
        SET spent=ARRAY[0,0,0,0,0,0,0,0]::bigint[] WHERE partition_no=$1 AND original_id=$2`,
      [f.partition, original.id])).rejects.toThrow('refill');
      expect((await inventory(f.db)).reduce((sum, ledger) => sum + ledger.closure_copies, 0)).toBe(3);
    });
  } finally { await f.db.close(); }
});

test('missing event/authorization profiles are typed operands rather than free children', () => {
  for (const profile of ['mutation-events-native-callbacks', 'principal-authorization-receipt'] as const) {
    expect(() => requireIdentityTerminalExecutor('native closure', profile)).toThrow(profile);
  }
  for (const axis of IDENTITY_TERMINAL_AXES) expect(Number.isSafeInteger(IDENTITY_TERMINAL_OWNER_READ_TOTAL[axis])).toBe(true);
  expect(() => addIdentityTerminalCosts({ ...IDENTITY_TERMINAL_OWNER_READ_TOTAL, bytes: Infinity })).toThrow(RangeError);
});


test('original identity rejects unbounded or invalid receipt shapes before native admission', async () => {
  const f = await originalFixture();
  try {
    for (const invalid of [
      { ...f.exported, transactionId: 'x'.repeat(10000) },
      { ...f.exported, epoch: 0 },
      { ...f.exported, partition: 4096 },
      { ...f.exported, position: 9223372036854775808n },
    ]) await expect(withIdentityTerminalBootstrapOriginal(f.db.pool, invalid, f.deadline, async () => null))
      .rejects.toThrow('Invalid native original identity');
    expect((await f.db.admin.query(`SELECT 1 FROM semantic.identity_terminal_closure_original
      WHERE partition_no=$1`, [f.partition])).rows).toEqual([]);
    expect(await inventory(f.db)).toEqual([]);
  } finally { await f.db.close(); }
});

/** The ACK and its cleanup grant are produced by a real event-bearing source
 * command, including its real native callback and fence. No grant is seeded.
 * This fixture exercises the owned metadata body; it supplies no production
 * funding or evidence that Core supports this event/callback selected profile.
 */
async function maintenanceGrant(f: Awaited<ReturnType<typeof originalFixture>>, deadline = Date.now() + 5000) {
  const native = await runCommand(f.db.pool, { partition: f.partition, deadline }, async tx => {
    bindSemanticProducerRoles(tx, []);
    await tx.query(`UPDATE semantic.identity_epoch_bootstrap_page SET acknowledged=true
      WHERE partition_no=$1 AND transaction_id=$2`, [f.partition, f.exported.transactionId]);
    recordIdentityTerminalOriginalMaintenance(tx, f.exported);
    return { value: null, events: [{ type: IDENTITY_EPOCH_BOOTSTRAP, data: { partition: f.partition, generation: '1' } }] };
  });
  return { ...native, deadline };
}

for (const ordinal of [0, 1, 2]) {
  test(`native maintenance transfers ordinal ${ordinal} custody without refund or another physical reservation`, async () => {
    const f = await originalFixture();
    try {
      let root = '';
      await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => {
        root = original.id;
        if (ordinal >= 1) await readIdentityTerminalOriginalOwner(original);
        if (ordinal === 2) await expect(retireIdentityTerminalOriginal(original)).rejects.toThrow('native page ACK');
      });
      const before = (await f.db.admin.query(`SELECT spent,price,reservation FROM semantic.identity_terminal_closure_original
        WHERE partition_no=$1 AND original_id=$2`, [f.partition, root])).rows[0]!;
      const native = await maintenanceGrant(f);
      const ledger = await inventory(f.db);
      let escaped: IdentityTerminalMaintenanceOriginal | undefined;
      const deadline = native.deadline;
      await withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, deadline, async original => {
        escaped = original;
        expect(await inventory(f.db)).toEqual(ledger);
        const transferred = (await f.db.admin.query(`SELECT spent,price,reservation,cleanup_id,ordinal
          FROM semantic.identity_terminal_closure_original WHERE partition_no=$1 AND original_id=$2`, [f.partition, root])).rows[0]!;
        expect(transferred).toEqual({ ...before, cleanup_id: original.id, ordinal: 2 });
        expect((await f.db.admin.query(`SELECT 1 FROM semantic.identity_terminal_closure_ticket
          WHERE partition_no=$1 AND original_id=$2`, [f.partition, root])).rows).toEqual([]);
        expect((await f.db.admin.query(`SELECT ordinal,spent,price FROM semantic.identity_terminal_closure_original
          WHERE partition_no=$1 AND original_id=$2`, [f.partition, original.id])).rows[0]).toEqual({
          ordinal: 0, spent: workVector(IDENTITY_TERMINAL_MAINTENANCE_PLAN.admission).map(String),
          price: workVector(IDENTITY_TERMINAL_MAINTENANCE_TOTAL).map(String),
        });
        await expect(cleanupIdentityTerminalMaintenanceOriginal({ ...original })).rejects.toThrow('copied');
        await cleanupIdentityTerminalMaintenanceOriginal(original);
      });
      await expect(cleanupIdentityTerminalMaintenanceOriginal(escaped!)).rejects.toThrow('escaped');
      expect((await f.db.admin.query(`SELECT 1 FROM semantic.identity_terminal_closure_original WHERE partition_no=$1`, [f.partition])).rows).toEqual([]);
      expect((await f.db.admin.query(`SELECT 1 FROM semantic.identity_terminal_closure_ticket WHERE partition_no=$1`, [f.partition])).rows).toEqual([]);
      expect(await inventory(f.db)).toEqual([]);
      expect((await f.db.admin.query(`SELECT closure_cleanup_complete FROM semantic.identity_epoch_bootstrap_page
        WHERE partition_no=$1 AND transaction_id=$2`, [f.partition, f.exported.transactionId])).rows[0]?.closure_cleanup_complete).toBe(true);
      await expect(withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, deadline, async () => null))
        .rejects.toThrow('current native ACK');
      await expect(withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async () => null))
        .rejects.toThrow('cannot admit');
    } finally { await f.db.close(); }
  });
}

for (const boundary of ['maintenance-admission', 'maintenance-debit', 'maintenance-cleanup'] as const) {
  test(`${boundary} lost commit reply retains the same immutable producer and physical custody`, async () => {
    const f = await originalFixture();
    try {
      let root = '';
      await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => { root = original.id; });
      const native = await maintenanceGrant(f);
      const deadline = native.deadline;
      const lost = new Error(`lost real ${boundary} reply`);
      await expect(atBoundary(f.db, boundary, 'after-commit', async () => { throw lost; }, () =>
        withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, deadline, original =>
          cleanupIdentityTerminalMaintenanceOriginal(original)), f.partition)).rejects.toThrow(lost.message);
      if (boundary === 'maintenance-cleanup') {
        expect(await inventory(f.db)).toEqual([]);
        await expect(withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, deadline, async () => null))
          .rejects.toThrow('current native ACK');
        return;
      }
      const prior = (await f.db.admin.query(`SELECT original_id,ordinal,spent FROM semantic.identity_terminal_closure_original
        WHERE partition_no=$1 AND predecessor=$2`, [f.partition, root])).rows[0]!;
      expect(prior.ordinal).toBe(boundary === 'maintenance-admission' ? 0 : 1);
      await expect(withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, deadline + 1, async () => null))
        .rejects.toThrow('current native ACK');
      await withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, deadline, async original => {
        expect(original.id).toBe(prior.original_id);
        if (boundary === 'maintenance-admission') await cleanupIdentityTerminalMaintenanceOriginal(original);
        else await expect(cleanupIdentityTerminalMaintenanceOriginal(original)).rejects.toThrow('spent');
      });
      if (boundary === 'maintenance-debit') {
        expect((await f.db.admin.query(`SELECT original_id,ordinal,spent FROM semantic.identity_terminal_closure_original
          WHERE partition_no=$1 AND predecessor=$2`, [f.partition, root])).rows[0]).toEqual(prior);
        expect((await inventory(f.db)).reduce((sum, row) => sum + row.closure_copies, 0)).toBe(3);
      }
    } finally { await f.db.close(); }
  });
}

test('a failed cleanup transfers only to a fresh actual native producer, never a refreshed callback', async () => {
  const f = await originalFixture();
  try {
    let root = '';
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => { root = original.id; });
    const first = await maintenanceGrant(f);
    const deadline = first.deadline;
    const failure = new Error('rollback actual cleanup body');
    await expect(atBoundary(f.db, 'maintenance-cleanup', 'before', async () => { throw failure; }, () =>
      withIdentityTerminalMaintenanceOriginal(f.db.pool, first, root, deadline, original => cleanupIdentityTerminalMaintenanceOriginal(original)),
    f.partition)).rejects.toThrow(failure.message);
    const ledger = await inventory(f.db);
    const previous = (await f.db.admin.query(`SELECT original_id,ordinal,spent FROM semantic.identity_terminal_closure_original
      WHERE partition_no=$1 AND predecessor=$2`, [f.partition, root])).rows[0]!;
    expect(previous.ordinal).toBe(1);
    expect(numbers(previous.spent)).toEqual(workVector(IDENTITY_TERMINAL_MAINTENANCE_TOTAL));
    await withIdentityTerminalMaintenanceOriginal(f.db.pool, first, root, deadline, async original => {
      await expect(cleanupIdentityTerminalMaintenanceOriginal(original)).rejects.toThrow('spent');
    });
    const second = await maintenanceGrant(f);
    expect(second.position).toBeGreaterThan(first.position);
    expect(second.transactionId).not.toBe(first.transactionId);
    await expect(withIdentityTerminalMaintenanceOriginal(f.db.pool, first, root, deadline, async () => null))
      .rejects.toThrow('current native ACK');
    await withIdentityTerminalMaintenanceOriginal(f.db.pool, second, root, second.deadline, async original => {
      expect(original.id).not.toBe(previous.original_id);
      expect(await inventory(f.db)).toEqual(ledger);
      expect((await f.db.admin.query(`SELECT 1 FROM semantic.identity_terminal_closure_original WHERE partition_no=$1 AND original_id=$2`,
      [f.partition, previous.original_id])).rows).toEqual([]);
      await cleanupIdentityTerminalMaintenanceOriginal(original);
    });
    expect(await inventory(f.db)).toEqual([]);
  } finally { await f.db.close(); }
});

test('admitted cleanup progresses with all four cohome slots full by transferring the same ticket roles', async () => {
  const f = await originalFixture();
  try {
    let root = '';
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => { root = original.id; });
    // These are genuine reserved provisional copies, not hand-written counters.
    for (const copies of [4093, 4096, 4096, 4096]) {
      await runCommand(f.db.pool, { partition: f.partition }, async (tx, { transactionId }) => {
        bindSemanticProducerRoles(tx, []);
        await tx.query("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [transactionId]);
        await reserveIdentityTerminalClosure(tx, randomUUID(), root, copies);
        return { value: null, events: [{ type: IDENTITY_EPOCH_BOOTSTRAP, data: { partition: f.partition, generation: '1' } }] };
      });
    }
    const full = await inventory(f.db);
    expect(full).toHaveLength(4);
    expect(full.reduce((sum, row) => sum + row.closure_copies, 0)).toBe(16384);
    const native = await maintenanceGrant(f);
    await withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, native.deadline, async original => {
      expect(await inventory(f.db)).toEqual(full);
      await expect(f.db.admin.query(`UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1`, [f.partition]))
        .rejects.toThrow('identity_epoch_unavailable');
      await f.db.admin.query(`UPDATE core.partition SET position=position+1 WHERE partition_no=$1`, [f.partition]);
      await cleanupIdentityTerminalMaintenanceOriginal(original);
    });
    expect((await inventory(f.db)).reduce((sum, row) => sum + row.closure_copies, 0)).toBe(16381);
    expect(await inventory(f.db)).toHaveLength(4);
  } finally { await f.db.close(); }
});

test('preparing maintenance revokes a spent owner observation at its actual effect-home query', async () => {
  const f = await originalFixture();
  try {
    let native: Awaited<ReturnType<typeof maintenanceGrant>> | undefined;
    let root = '';
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => {
      root = original.id;
      native = await maintenanceGrant(f);
      await expect(atBoundary(f.db, 'original-owner-read', 'before', async () => {
        await withIdentityTerminalMaintenanceOriginal(f.db.pool, native!, root, native!.deadline, async () => null);
      }, () => readIdentityTerminalOriginalOwner(original), f.partition)).rejects.toThrow(/owner unavailable|contention/);
    });
    expect((await f.db.admin.query(`SELECT ordinal,cleanup_id FROM semantic.identity_terminal_closure_original
      WHERE partition_no=$1 AND original_id=$2`, [f.partition, root])).rows[0]?.ordinal).toBe(2);
    expect((await inventory(f.db)).reduce((sum, row) => sum + row.closure_copies, 0)).toBe(3);
  } finally { await f.db.close(); }
});

test('an expired abandoned maintenance admission transfers its two roles without resetting either original', async () => {
  const f = await originalFixture();
  try {
    let root = '';
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => { root = original.id; });
    const deadline = Date.now() + 1000;
    const first = await maintenanceGrant(f, deadline);
    await expect(atBoundary(f.db, 'maintenance-admission', 'after-commit', async () => {
      await Bun.sleep(Math.max(1, deadline - Date.now() + 5));
    }, () => withIdentityTerminalMaintenanceOriginal(f.db.pool, first, root, deadline, async () => null), f.partition))
      .rejects.toThrow('arbiter');
    const expired = (await f.db.admin.query(`SELECT original_id,ordinal,spent,deadline::text
      FROM semantic.identity_terminal_closure_original WHERE partition_no=$1 AND predecessor=$2`, [f.partition, root])).rows[0]!;
    expect(expired.ordinal).toBe(0);
    expect(expired.deadline).toBe(String(deadline));
    expect(numbers(expired.spent)).toEqual(workVector(IDENTITY_TERMINAL_MAINTENANCE_PLAN.admission));
    const second = await maintenanceGrant(f);
    const ledger = await inventory(f.db);
    await withIdentityTerminalMaintenanceOriginal(f.db.pool, second, root, second.deadline, async original => {
      expect(original.id).not.toBe(expired.original_id);
      expect(await inventory(f.db)).toEqual(ledger);
      await cleanupIdentityTerminalMaintenanceOriginal(original);
    });
    expect(await inventory(f.db)).toEqual([]);
  } finally { await f.db.close(); }
});

test('a lost native grant reply recovers the actual committed receipt and cannot displace an unspent custodian', async () => {
  const f = await originalFixture();
  try {
    let root = '';
    await withIdentityTerminalBootstrapOriginal(f.db.pool, f.exported, f.deadline, async original => { root = original.id; });
    const lost = new Error('lost native ACK grant commit');
    await expect(atBoundary(f.db, 'maintenance-grant', 'after-commit', async () => { throw lost; }, () => maintenanceGrant(f), f.partition))
      .rejects.toThrow(lost.message);
    const committed = (await f.db.admin.query(`SELECT n.transaction_id,n.epoch,n.position::text,b.closure_cleanup_deadline::text AS deadline
      FROM semantic.identity_epoch_bootstrap_page b JOIN semantic.identity_epoch_native_commit n
        ON n.partition_no=b.partition_no AND n.transaction_id=b.closure_cleanup_transaction
      WHERE b.partition_no=$1 AND b.transaction_id=$2 AND n.purpose='bootstrap'`, [f.partition, f.exported.transactionId])).rows[0]!;
    const native = { partition: f.partition, transactionId: committed.transaction_id, epoch: committed.epoch, position: BigInt(committed.position), deadline: Number(committed.deadline) };
    await withIdentityTerminalMaintenanceOriginal(f.db.pool, native, root, native.deadline, async original => {
      await expect(maintenanceGrant(f)).rejects.toThrow('Unspent maintenance');
      const stillCurrent = (await f.db.admin.query(`SELECT closure_cleanup_transaction FROM semantic.identity_epoch_bootstrap_page
        WHERE partition_no=$1 AND transaction_id=$2`, [f.partition, f.exported.transactionId])).rows[0]!;
      expect(stillCurrent.closure_cleanup_transaction).toBe(native.transactionId);
      await cleanupIdentityTerminalMaintenanceOriginal(original);
    });
    expect(await inventory(f.db)).toEqual([]);
  } finally { await f.db.close(); }
});
