import sql1 from './identity-epoch-bootstrap-select-bootstrap-topology.sql';
import sql2 from './identity-epoch-bootstrap-select-bootstrap-page.sql';
import sql3 from './identity-epoch-bootstrap-select-bootstrap-row.sql';
import sql4 from './identity-epoch-bootstrap-insert-bootstrap-home.sql';
import sql5 from './identity-epoch-bootstrap-select-bootstrap-home.sql';
import sql6 from './identity-epoch-bootstrap-select-bootstrap-page-2.sql';
import sql7 from './identity-epoch-bootstrap-select-dirty.sql';
import sql8 from './identity-epoch-bootstrap-update-bootstrap-home.sql';
import sql9 from './identity-epoch-bootstrap-insert-bootstrap-page.sql';
import sql10 from './identity-epoch-bootstrap-insert-bootstrap-row.sql';
import sql11 from './identity-epoch-bootstrap-select-bootstrap-custody.sql';
import sql12 from './identity-epoch-bootstrap-select-control.sql';
import sql13 from './identity-epoch-bootstrap-insert-group.sql';
import sql14 from './identity-epoch-bootstrap-select-original.sql';
import sql15 from './identity-epoch-bootstrap-update-original.sql';
import sql16 from './identity-epoch-bootstrap-update-group.sql';
import sql17 from './identity-epoch-bootstrap-insert-original.sql';
import sql18 from './identity-epoch-bootstrap-update-group-2.sql';
import sql19 from './identity-epoch-bootstrap-with-legacy-member.sql';
import sql20 from './identity-epoch-bootstrap-insert-bootstrap-custody.sql';
import sql21 from './identity-epoch-bootstrap-select-bootstrap-page-3.sql';
import sql22 from './identity-epoch-bootstrap-select-bootstrap-home-2.sql';
import sql23 from './identity-epoch-bootstrap-insert-mapping.sql';
import sql24 from './identity-epoch-bootstrap-update-dirty.sql';
import sql25 from './identity-epoch-bootstrap-update-member-dirty.sql';
import sql26 from './identity-epoch-bootstrap-update-bootstrap-page.sql';
import sql27 from './identity-epoch-bootstrap-delete-bootstrap-row.sql';
import sql28 from './identity-epoch-bootstrap-update-bootstrap-home-2.sql';
import sql29 from './identity-epoch-bootstrap-select-bootstrap-topology-2.sql';
import sql30 from './identity-epoch-bootstrap-select-bootstrap-home-3.sql';
import sql31 from './identity-epoch-store-select-bootstrap-home.sql';
import sql32 from './identity-epoch-bootstrap-select-bootstrap-topology-3.sql';
import sql33 from './identity-epoch-bootstrap-insert-topology-custody.sql';
import sql34 from './identity-epoch-bootstrap-update-bootstrap-topology.sql';
import closeHome from './identity-epoch-bootstrap-close-home.sql';
import closureReceipt from './identity-epoch-bootstrap-closure-receipt.sql';
import type { Pool } from 'pg';
import { noEffect, registerCommandCallback, runCommand, type CommandTransaction } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { IdentityEpochStoreError, recordIdentityEpochNativeCommit } from './identity-epoch-store.ts';
import { IDENTITY_EPOCH_BOOTSTRAP, IDENTITY_EPOCH_PROGRESS } from './events.ts';
import type { IdentityNativeReceipt, NativeStepWork } from './identity-epoch-contract.ts';
import subjects from './identity-epoch-bootstrap-subjects.sql';
import members from './identity-epoch-bootstrap-members.sql';
import dirty from './identity-epoch-bootstrap-dirty.sql';
import memberDirty from './identity-epoch-bootstrap-member-dirty.sql';

const NIL = '00000000-0000-0000-0000-000000000000';
type Phase = 'subjects' | 'members' | 'dirty' | 'member-dirty';
type Row = { route: number; original: string; terminal: string; source_revision: string; present: boolean };
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
const fail = () => new IdentityEpochStoreError('identity_epoch_unavailable', 'Bootstrap owner or native custody unavailable');

/** Topology is closed by the native scheduler, including empty homes. No caller readiness setter. */
export async function readIdentityEpochCutover(tx: CommandTransaction) {
  const owner = await readPartition(tx, 0);
  const row = (await tx.query(sql1.sql)).rows[0];
  return { state: owner?.writeState === 'active' && row?.remaining === 0 ? 'ready' as const : 'blocked' as const };
}

