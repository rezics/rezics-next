import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
