import type { Pool } from 'pg';
import { currentCommand, runCommand } from '../command/command.ts';
import { bindRatingIdentityProducer } from '../rating/segment-identity-guard.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  continueIdentityRatingRepair,
  createIdentityRatingRepairProducer,
  type IdentityRatingRepairDrain,
  type IdentityRatingRepairProducer,
} from '../semantic/identity-rating-repair-producer.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../semantic/events.ts';

let installed: IdentityRatingRepairProducer | undefined;

/** Bind the native Identity mapping/obligation producer used by Rating identity repair. */
export function installIdentityRatingRepairProducer(): void {
  installed = createIdentityRatingRepairProducer();
  bindRatingIdentityProducer(installed);
}

export function identityRatingRepairProducer(): IdentityRatingRepairProducer {
  if (!installed) throw new TypeError('Identity rating repair producer is not installed');
  return installed;
}

export type InstalledIdentityRatingRepairCustody = Readonly<{
  obligationId: string;
  pageId: string;
  mappingDigest: string;
  state: 'preparing' | 'held' | 'bound';
  laterChange: boolean;
  laterVote: boolean;
  receiptTransactionId: string | null;
  drainReceiptId: string | null;
}>;

type CustodyRow = {
  obligationId: string;
  pageId: string;
  mappingDigest: string;
  state: InstalledIdentityRatingRepairCustody['state'];
  laterChange: boolean;
  laterVote: boolean;
  receiptTransactionId: string | null;
  drainReceiptId: string | null;
};

function progress(partition: number) {
  return { type: IDENTITY_EPOCH_PROGRESS, data: { partition, generation: '1' } };
}

/** Drain later_change/later_vote on the installed producer in an owner command. */
export async function drainInstalledIdentityRatingRepair(
  pool: Pool,
  partition: number,
): Promise<IdentityRatingRepairDrain> {
  const producer = identityRatingRepairProducer();
  return (
    await runCommand(pool, { partition }, async (tx) => {
      const drained = await producer.drain(tx);
      return {
        value: drained,
        events: drained.events.length ? [...drained.events] : [progress(partition)],
      };
    })
  ).value;
}

/** Continue one prepare/handoff or drain using the installed producer instance. */
export async function continueInstalledIdentityRatingRepair(
  pool: Pool,
  data: Readonly<{
    partition: number;
    voterPartition: number;
    obligationId: string;
    kind: 'prepare' | 'drain';
    originals: readonly string[];
  }>,
): Promise<void> {
  const producer = identityRatingRepairProducer();
  if (data.kind === 'drain') {
    await drainInstalledIdentityRatingRepair(pool, data.partition);
    return;
  }
  const prepared = await runCommand(pool, { partition: data.partition }, async (tx) => {
    const authority = await producer.prepare(tx, {
      obligationId: data.obligationId,
      voterPartition: data.voterPartition,
      originals: data.originals,
    });
    return {
      value: authority,
      events: authority.status === 'pending' && authority.events?.length ? [...authority.events] : [progress(data.partition)],
    };
  });
  const current = prepared.value;
  if (current.status !== 'current') return;
  await runCommand(pool, { partition: data.voterPartition }, async (tx) => {
    const handed = await producer.handoff(tx, {
      obligationId: data.obligationId,
      home: data.partition,
      originals: data.originals,
      mappings: current.mappings,
      ...(current.extraHomes ? { extraHomes: current.extraHomes } : {}),
    });
    return {
      value: handed,
      events: handed.status === 'pending' && handed.events?.length ? [...handed.events] : [progress(data.voterPartition)],
    };
  });
}

/** Independent Semantic obligation readback for a voter's installed repair receipts. */
export async function readInstalledIdentityRatingRepairCustody(
  pool: Pool,
  voterId: string,
): Promise<readonly InstalledIdentityRatingRepairCustody[]> {
  const route = routeOf(voterId);
  if (route === null) throw new TypeError('Invalid Rating identity voter');
  const rows = (
    await pool.query<CustodyRow>(
      `SELECT obligation_id AS "obligationId",
              page_id AS "pageId",
              mapping_digest AS "mappingDigest",
              state,
              later_change AS "laterChange",
              later_vote AS "laterVote",
              receipt_transaction_id AS "receiptTransactionId",
              drain_receipt_id AS "drainReceiptId"
         FROM semantic.identity_rating_repair_obligation
        WHERE partition_no = $1 AND voter_id = $2
        ORDER BY generation, obligation_id`,
      [partitionOf(route), voterId],
    )
  ).rows;
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        obligationId: row.obligationId,
        pageId: row.pageId,
        mappingDigest: row.mappingDigest,
        state: row.state,
        laterChange: row.laterChange,
        laterVote: row.laterVote,
        receiptTransactionId: row.receiptTransactionId,
        drainReceiptId: row.drainReceiptId,
      }),
    ),
  );
}

export async function holdInstalledIdentityRatingRepairPartition(
  pool: Pool,
  partition: number,
  body: (producer: IdentityRatingRepairProducer, transactionId: string) => Promise<unknown>,
): Promise<void> {
  const producer = identityRatingRepairProducer();
  await runCommand(pool, { partition }, async (tx) => {
    await body(producer, currentCommand(tx).transactionId);
    return { value: null, events: [progress(partition)] };
  });
}

/** Semantic work module continues through the same factory; host composition uses the bound instance. */
export { continueIdentityRatingRepair };
