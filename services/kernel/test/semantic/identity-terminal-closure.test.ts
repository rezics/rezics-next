import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../../src/semantic/events.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { readIdentityMappings } from '../../src/semantic/identity-epoch-read.ts';
import {
  admitIdentityTerminalCapture,
  runIdentityTerminalCommand,
} from '../../src/semantic/identity-terminal-closure-command.ts';
import { IdentityTerminalClaimReleaseError } from '../../src/semantic/identity-terminal-closure-errors.ts';
import { home, seedLegacyRoot } from './support/identity-epoch.ts';
import {
  appendEdge,
  assertRetained,
  atBoundary,
  historicalEdge,
  isolatedDeployment,
  seedChain,
  settle,
  sourceHead,
  type Boundary,
} from './support/identity-terminal-closure.ts';

test('terminal directory preserves caller order, duplicate originals and positive epochs', async () => {
  const db = await isolatedDeployment();
  try {
    const [a, b, terminal] = (await seedChain(db, 2)) as [string, string, string];
    const self = await seedLegacyRoot(db, 0x7230);
    await db.install();
    expect((await settle(db, [a, b, terminal])).observed).toMatchObject({ state: 'mapped', original: a, terminal });
    expect((await settle(db, [self])).observed).toMatchObject({ state: 'mapped', original: self, terminal: self });
    const result = await readIdentityMappings(db.pool, [self, a, b, a]);
    expect(result.map((row) => row.state === 'mapped' && [row.original, row.terminal])).toEqual([
      [self, self],
      [a, terminal],
      [b, terminal],
      [a, terminal],
    ]);
    for (const row of result) if (row.state === 'mapped') expect(row.epoch).toBeGreaterThan(0n);
    await expect(readIdentityMappings(db.pool, Array(101).fill(a))).rejects.toThrow(RangeError);
  } finally {
    await db.close();
  }
});

for (const disposition of ['cycle', 'missing', 'deleted', 'moved', 'unknown'] as const) {
  test(`native ${disposition} retains unavailable custody without guessing a terminal`, async () => {
    const db = await isolatedDeployment();
    try {
      const ids = await seedChain(db, 2);
      const [a, b, terminal] = ids as [string, string, string];
      if (disposition === 'cycle') await historicalEdge(db, terminal, a);
      if (disposition === 'missing') await historicalEdge(db, b, newId(0x7340));
      if (disposition === 'deleted')
        await db.admin.query('DELETE FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
          routeOf(terminal),
          terminal,
        ]);
      await db.install();
      // These owners have not acquired closure custody; this tests unavailable
      // inputs, separately from the post-enrollment owner guard below.
      if (disposition === 'moved')
        await db.admin.query(
          "UPDATE core.partition SET write_state='moved',moved_to='missing-test-node' WHERE partition_no=$1",
          [home(b)],
        );
      if (disposition === 'unknown')
        await db.admin.query('DELETE FROM core.partition WHERE partition_no=$1', [home(b)]);
      for (let round = 0; round < 8; round++) {
        for (const partition of [...new Set(ids.map(home))]) {
          try {
            expect((await stepIdentityEpochBootstrap(db.pool, partition)).work.rows).toBeLessThanOrEqual(100);
          } catch (error) {
            expect(error).toMatchObject({ code: 'identity_epoch_unavailable' });
          }
        }
        expect((await readIdentityMappings(db.pool, [a]))[0]?.state).not.toBe('mapped');
        await assertRetained(db, a);
      }
    } finally {
      await db.close();
    }
  });
}