async function readPage(pool: Pool, partition: number): Promise<Page | null> {
  return withConnection(pool, async (tx) => {
    const owner = await readPartition(tx, partition);
    if (!owner || owner.writeState !== 'active') throw fail();
    const page = (await tx.query(sql2.sql, [partition])).rows[0];
    if (!page) return null;
    if (page.epoch !== owner.epoch || BigInt(page.position) > owner.position) throw fail();
    const rows = (await tx.query(sql3.sql, [partition, page.transaction_id])).rows as Row[];
    return { generation: BigInt(page.generation), phase: page.phase, caughtUp: page.caught_up,
      native: { partition, epoch: page.epoch, position: BigInt(page.position), transactionId: page.transaction_id }, rows };
  });
}

/** A retained source export, receiving native custody, then a separate source ACK of captured heads only. */
export async function stepIdentityEpochBootstrap(pool: Pool, partition: number): Promise<IdentityEpochBootstrapProgress> {
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
      await query(tx, sql4.sql, [partition, partition * 16 - 1, NIL]);
      const saved = (await query(tx, sql5.sql, [partition])).rows[0];
      const owner = await readPartition(tx, partition);
      if (!saved || !owner || owner.epoch !== saved.owner_epoch || owner.writeState !== 'active') throw fail();
      const pending = (await query(tx, sql6.sql, [partition])).rowCount;
      if (pending) return noEffect(null);
      let phase = saved.phase as Phase;
      const args = { first_route: partition * 16, last_route: partition * 16 + 15,
        after_route: saved.after_route, after_original: saved.after_original, after_member: saved.after_member };
      let rows: Row[] = [];
      for (;;) {
        work.statements++;
        rows = phase === 'subjects' ? await subjects.run(tx, args) : phase === 'members' ? await members.run(tx, args)
          : phase === 'dirty' ? await dirty.run(tx, args) : await memberDirty.run(tx, args);
        if (rows.length || phase === 'member-dirty') break;
        phase = phase === 'subjects' ? 'members' : phase === 'members' ? 'dirty' : 'member-dirty';
        args.after_route = partition * 16 - 1;
        args.after_original = NIL;
        args.after_member = NIL;
      }
      work.rows = rows.length;
      work.bytes = Buffer.byteLength(JSON.stringify(rows));
      const last = rows.at(-1);
      const next: Phase = rows.length === 100 ? phase : phase === 'subjects' ? 'members' : phase === 'members' ? 'dirty'
        : phase === 'dirty' ? 'member-dirty' : 'dirty';
      const caughtUp = phase === 'member-dirty' && rows.length === 0 && !(await query(tx, sql7.sql, [partition * 16, partition * 16 + 15])).rowCount;
      const generation = BigInt(saved.generation) + 1n;
      await query(tx, sql8.sql, [partition, next,
        next === phase && last ? last.route : partition * 16 - 1,
        next === phase && last ? phase === 'members' ? last.terminal : last.original : NIL,
        next === phase && last && phase === 'members' ? last.original : NIL, generation.toString()]);
      recordIdentityEpochNativeCommit(tx, 'bootstrap');
      registerCommandCallback(tx, async (transactionId) => {
        await query(tx, sql9.sql, [partition, transactionId, generation.toString(), phase, caughtUp]);
        await query(tx, sql10.sql, [partition, transactionId, JSON.stringify(rows)]);
      });
      return { value: { generation, phase, caughtUp, rows }, events: [{...identityBootstrapWake(partition, generation),type:IDENTITY_EPOCH_PROGRESS}] };
    });
    page = exported.value ? {...exported.value,native: {partition:exported.partition,epoch:exported.epoch,position:exported.position,transactionId:exported.transactionId}} : await readPage(pool, partition);
    if (!page) throw fail();
  } else {
    work.rows = page.rows.length;
    work.bytes = Buffer.byteLength(JSON.stringify(page.rows));
  }
  const retained = page;
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
      const duplicate = (await query(tx, sql11.sql, [destination, partition, retained.generation.toString()])).rows[0];
      if (duplicate) {
        if (duplicate.native_transaction_id !== retained.native.transactionId) throw fail();
        return noEffect(null);
      }
      // Serialize receiving first absence under the actual native home fence.
      await query(tx, sql12.sql, [destination]);
      if (retained.phase === 'subjects' || retained.phase === 'dirty') {
        for (const row of rows) {
          const header = (await query(tx, sql13.sql, [destination, row.terminal, transactionId])).rows[0];
          if (header.pending_job) throw fail();
          const previous = (await query(tx, sql14.sql, [destination, row.original])).rows[0];
          if (previous && previous.terminal !== row.terminal) {
            await query(tx, sql15.sql, [previous.generation, row.original]);
            await query(tx, sql16.sql, [previous.terminal]);
          }
          const changed = !previous || previous.terminal !== row.terminal || !row.present;
          await query(tx, sql17.sql,
            [destination, header.generation, row.original, row.terminal, partition, retained.generation.toString(), row.present]);
          if (changed) await query(tx, sql18.sql, [row.terminal, row.present ? 1 : previous ? -1 : 0]);
        }
      } else {
        await query(tx, sql19.sql,
          [JSON.stringify(rows), destination, partition, retained.generation.toString()]);
      }
      await query(tx, sql20.sql, [destination, partition, retained.generation.toString(), retained.native.transactionId, retained.native.epoch, retained.native.position.toString()]);
      return { value: null, events: [{...identityBootstrapWake(partition, retained.generation),type:IDENTITY_EPOCH_PROGRESS}] };
    });
  }
  // Receiving custody committed before this source transaction. Only captured h is acknowledged; h+1 survives.
  const acknowledged = await runCommand(pool, { partition }, async (tx) => {
    const saved = (await query(tx, sql21.sql,
      [partition, retained.native.transactionId])).rows[0];
    if (saved?.acknowledged) {
      const home=(await query(tx,sql22.sql,[partition])).rows[0];
      return noEffect(home?.sealed_generation !== null);
    }
    const owner = await readPartition(tx, partition);
    if (!owner || owner.writeState !== 'active' || owner.epoch !== retained.native.epoch) throw fail();
    const data = JSON.stringify(retained.rows);
    if (retained.phase === 'subjects' || retained.phase === 'dirty') {
      await query(tx, sql23.sql, [data, retained.native.epoch, retained.native.transactionId]);
      await query(tx, sql24.sql, [data]);
    } else {
      await query(tx, sql25.sql, [data]);
    }
    await query(tx, sql26.sql, [partition, retained.native.transactionId]);
    await query(tx, sql27.sql, [partition, retained.native.transactionId]);
    let sealed=false;
    if (retained.caughtUp) {
      recordIdentityEpochNativeCommit(tx,'bootstrap');
      const closed=await query(tx, sql28.sql,
        [partition, retained.generation.toString(), partition * 16, partition * 16 + 15]);
      sealed=closed.rowCount===1;
      if (sealed) registerCommandCallback(tx,async transactionId=>{
        const receipt=await query(tx,closeHome.sql,[partition,transactionId]);
        if(receipt.rowCount!==1) throw fail();
      });
    }
    return { value: sealed, events: [{...identityBootstrapWake(partition, retained.generation),type:IDENTITY_EPOCH_PROGRESS}] };
  });
  return { partition, generation: retained.generation, state: acknowledged.value ? 'caught-up' : 'more', native: retained.native, work };
}

