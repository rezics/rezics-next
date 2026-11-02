import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import {
  drainIdentityTerminalClosure,
  cleanIdentityTerminalClosure,
  releaseIdentityTerminalClaim,
} from '../../src/semantic/identity-terminal-closure.ts';
import { home } from './support/identity-epoch.ts';
import { atBoundary, isolatedDeployment, seedChain, settle } from './support/identity-terminal-closure.ts';

async function inventory(db: Awaited<ReturnType<typeof isolatedDeployment>>) {
  const rows = (
    await db.admin.query(`SELECT partition_no,slot,generation,closure_copies
    FROM semantic.identity_epoch_mapping_generation ORDER BY partition_no,slot`)
  ).rows;
  const byHome = new Map<number, number>();
  for (const row of rows) {
    expect(row.slot).toBeGreaterThanOrEqual(0);
    expect(row.slot).toBeLessThan(4);
    expect(row.closure_copies).toBeGreaterThanOrEqual(0);
    expect(row.closure_copies).toBeLessThanOrEqual(4096);
    byHome.set(row.partition_no, (byHome.get(row.partition_no) ?? 0) + row.closure_copies);
  }
  for (const copies of byHome.values()) expect(copies).toBeLessThanOrEqual(16384);
  const unreserved = (
    await db.admin.query(`SELECT o.original FROM semantic.identity_epoch_original o
    LEFT JOIN semantic.identity_epoch_mapping_generation g
      ON g.partition_no=o.partition_no AND g.generation=o.closure_reservation
    WHERE o.closure_reservation IS NOT NULL AND g.generation IS NULL
    UNION ALL SELECT m.original FROM semantic.identity_epoch_mapping m
    LEFT JOIN semantic.identity_epoch_mapping_generation g
      ON g.partition_no=m.route/16 AND g.generation=m.closure_source_reservation
    WHERE m.closure_source_reservation IS NOT NULL AND g.generation IS NULL`)
  ).rows;
  expect(unreserved).toEqual([]);
  return rows;
}

test('lost provisional registration keeps its same physical reservation until native ACK', async () => {
  const db = await isolatedDeployment();
  try {
    const ids = await seedChain(db, 2);
    await db.install();
    const lost = new Error('test loses actual registration commit');
    await expect(
      atBoundary(
        db,
        'receive',
        'after-commit',
        async () => {
          throw lost;
        },
        async () => {
          for (let round = 0; round < 128; round++)
            for (const partition of [...new Set([...ids].reverse().map(home))])
              await stepIdentityEpochBootstrap(db.pool, partition);
        },
        home(ids.at(-1)!),
        ids[0],
      ),
    ).rejects.toThrow(lost.message);
    await inventory(db);
    const pending = (
      await db.admin.query(
        `SELECT closure_enrollment,closure_reservation,
      closure_registration_transaction FROM semantic.identity_epoch_original WHERE original=$1`,
        [ids[0]],
      )
    ).rows[0]!;
    expect(pending.closure_reservation).not.toBeNull();
    expect((await settle(db, ids, ids[0], 512)).observed).toMatchObject({ state: 'mapped', terminal: ids.at(-1) });
    const installed = (
      await db.admin.query(
        `SELECT closure_enrollment,closure_reservation,
      closure_registration_transaction FROM semantic.identity_epoch_original WHERE original=$1`,
        [ids[0]],
      )
    ).rows[0]!;
    expect(installed).toEqual({ ...pending, closure_reservation: null });
    await inventory(db);
  } finally {
    await db.close();
  }
});

test('cohome drain replay does not allocate a fifth slot or duplicate retired members', async () => {
  const db = await isolatedDeployment();
  try {
    const ids = await seedChain(db, 105, 0x7510, 1);
    await db.install();
    expect((await settle(db, ids, ids[0], 1024)).observed).toMatchObject({ state: 'mapped', terminal: ids.at(-1) });
    const terminal = ids.at(-1)!;
    const claim = randomUUID();
    expect(await drainIdentityTerminalClosure(db.pool, terminal, claim)).toBeNull();
    const first = await inventory(db);
    expect(first.some((row) => row.generation === claim && row.closure_copies === ids.length)).toBe(true);
    const drained = await drainIdentityTerminalClosure(db.pool, terminal, claim);
    expect(drained).not.toBeNull();
    const sealed = await inventory(db);
    expect(sealed.find((row) => row.generation === claim)?.closure_copies).toBe(ids.length);
    const replay = await drainIdentityTerminalClosure(db.pool, terminal, claim);
    expect(replay).not.toBeNull();
    expect(await inventory(db)).toEqual(sealed);
    for (let page = 0; page < 4; page++) {
      await releaseIdentityTerminalClaim(db.pool, drained!);
      await cleanIdentityTerminalClosure(db.pool, terminal);
    }
    expect(
      (
        await db.admin.query(
          `SELECT 1 FROM semantic.identity_epoch_original
      WHERE terminal=$1 AND closure_claim=$2`,
          [terminal, claim],
        )
      ).rows,
    ).toEqual([]);
    expect((await inventory(db)).some((row) => row.generation === claim)).toBe(false);
  } finally {
    await db.close();
  }
});

/** Produce a real retained bootstrap position through Core. The fixture does
 * not insert an original, spent ticket, native commit or owner receipt by hand.
 */
