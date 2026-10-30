import receivingBasis from './identity-epoch-bootstrap-basis.sql';
import saveBasis from './identity-epoch-bootstrap-save-basis.sql';
import bootstrapSelectBootstrapTopology from './identity-epoch-bootstrap-select-bootstrap-topology.sql';
import bootstrapSelectBootstrapPage from './identity-epoch-bootstrap-select-bootstrap-page.sql';
import bootstrapSelectBootstrapRow from './identity-epoch-bootstrap-select-bootstrap-row.sql';
import bootstrapInsertBootstrapHome from './identity-epoch-bootstrap-insert-bootstrap-home.sql';
import bootstrapSelectBootstrapHome from './identity-epoch-bootstrap-select-bootstrap-home.sql';
import bootstrapSelectBootstrapPage2 from './identity-epoch-bootstrap-select-bootstrap-page-2.sql';
import bootstrapSelectDirty from './identity-epoch-bootstrap-select-dirty.sql';
import bootstrapUpdateBootstrapHome from './identity-epoch-bootstrap-update-bootstrap-home.sql';
import bootstrapInsertBootstrapPage from './identity-epoch-bootstrap-insert-bootstrap-page.sql';
import bootstrapInsertBootstrapRow from './identity-epoch-bootstrap-insert-bootstrap-row.sql';
import bootstrapSelectBootstrapCustody from './identity-epoch-bootstrap-select-bootstrap-custody.sql';
import bootstrapSelectControl from './identity-epoch-bootstrap-select-control.sql';
import bootstrapInsertGroup from './identity-epoch-bootstrap-insert-group.sql';
import bootstrapSelectOriginal from './identity-epoch-bootstrap-select-original.sql';
import bootstrapUpdateOriginal from './identity-epoch-bootstrap-update-original.sql';
import bootstrapUpdateGroup from './identity-epoch-bootstrap-update-group.sql';
import bootstrapInsertOriginal from './identity-epoch-bootstrap-insert-original.sql';
import bootstrapUpdateGroup2 from './identity-epoch-bootstrap-update-group-2.sql';
import bootstrapWithLegacyMember from './identity-epoch-bootstrap-with-legacy-member.sql';
import bootstrapInsertBootstrapCustody from './identity-epoch-bootstrap-insert-bootstrap-custody.sql';
import bootstrapSelectBootstrapPage3 from './identity-epoch-bootstrap-select-bootstrap-page-3.sql';
import bootstrapSelectBootstrapHome2 from './identity-epoch-bootstrap-select-bootstrap-home-2.sql';
import bootstrapInsertMapping from './identity-epoch-bootstrap-insert-mapping.sql';
import bootstrapUpdateDirty from './identity-epoch-bootstrap-update-dirty.sql';
import bootstrapUpdateMemberDirty from './identity-epoch-bootstrap-update-member-dirty.sql';
import bootstrapUpdateBootstrapPage from './identity-epoch-bootstrap-update-bootstrap-page.sql';
import bootstrapDeleteBootstrapRow from './identity-epoch-bootstrap-delete-bootstrap-row.sql';
import bootstrapUpdateBootstrapHome2 from './identity-epoch-bootstrap-update-bootstrap-home-2.sql';
import bootstrapSelectBootstrapTopology2 from './identity-epoch-bootstrap-select-bootstrap-topology-2.sql';
import bootstrapSelectBootstrapHome3 from './identity-epoch-bootstrap-select-bootstrap-home-3.sql';
import bootstrapSelectBootstrapTopology3 from './identity-epoch-bootstrap-select-bootstrap-topology-3.sql';
import bootstrapInsertTopologyCustody from './identity-epoch-bootstrap-insert-topology-custody.sql';
import bootstrapUpdateBootstrapTopology from './identity-epoch-bootstrap-update-bootstrap-topology.sql';
import closeHome from './identity-epoch-bootstrap-close-home.sql';
import closureReceipt from './identity-epoch-bootstrap-closure-receipt.sql';
import advanceCursor from './identity-epoch-bootstrap-advance-cursor.sql';
import installGate from './identity-epoch-bootstrap-install-gate.sql';
import type { Pool } from 'pg';
import { noEffect, registerCommandCallback, runCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { withReadTransaction } from './read.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { IdentityEpochStoreError, recordIdentityEpochNativeCommit } from './identity-epoch-store.ts';
import { IDENTITY_EPOCH_BOOTSTRAP, IDENTITY_EPOCH_PROGRESS, IDENTITY_EPOCH_BOOTSTRAP_SCHEDULED } from './events.ts';
import type { IdentityNativeReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import subjects from './identity-epoch-bootstrap-subjects.sql';
import members from './identity-epoch-bootstrap-members.sql';
import dirty from './identity-epoch-bootstrap-dirty.sql';
import memberDirty from './identity-epoch-bootstrap-member-dirty.sql';

const NIL = '00000000-0000-0000-0000-000000000000';
type Phase = 'subjects' | 'members' | 'dirty' | 'member-dirty';
type Row = {
  route: number;
  original: string;
  terminal: string;
  source_revision: string;
  present: boolean;
  previous_partition?: number | null;
  previous_terminal?: string | null;
};
type Page = { generation: bigint; phase: Phase; caughtUp: boolean; native: IdentityNativeReceipt; rows: Row[] };
export type IdentityEpochBootstrapProgress = Readonly<{
  partition: number;
  generation: bigint;
  state: 'more' | 'caught-up';
  native: IdentityNativeReceipt;
  work: NativeStepWork;
}>;
export const identityBootstrapWake = (partition: number, generation: bigint) => ({
  type: IDENTITY_EPOCH_BOOTSTRAP,
  data: { partition, generation: generation.toString() },
});
const fail = () =>
  new IdentityEpochStoreError('identity_epoch_unavailable', 'Bootstrap owner or native custody unavailable');

/** Topology is closed by the native scheduler, including empty homes. No caller readiness setter. */
export async function readIdentityEpochCutover(tx: CommandTransaction) {
  const owner = await readPartition(tx, 0);
  const row = (await tx.query(bootstrapSelectBootstrapTopology.sql)).rows[0];
  return { state: owner?.writeState === 'active' && row?.remaining === 0 ? ('ready' as const) : ('blocked' as const) };
}

async function readPage(pool: Pool, partition: number): Promise<Page | null> {
  return withReadTransaction(pool, async (tx) => {
    const owner = await readPartition(tx, partition);
    if (!owner || owner.writeState !== 'active') throw fail();
    const page = (await tx.query(bootstrapSelectBootstrapPage.sql, [partition])).rows[0];
    if (!page) return null;
    if (page.epoch !== owner.epoch || BigInt(page.position) > owner.position) throw fail();
    const rows = (await tx.query(bootstrapSelectBootstrapRow.sql, [partition, page.transaction_id])).rows as Row[];
    return {
      generation: BigInt(page.generation),
      phase: page.phase,
      caughtUp: page.caught_up,
      native: { partition, epoch: page.epoch, position: BigInt(page.position), transactionId: page.transaction_id },
      rows,
    };
  });
}

/** A retained source export, receiving native custody, then a separate source ACK of captured heads only. */
export async function stepIdentityEpochBootstrap(
  pool: Pool,
  partition: number,
): Promise<IdentityEpochBootstrapProgress> {
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid bootstrap home');
  const work = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
  const query = async (tx: CommandTransaction, sql: string, values: unknown[] = []) => {
    work.statements++;
    const result = await tx.query(sql, values);
    work.points += result.rowCount ?? 0;
    return result;
  };
  let page = await readPage(pool, partition);
  work.statements += page ? 3 : 2;
  if (!page) {
    const exported = await runCommand<Omit<Page, 'native'> | null>(pool, { partition }, async (tx) => {
      await query(tx, bootstrapInsertBootstrapHome.sql, [partition, partition * 16 - 1, NIL]);
      const saved = (await query(tx, bootstrapSelectBootstrapHome.sql, [partition])).rows[0];
      const owner = await readPartition(tx, partition);
      if (!saved || !owner || owner.epoch !== saved.owner_epoch || owner.writeState !== 'active') throw fail();
      const pending = (await query(tx, bootstrapSelectBootstrapPage2.sql, [partition])).rowCount;
      if (pending) return noEffect(null);
      let phase = saved.phase as Phase;
      const args = {
        first_route: partition * 16,
        last_route: partition * 16 + 15,
        after_route: saved.after_route,
        after_original: saved.after_original,
        after_member: saved.after_member,
      };
      let rows: Row[] = [];
      for (;;) {
        work.statements++;
        rows =
          phase === 'subjects'
            ? await subjects.run(tx, args)
            : phase === 'members'
              ? await members.run(tx, args)
              : phase === 'dirty'
                ? await dirty.run(tx, args)
                : await memberDirty.run(tx, args);
        if (rows.length || phase === 'member-dirty') break;
        phase = phase === 'subjects' ? 'members' : phase === 'members' ? 'dirty' : 'member-dirty';
        args.after_route = partition * 16 - 1;
        args.after_original = NIL;
        args.after_member = NIL;
      }
      work.rows = rows.length;
      work.bytes = Buffer.byteLength(JSON.stringify(rows));
      const last = rows.at(-1);
      const next: Phase =
        rows.length === 100
          ? phase
          : phase === 'subjects'
            ? 'members'
            : phase === 'members'
              ? 'dirty'
              : phase === 'dirty'
                ? 'member-dirty'
                : 'dirty';
      const caughtUp =
        phase === 'member-dirty' &&
        rows.length === 0 &&
        !(await query(tx, bootstrapSelectDirty.sql, [partition * 16, partition * 16 + 15])).rowCount;
      const generation = BigInt(saved.generation) + 1n;
      await query(tx, bootstrapUpdateBootstrapHome.sql, [
        partition,
        next,
        next === phase && last ? last.route : partition * 16 - 1,
        next === phase && last ? (phase === 'members' ? last.terminal : last.original) : NIL,
        next === phase && last && phase === 'members' ? last.original : NIL,
        generation.toString(),
      ]);
      recordIdentityEpochNativeCommit(tx, 'bootstrap');
      registerCommandCallback(tx, async (transactionId) => {
        await query(tx, bootstrapInsertBootstrapPage.sql, [
          partition,
          transactionId,
          generation.toString(),
          phase,
          caughtUp,
        ]);
        await query(tx, bootstrapInsertBootstrapRow.sql, [partition, transactionId, JSON.stringify(rows)]);
      });
      return {
        value: { generation, phase, caughtUp, rows },
        events: [{ ...identityBootstrapWake(partition, generation), type: IDENTITY_EPOCH_PROGRESS }],
      };
    });
    page = exported.value
      ? {
          ...exported.value,
          native: {
            partition: exported.partition,
            epoch: exported.epoch,
            position: exported.position,
            transactionId: exported.transactionId,
          },
        }
      : await readPage(pool, partition);
    if (!page) throw fail();
  } else {
    work.rows = page.rows.length;
    work.bytes = Buffer.byteLength(JSON.stringify(page.rows));
  }
  const retained = page;
  const mappingEpochs = new Map<string, string>();
  const withdrawals = new Map<number, Row[]>();
  for (const row of retained.rows) {
    if (
      row.previous_partition != null &&
      row.previous_terminal &&
      (!row.present || row.previous_terminal !== row.terminal)
    )
      withdrawals.set(row.previous_partition, [...(withdrawals.get(row.previous_partition) ?? []), row]);
  }
  // Every old home commits withdrawal custody before any new home can add this export.
  // The retained source page survives uncertainty at either side of the handoff.
  for (const [destination, rows] of withdrawals) {
    await runCommand(pool, { partition: destination }, async (tx) => {
      await query(tx, bootstrapSelectControl.sql, [destination]);
      const duplicate = (
        await query(tx, bootstrapSelectBootstrapCustody.sql, [
          destination,
          partition,
          retained.generation.toString(),
          'withdraw',
        ])
      ).rows[0];
      if (duplicate) {
        if (duplicate.native_transaction_id !== retained.native.transactionId) throw fail();
        return noEffect(null);
      }
      for (const row of rows) {
        const previous = (await query(tx, bootstrapSelectOriginal.sql, [destination, row.original])).rows[0];
        if (!previous) continue;
        if (previous.pending_job || previous.terminal !== row.previous_terminal) throw fail();
        await query(tx, bootstrapUpdateOriginal.sql, [previous.generation, row.original, destination]);
        await query(tx, bootstrapUpdateGroup.sql, [previous.terminal, destination]);
      }
      await query(tx, bootstrapInsertBootstrapCustody.sql, [
        destination,
        partition,
        retained.generation.toString(),
        retained.native.transactionId,
        retained.native.epoch,
        retained.native.position.toString(),
        'withdraw',
      ]);
      return {
        value: null,
        events: [{ ...identityBootstrapWake(partition, retained.generation), type: IDENTITY_EPOCH_PROGRESS }],
      };
    });
  }
  // Each receiving group home is visited independently. Source clients have already been released.
  const homes = new Map<number, Row[]>();
  for (const row of retained.rows) {
    const destination = partitionOf(routeOf(row.terminal)!);
    homes.set(destination, [...(homes.get(destination) ?? []), row]);
  }
  // Empty exports still require real receiving custody, never a count-only closure.
  if (!homes.size) homes.set(partition, []);
  for (const [destination, rows] of homes) {
    await runCommand(pool, { partition: destination }, async (tx, { transactionId }) => {
      const duplicate = (
        await query(tx, bootstrapSelectBootstrapCustody.sql, [
          destination,
          partition,
          retained.generation.toString(),
          'add',
        ])
      ).rows[0];
      if (duplicate && duplicate.native_transaction_id !== retained.native.transactionId) throw fail();
      const existingBasis = (
        await query(tx, receivingBasis.sql, [
          destination,
          partition,
          retained.generation.toString(),
          retained.native.transactionId,
          JSON.stringify(rows),
        ])
      ).rows[0];
      if (existingBasis) return noEffect(null);

      // Serialize receiving first absence under the actual native home fence.
      await query(tx, bootstrapSelectControl.sql, [destination]);
      const owner = await readPartition(tx, destination);
      if (!owner || owner.writeState !== 'active') throw fail();
      if (retained.phase === 'subjects' || retained.phase === 'dirty') {
        for (const row of rows) {
          if (!row.present) continue;
          const header = (await query(tx, bootstrapInsertGroup.sql, [destination, row.terminal, owner.epoch])).rows[0];
          if (header.pending_job || header.owner_epoch !== owner.epoch) throw fail();
          const previous = (await query(tx, bootstrapSelectOriginal.sql, [destination, row.original])).rows[0];
          if (previous?.pending_job) throw fail();
          if (previous && previous.terminal !== row.terminal) {
            await query(tx, bootstrapUpdateOriginal.sql, [previous.generation, row.original, destination]);
            await query(tx, bootstrapUpdateGroup.sql, [previous.terminal, destination]);
          }
          const changed = !previous || previous.terminal !== row.terminal || !row.present;
          await query(tx, bootstrapInsertOriginal.sql, [
            destination,
            header.generation,
            row.original,
            row.terminal,
            partition,
            retained.generation.toString(),
            row.present,
          ]);
          if (changed)
            await query(tx, bootstrapUpdateGroup2.sql, [
              row.terminal,
              row.present ? 1 : previous ? -1 : 0,
              destination,
            ]);
          if (
            (await query(tx, installGate.sql, [destination, row.terminal, row.original, transactionId])).rowCount !== 1
          )
            throw fail();
        }
      } else {
        await query(tx, bootstrapWithLegacyMember.sql, [
          JSON.stringify(rows),
          destination,
          partition,
          retained.generation.toString(),
        ]);
      }
      await query(tx, bootstrapInsertBootstrapCustody.sql, [
        destination,
        partition,
        retained.generation.toString(),
        retained.native.transactionId,
        retained.native.epoch,
        retained.native.position.toString(),
        'add',
      ]);
      recordIdentityEpochNativeCommit(tx, 'bootstrap');
      registerCommandCallback(tx, async (transactionId) => {
        if (
          (
            await query(tx, saveBasis.sql, [
              destination,
              partition,
              retained.generation.toString(),
              retained.native.transactionId,
              transactionId,
            ])
          ).rowCount !== 1
        )
          throw fail();
      });
      return {
        value: null,
        events: [{ ...identityBootstrapWake(partition, retained.generation), type: IDENTITY_EPOCH_PROGRESS }],
      };
    });
    const basis = await withReadTransaction(
      pool,
      async (tx) =>
        (
          await query(tx, receivingBasis.sql, [
            destination,
            partition,
            retained.generation.toString(),
            retained.native.transactionId,
            JSON.stringify(rows),
          ])
        ).rows[0],
    );
    if (!basis) throw fail();
    for (const entry of basis.mapping) mappingEpochs.set(entry.original, entry.epoch);
  }
  // Receiving custody committed before this source transaction. Only captured h is acknowledged; h+1 survives.
  const acknowledged = await runCommand(pool, { partition }, async (tx) => {
    const saved = (await query(tx, bootstrapSelectBootstrapPage3.sql, [partition, retained.native.transactionId]))
      .rows[0];
    if (saved?.acknowledged) {
      const home = (await query(tx, bootstrapSelectBootstrapHome2.sql, [partition])).rows[0];
      return noEffect(home?.sealed_generation !== null);
    }
    const owner = await readPartition(tx, partition);
    if (!owner || owner.writeState !== 'active' || owner.epoch !== retained.native.epoch) throw fail();
    const data = JSON.stringify(
      retained.rows.map((row) => {
        const mapping_epoch = mappingEpochs.get(row.original);
        if (row.present && (retained.phase === 'subjects' || retained.phase === 'dirty') && !mapping_epoch)
          throw fail();
        return { ...row, mapping_epoch };
      }),
    );
    if (retained.phase === 'subjects' || retained.phase === 'dirty') {
      await query(tx, bootstrapInsertMapping.sql, [data, retained.native.epoch, retained.native.transactionId]);
      await query(tx, bootstrapUpdateDirty.sql, [data]);
    } else {
      await query(tx, bootstrapUpdateMemberDirty.sql, [data]);
    }
    await query(tx, bootstrapUpdateBootstrapPage.sql, [partition, retained.native.transactionId]);
    await query(tx, bootstrapDeleteBootstrapRow.sql, [partition, retained.native.transactionId]);
    let sealed = false;
    if (retained.caughtUp) {
      recordIdentityEpochNativeCommit(tx, 'bootstrap');
      const closed = await query(tx, bootstrapUpdateBootstrapHome2.sql, [
        partition,
        retained.generation.toString(),
        partition * 16,
        partition * 16 + 15,
      ]);
      sealed = closed.rowCount === 1;
      if (sealed)
        registerCommandCallback(tx, async (transactionId) => {
          const receipt = await query(tx, closeHome.sql, [partition, transactionId]);
          if (receipt.rowCount !== 1) throw fail();
        });
    }
    return {
      value: sealed,
      events: [{ ...identityBootstrapWake(partition, retained.generation), type: IDENTITY_EPOCH_PROGRESS }],
    };
  });
  return {
    partition,
    generation: retained.generation,
    state: acknowledged.value ? 'caught-up' : 'more',
    native: retained.native,
    work,
  };
}

/** The default worker and native fixtures call this same bounded topology scheduler. */
export async function stepIdentityEpochBootstrapWork(
  pool: Pool,
  schedule = true,
): Promise<IdentityEpochBootstrapProgress | null> {
  // Select and advance under one native topology-home lock, before releasing it for source work.
  // Parallel bounded workers therefore visit distinct frontier slots without foreign SQL or owner guesses.
  const repairPoint = await withReadTransaction(pool, async (tx) => {
    const next = (await tx.query(bootstrapSelectBootstrapTopology2.sql)).rows[0];
    if (next?.remaining !== 0) return null;
    return (await tx.query(bootstrapSelectBootstrapHome3.sql, [next.repair_partition])).rows[0]?.partition_no ?? null;
  });
  const selected = await runCommand<number | null>(pool, { partition: 0 }, async (tx) => {
    await tx.query(bootstrapSelectBootstrapTopology3.sql);
    const next = (await tx.query(bootstrapSelectBootstrapTopology2.sql)).rows[0];
    if (!next) return noEffect(null);
    if (next.remaining === 0 && repairPoint === null) return noEffect(null);
    const partition = next.remaining === 0 ? repairPoint! : next.next_partition;
    await tx.query(advanceCursor.sql, [(partition + 1) % 4096]);
    return {
      value: partition,
      events: schedule
        ? [{ type: IDENTITY_EPOCH_BOOTSTRAP_SCHEDULED, data: { partition } }]
        : [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition } }],
    };
  });
  const partition = selected.value;
  if (partition === null) return null;
  const progress = await stepIdentityEpochBootstrap(pool, partition);
  const evidence = await withConnection(pool, async (tx) => {
    const owner = await readPartition(tx, partition);
    const home = (await tx.query(closureReceipt.sql, [partition])).rows[0];
    return owner?.writeState === 'active' &&
      owner.epoch === home?.sealed_epoch &&
      BigInt(home.sealed_position) <= owner.position
      ? home
      : null;
  });
  await runCommand(pool, { partition: 0 }, async (tx) => {
    const state = (await tx.query(bootstrapSelectBootstrapTopology3.sql)).rows[0];
    if (state.remaining === 0)
      return {
        value: null,
        events: [{ ...identityBootstrapWake(partition, progress.generation), type: IDENTITY_EPOCH_PROGRESS }],
      };
    // Concurrent scheduler deliveries may have advanced the cursor, but receipt custody is idempotent per source.
    // A raced delivery cannot close a different source or decrement remaining twice.
    const inserted = evidence
      ? (
          await tx.query(bootstrapInsertTopologyCustody.sql, [
            partition,
            evidence.sealed_generation,
            evidence.sealed_epoch,
            evidence.sealed_transaction_id,
            evidence.sealed_position,
          ])
        ).rowCount
      : 0;
    await tx.query(bootstrapUpdateBootstrapTopology.sql, [partition, inserted]);
    return {
      value: null,
      events: [{ ...identityBootstrapWake(partition, progress.generation), type: IDENTITY_EPOCH_PROGRESS }],
    };
  });
  return progress;
}

/** One durable effect performs at most 100 existing bounded native steps. The first step commits
 * the next wake before source contact; DBOS retry and that wake both recover a lost batch reply.
 * Four independent home pipelines overlap released I/O without changing pool or native command limits.
 */
export async function runIdentityEpochBootstrapBatch(pool: Pool): Promise<void> {
  let issued = 0,
    done = false;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (!done && issued < 100) {
        const index = issued++;
        const progress = await stepIdentityEpochBootstrapWork(pool, index === 0);
        if (!progress) done = true;
      }
    }),
  );
}