/** The default worker and native fixtures call this same bounded topology scheduler. */
export async function stepIdentityEpochBootstrapWork(pool: Pool): Promise<IdentityEpochBootstrapProgress | null> {
  const next = await withConnection(pool, async (tx) => (await tx.query(sql29.sql)).rows[0]);
  if (!next) return null;
  const repair = next.remaining === 0 ? await withConnection(pool, async tx => (await tx.query(sql30.sql)).rows[0]) : null;
  if (next.remaining === 0 && !repair) return null;
  const partition = repair?.partition_no ?? next.next_partition;
  const progress = await stepIdentityEpochBootstrap(pool, partition);
  const evidence = await withConnection(pool, async (tx) => {
    const owner = await readPartition(tx, partition);
    const home = (await tx.query(closureReceipt.sql, [partition])).rows[0];
    return owner?.writeState === 'active' && owner.epoch === home?.sealed_epoch &&
      BigInt(home.sealed_position)<=owner.position ? home : null;
  });
  await runCommand(pool, { partition: 0 }, async (tx) => {
    const state = (await tx.query(sql32.sql)).rows[0];
    if (state.remaining===0) return {value:null,events:[identityBootstrapWake(partition,progress.generation)]};
    // Concurrent scheduler deliveries may have advanced the cursor, but receipt custody is idempotent per source.
    // A raced delivery cannot close a different source or decrement remaining twice.
    const inserted = evidence ? (await tx.query(sql33.sql, [partition, evidence.sealed_generation, evidence.sealed_epoch, evidence.sealed_transaction_id, evidence.sealed_position])).rowCount : 0;
    await tx.query(sql34.sql, [partition, inserted]);
    return { value: null, events: [identityBootstrapWake(partition, progress.generation)] };
  });
  return progress;
}