for (const boundary of ['receive', 'install', 'promote', 'ack'] as const satisfies readonly Boundary[]) {
  for (const aba of [false, true]) {
    test(`intermediate mutation${aba ? ' and ABA' : ''} after native ${boundary} fences pending fills and ACK`, async () => {
      const db = await isolatedDeployment();
      try {
        const ids = await seedChain(db, 2);
        const [a, b, terminal] = ids as [string, string, string];
        const replacement = await seedLegacyRoot(db, 0x7350);
        await db.install();
        let changed = false;
        const oldEnrollment = new Set<string>();
        await atBoundary(
          db,
          boundary,
          'after-commit',
          async () => {
            const locator = (
              await db.admin.query('SELECT closure_enrollment FROM semantic.identity_epoch_mapping WHERE original=$1', [
                a,
              ])
            ).rows[0];
            if (locator?.closure_enrollment) oldEnrollment.add(locator.closure_enrollment);
            await appendEdge(db, b, replacement);
            expect((await readIdentityMappings(db.pool, [a]))[0]?.state).not.toBe('mapped');
            if (aba) {
              expect((await settle(db, [...ids, replacement], b, 512)).observed).toMatchObject({
                state: 'mapped',
                terminal: replacement,
              });
              await appendEdge(db, b, terminal);
            }
            changed = true;
          },
          async () => {
            for (let round = 0; round < 128 && !changed; round++)
              for (const partition of [...new Set([...ids].reverse().map(home))]) {
                try {
                  await stepIdentityEpochBootstrap(db.pool, partition);
                } catch (error) {
                  expect(error).toMatchObject({ code: 'identity_epoch_unavailable' });
                }
              }
          },
          boundary === 'receive' || boundary === 'promote' ? home(terminal) : home(a),
          a,
        );
        expect(changed).toBe(true);
        expect((await settle(db, [...ids, replacement], a, 512)).observed).toMatchObject({
          state: 'mapped',
          original: a,
          terminal: aba ? terminal : replacement,
        });
        const current = (
          await db.admin.query('SELECT closure_enrollment FROM semantic.identity_epoch_mapping WHERE original=$1', [a])
        ).rows[0]!;
        expect(oldEnrollment.has(current.closure_enrollment)).toBe(false);
      } finally {
        await db.close();
      }
    });
  }
}

for (const boundary of [
  'export',
  'hold',
  'receive',
  'install',
  'promote',
  'ack',
] as const satisfies readonly Boundary[]) {
  test(`lost ${boundary} response recovers exact native enrollment and single directory membership`, async () => {
    const db = await isolatedDeployment();
    try {
      const ids = await seedChain(db, 2);
      const [a, , terminal] = ids as [string, string, string];
      await db.install();
      const lost = new Error(`test loses committed ${boundary} result`);
      await expect(
        atBoundary(
          db,
          boundary,
          'after-commit',
          async () => {
            throw lost;
          },
          async () => {
            for (let round = 0; round < 128; round++)
              for (const partition of [...new Set([...ids].reverse().map(home))])
                await stepIdentityEpochBootstrap(db.pool, partition);
          },
          undefined,
          boundary === 'export' ? undefined : a,
        ),
      ).rejects.toThrow(lost.message);
      const before = (
        await db.admin.query('SELECT closure_enrollment FROM semantic.identity_epoch_mapping WHERE original=$1', [a])
      ).rows[0];
      expect((await settle(db, ids, a, 512)).observed).toMatchObject({ state: 'mapped', original: a, terminal });
      const after = (
        await db.admin.query('SELECT closure_enrollment FROM semantic.identity_epoch_mapping WHERE original=$1', [a])
      ).rows[0]!;
      if (before) expect(after.closure_enrollment).toBe(before.closure_enrollment);
      expect(
        (
          await db.admin.query(
            `SELECT count(*)::integer n FROM semantic.identity_epoch_original o
        JOIN semantic.identity_epoch_group g USING(partition_no,terminal,generation)
        WHERE o.original=$1 AND o.closure_state='installed'`,
            [a],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
      expect(
        (
          await db.admin.query(
            `SELECT count(*)::integer n FROM semantic.identity_epoch_original o
        JOIN semantic.identity_epoch_group g USING(partition_no,terminal,generation)
        WHERE g.terminal=$1`,
            [terminal],
          )
        ).rows,
      ).toEqual([{ n: 3 }]);
    } finally {
      await db.close();
    }
  });
}

test('first enrollment after source export uses the changed successor instead of a released edge', async () => {
  const db = await isolatedDeployment();
  try {
    const ids = await seedChain(db, 2);
    const [a, b] = ids as [string, string, string];
    const replacement = await seedLegacyRoot(db, 0x7390);
    await db.install();
    await atBoundary(
      db,
      'export',
      'after-commit',
      () => appendEdge(db, b, replacement),
      () => stepIdentityEpochBootstrap(db.pool, home(a)),
      home(a),
    );
    expect((await settle(db, [...ids, replacement], a, 512)).observed).toMatchObject({
      state: 'mapped',
      original: a,
      terminal: replacement,
    });
  } finally {
    await db.close();
  }
});

test('cancelled first fill releases its successor ticket from the changed original home', async () => {
  const db = await isolatedDeployment();
  try {
    const ids = await seedChain(db, 2);
    const [a, b, terminal] = ids as [string, string, string];
    const replacement = await seedLegacyRoot(db, 0x73a0);
    await db.install();
    let cancelledEnrollment: string | null = null;
    await atBoundary(
      db,
      'hold',
      'after-commit',
      async () => {
        const held = (
          await db.admin.query(
            `SELECT closure_successor_ticket,closure_successor_original
        FROM semantic.identity_epoch_mapping WHERE route=$1 AND original=$2`,
            [routeOf(b), b],
          )
        ).rows[0]!;
        expect(held.closure_successor_original).toBe(a);
        cancelledEnrollment = held.closure_successor_ticket;
        await appendEdge(db, a, replacement);
        expect(
          (
            await db.admin.query(
              `SELECT closure_cancelled_successor FROM semantic.identity_epoch_mapping
        WHERE route=$1 AND original=$2`,
              [routeOf(a), a],
            )
          ).rows,
        ).toEqual([{ closure_cancelled_successor: true }]);
      },
      async () => {
        for (let round = 0; round < 128 && !cancelledEnrollment; round++)
          for (const partition of [...new Set([...ids].reverse().map(home))])
            await stepIdentityEpochBootstrap(db.pool, partition);
      },
      home(b),
      a,
    );
    expect(cancelledEnrollment).not.toBeNull();
    // Only A is driven here. B's native command is reached by A's retained
    // cancellation; it does not depend on a separate B worker invocation.
    await stepIdentityEpochBootstrap(db.pool, home(a));
    expect(
      (
        await db.admin.query(
          `SELECT closure_successor_ticket FROM semantic.identity_epoch_mapping
      WHERE route=$1 AND original=$2`,
          [routeOf(b), b],
        )
      ).rows,
    ).toEqual([{ closure_successor_ticket: null }]);
    expect((await settle(db, [...ids, replacement], a, 512)).observed).toMatchObject({
      state: 'mapped',
      original: a,
      terminal: replacement,
    });
    expect(
      (await readIdentityMappings(db.pool, [b, terminal])).map((row) => row.state === 'mapped' && row.terminal),
    ).toEqual([terminal, terminal]);
    expect(
      (
        await db.admin.query(
          `SELECT closure_cancelled_successor FROM semantic.identity_epoch_mapping
      WHERE route=$1 AND original=$2`,
          [routeOf(a), a],
        )
      ).rows,
    ).toEqual([{ closure_cancelled_successor: false }]);
  } finally {
    await db.close();
  }
});

test('ACK of h cannot erase a native h+1 committed after the ACK response', async () => {
  const db = await isolatedDeployment();
  try {
    const [a, terminal] = (await seedChain(db, 1)) as [string, string];
    const replacement = await seedLegacyRoot(db, 0x73b0);
    await db.install();
    let changed = false;
    await atBoundary(
      db,
      'ack',
      'after-commit',
      async () => {
        const h = await sourceHead(db, a);
        expect(h.revision).toBe(h.captured_revision);
        await appendEdge(db, a, replacement);
        const next = await sourceHead(db, a);
        expect(BigInt(next.revision)).toBeGreaterThan(BigInt(h.revision));
        expect(BigInt(next.captured_revision)).toBeLessThan(BigInt(next.revision));
        changed = true;
      },
      async () => {
        for (let round = 0; round < 128 && !changed; round++) {
          await stepIdentityEpochBootstrap(db.pool, home(terminal));
          try {
            await stepIdentityEpochBootstrap(db.pool, home(a));
          } catch (error) {
            expect(error).toMatchObject({ code: 'identity_epoch_unavailable' });
          }
        }
      },
      home(a),
      a,
    );
    expect((await readIdentityMappings(db.pool, [a]))[0]?.state).not.toBe('mapped');
    expect((await settle(db, [a, terminal, replacement], a, 256)).observed).toMatchObject({
      state: 'mapped',
      original: a,
      terminal: replacement,
    });
  } finally {
    await db.close();
  }
});

for (const drift of ['node', 'epoch', 'state', 'moved-to', 'delete'] as const) {
  test(`enrolled owner refuses ${drift} drift and ABA while position-only advancement has no dependency work`, async () => {
    const db = await isolatedDeployment();
    try {
      const ids = await seedChain(db, 2);
      const [a, b, terminal] = ids as [string, string, string];
      await db.install();
      expect((await settle(db, ids)).observed).toMatchObject({ state: 'mapped', original: a, terminal });
      const basis = (
        await db.admin.query(
          'SELECT node,epoch,write_state,moved_to,position::text FROM core.partition WHERE partition_no=$1',
          [home(b)],
        )
      ).rows[0]!;
      const sql =
        drift === 'node'
          ? 'UPDATE core.partition SET node=$2 WHERE partition_no=$1'
          : drift === 'epoch'
            ? 'UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1'
            : drift === 'state'
              ? "UPDATE core.partition SET write_state='moved',moved_to='missing-test-node' WHERE partition_no=$1"
              : drift === 'moved-to'
                ? 'UPDATE core.partition SET moved_to=$2 WHERE partition_no=$1'
                : 'DELETE FROM core.partition WHERE partition_no=$1';
      await expect(
        db.admin.query(sql, drift === 'node' || drift === 'moved-to' ? [home(b), randomUUID()] : [home(b)]),
      ).rejects.toThrow('identity_epoch_unavailable');
      expect(
        (
          await db.admin.query(
            'SELECT node,epoch,write_state,moved_to,position::text FROM core.partition WHERE partition_no=$1',
            [home(b)],
          )
        ).rows,
      ).toEqual([basis]);
      const head = await sourceHead(db, b);
      await runCommand(db.pool, { partition: home(b) }, async () => ({
        value: null,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: home(b), generation: '1' } }],
      }));
      expect(await sourceHead(db, b)).toEqual(head);
      expect((await readIdentityMappings(db.pool, [a]))[0]).toMatchObject({ state: 'mapped', terminal });
    } finally {
      await db.close();
    }
  });
}

test('rolled-back capture retains the old edge and never publishes its uncommitted replacement', async () => {
  const db = await isolatedDeployment();
  const writer = createPool(db.url);
  try {
    const ids = await seedChain(db, 2);
    const [a, b, terminal] = ids as [string, string, string];
    const replacement = await seedLegacyRoot(db, 0x73c0);
    await db.install();
    expect((await settle(db, ids)).observed).toMatchObject({ state: 'mapped', terminal });
    const rollback = new Error('test rolls back actual source capture');
    await expect(
      runIdentityTerminalCommand(writer, { partition: home(b) }, async (tx, { transactionId }) => {
        await admitIdentityTerminalCapture(tx, [b]);
        await tx.query(
          `INSERT INTO semantic.redirect(route,subject_id,sequence,target,recorded_transaction_id)
        SELECT $1,$2,max(sequence)+1,$3,$4 FROM semantic.redirect WHERE route=$1 AND subject_id=$2`,
          [routeOf(b), b, replacement, transactionId],
        );
        throw rollback;
      }),
    ).rejects.toThrow(rollback.message);
    const current = (
      await db.admin.query(
        'SELECT target FROM semantic.redirect WHERE route=$1 AND subject_id=$2 ORDER BY sequence DESC LIMIT 1',
        [routeOf(b), b],
      )
    ).rows[0];
    expect(current?.target).toBe(terminal);
    expect((await settle(db, ids, a, 256)).observed).toMatchObject({ state: 'mapped', original: a, terminal });
  } finally {
    await writer.end();
    await db.close();
  }
});

for (const failRelease of [false, true]) {
  test(`partial group acquisition releases earlier claims${failRelease ? ' despite a failed release home' : ''}`, async () => {
    const db = await isolatedDeployment();
    try {
      const pairs: { original: string; terminal: string }[] = [];
      for (let index = 0; index < 3; index++) {
        const original = await seedLegacyRoot(db, 0x7410);
        const terminal = await seedLegacyRoot(db, 0x7420 + index * 16);
        await historicalEdge(db, original, terminal);
        pairs.push({ original, terminal });
      }
      // The production command acquires groups in native UUID order.
      pairs.sort((a, b) => (a.terminal < b.terminal ? -1 : 1));
      const [first, second, third] = pairs as [(typeof pairs)[number], (typeof pairs)[number], (typeof pairs)[number]];
      const ids = pairs.flatMap((pair) => [pair.original, pair.terminal]);
      await db.install();
      for (const pair of pairs)
        expect((await settle(db, ids, pair.original, 256)).observed).toMatchObject({
          state: 'mapped',
          terminal: pair.terminal,
        });
      const acquisitionFailure = new Error('test fails the third native group close');
      const releaseFailure = new Error('test fails one native source release');
      const acquire = () =>
        atBoundary(
          db,
          'close',
          'before',
          async () => {
            throw acquisitionFailure;
          },
          () =>
            runIdentityTerminalCommand(db.pool, { partition: home(first.original) }, async (tx) => {
              await admitIdentityTerminalCapture(
                tx,
                pairs.map((pair) => pair.original),
              );
              throw new Error('source attempt must not pass partial acquisition');
            }),
          home(third.terminal),
        );
      const operation = failRelease
        ? () =>
            atBoundary(
              db,
              'claim-release',
              'before',
              async () => {
                throw releaseFailure;
              },
              acquire,
              home(first.original),
              first.original,
            )
        : acquire;
      let failure: unknown;
      try {
        await operation();
      } catch (error) {
        failure = error;
      }
      if (failRelease) {
        expect(failure).toBeInstanceOf(IdentityTerminalClaimReleaseError);
        if (!(failure instanceof IdentityTerminalClaimReleaseError)) throw failure;
        expect(failure.code).toBe('identity_epoch_unavailable');
        expect(failure.cause).toBe(acquisitionFailure);
        expect(failure.errors).toEqual([acquisitionFailure, releaseFailure]);
      } else expect(failure).toBe(acquisitionFailure);
      // The second completed group is released even if the first release fails.
      // No scheduler run or synthetic source acknowledgement intervenes here.
      const secondSource = (
        await db.admin.query(
          `SELECT closure_state,closure_claim FROM semantic.identity_epoch_mapping
        WHERE route=$1 AND original=$2`,
          [routeOf(second.original), second.original],
        )
      ).rows[0];
      expect(secondSource).toEqual({ closure_state: 'withdrawn', closure_claim: null });
      expect(
        (
          await db.admin.query(
            `SELECT count(*)::integer n FROM semantic.identity_epoch_original
        WHERE partition_no=$1 AND terminal=$2 AND closure_release_transaction IS NULL`,
            [home(second.terminal), second.terminal],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
      const firstClaim = (
        await db.admin.query(
          `SELECT closure_claim FROM semantic.identity_epoch_mapping
        WHERE route=$1 AND original=$2`,
          [routeOf(first.original), first.original],
        )
      ).rows[0]?.closure_claim;
      if (failRelease) expect(firstClaim).toEqual(expect.any(String));
      else expect(firstClaim).toBeNull();
      expect(
        (
          await db.admin.query(
            `SELECT closure_state FROM semantic.identity_epoch_group
        WHERE partition_no=$1 AND terminal=$2`,
            [home(third.terminal), third.terminal],
          )
        ).rows,
      ).toEqual([{ closure_state: 'open' }]);
    } finally {
      await db.close();
    }
  });
}
