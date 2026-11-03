import type { Pool } from 'pg';
import {
  readAccountDiscoveryRepairObservation,
  type AccountDiscoveryRepairObservation,
} from '../access/account-discovery-source.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import { readSubjectErasureSourceProof, verifySubjectErasureSourceProof } from '../semantic/account-erasure-source.ts';
import { hasRetainedWriterPublicationCopies } from './public-filter-custody.ts';
import type { PublicFilterConsumer, PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type {
  PublicFilterConsumerContext,
  PublicFilterConsumerUnavailable,
} from './public-filter-consumer-contract.ts';
import { isDeepStrictEqual } from 'node:util';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readPartition } from '../partition/partition.ts';
import type { IdentityJobRef, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import {
  identityEpochStore,
  IdentityEpochStoreError,
  recordIdentityEpochNativeCommit,
} from '../semantic/identity-epoch-store.ts';
import { withReadTransaction } from '../semantic/read.ts';
import gateSql from './writer-guard-gate.sql';
import dispatchSql from './writer-guard-dispatch.sql';
import { prepareBoundedSortKeys } from './bounded-sort-keys.ts';
import { documentActions, validateIndexObservation, type IndexAction, type SubjectDocument } from './document.ts';
import { searchIdentityWriterChanged as changed } from './identity-epoch-participant-events.ts';
import { readIdentityIndexIncarnation, readSearchWriterPhysicalTarget } from './identity-epoch-participant-physical.ts';
import enroll from './identity-epoch-participant-enroll.sql';
import settle from './identity-epoch-participant-settle.sql';
import fence from './identity-epoch-participant-fence.sql';
import { OpenSearchError, type OpenSearch } from './opensearch.ts';
import { subjectPartition, type SubjectListingSource, type SubjectSource } from './source.ts';
import { writeIndexActions, validateRefreshResponse, validateIndexWriteReceipt } from './write-actions.ts';
import {
  readDiscoveryWriterPhysicalTarget,
  readDiscoveryRepairWinner,
  validateDiscoveryRepairWinner,
  type DiscoveryProjection,
  type DiscoveryRepairEffect,
} from './account-discovery.ts';
import type { DiscoveryIndexAction } from './discovery.ts';
import { discoveryIndexName } from './indices.ts';
import { parseDiscoveryDocumentId } from './discovery-documents.ts';
import { validateDiscoveryWriteReceipt } from './write-actions.ts';
import { assertCompleteSearch } from './complete-search.ts';

/** Durable native evidence retained by the existing writer, never supplied by Source callers. */
export type SearchRepairWriterReceipt = Readonly<{
  locator: string;
  subject: string;
  partition: number;
  epoch: number;
  incarnation: string;
  writeAlias: string;
  consumer: string;
  action: IndexAction;
  enrollment: IdentityNativeReceipt;
  completion: IdentityNativeReceipt;
  native: unknown;
}>;
/** The mixed writer retains its actual tagged actions and both allocation identities. */
export type DiscoveryRepairWriterReceipt = Readonly<{
  writer: 'discovery';
  /** Absent on retained Subject receipts written before owner separation. */
  owner?: 'semantic' | 'accounts';
  account?: AccountDiscoveryRepairObservation;
  locator: string;
  subject: string;
  partition: number;
  epoch: number;
  incarnation: string;
  allocation: string;
  writeAlias: string;
  consumer: string;
  sourcePosition: bigint;
  effects: readonly DiscoveryRepairEffect[];
  enrollment: IdentityNativeReceipt;
  completion: IdentityNativeReceipt;
}>;
export type PublicFilterRepairWriterReceipt = SearchRepairWriterReceipt | DiscoveryRepairWriterReceipt;
export function isDiscoveryRepairWriterReceipt(
  receipt: PublicFilterRepairWriterReceipt,
): receipt is DiscoveryRepairWriterReceipt {
  return 'writer' in receipt && receipt.writer === 'discovery';
}
export const repairWriterPosition = (receipt: PublicFilterRepairWriterReceipt): bigint =>
  isDiscoveryRepairWriterReceipt(receipt) ? receipt.sourcePosition : receipt.action.version;

const repairEncode = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? { nativeBigint: String(item) } : item));
export const decodeSearchRepairWriterReceipt = (value: string): SearchRepairWriterReceipt =>
  JSON.parse(value, (_key, item) =>
    item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.nativeBigint === 'string'
      ? BigInt(item.nativeBigint)
      : item,
  );

/** Search-visible keyed readback; absence alone never recovers an uncertain delete. */
export async function readSearchRepairWinner(search: OpenSearch, index: string, action: IndexAction) {
  const response = await search.request(
    'POST',
    `/${index}/_search`,
    {
      size: 1,
      version: true,
      track_total_hits: false,
      query: { ids: { values: [action.id] } },
    },
    { query: { allow_partial_search_results: false } },
  );
  assertCompleteSearch(response.body);
  const body = response.body as {
    hits?: { hits?: { _id: string; _index: string; _version: number; _source: unknown }[] };
  };
  const hits = body.hits?.hits;
  if (
    response.status !== 200 ||
    !Array.isArray(hits) ||
    (action.op === 'delete'
      ? hits.length !== 0
      : hits.length !== 1 ||
        hits[0]!._id !== action.id ||
        hits[0]!._index !== index ||
        !Number.isSafeInteger(hits[0]!._version) ||
        BigInt(hits[0]!._version) !== action.version ||
        !isDeepStrictEqual(hits[0]!._source, action.document))
  )
    throw unavailable('Native repair winner changed or is not visible');
  return response.body;
}

/** Validate only a native record loaded by custody; this is not a settlement producer. */
export function validateSearchRepairWriterEvidence(index: string, receipt: SearchRepairWriterReceipt): void {
  const fail = () => {
    throw unavailable('Native repair receipt or final writer fence changed');
  };
  if (
    subjectPartition(receipt.subject) !== receipt.partition ||
    receipt.action.id !== receipt.subject ||
    receipt.enrollment.partition !== receipt.partition ||
    receipt.completion.partition !== receipt.partition ||
    receipt.enrollment.epoch !== receipt.epoch ||
    receipt.completion.epoch !== receipt.epoch ||
    receipt.completion.position <= receipt.enrollment.position
  )
    fail();
  const nativeEvidence = receipt.native as {
    evidence?: {
      kind?: string;
      bulk?: unknown;
      current?: {
        _version?: number;
        _source?: unknown;
        _id?: string;
        _index?: string;
        found?: boolean;
      };
      refresh?: unknown;
    };
    winner?: unknown;
  };
  const evidence = nativeEvidence?.evidence;
  if (evidence?.kind === 'bulk') validateIndexWriteReceipt(evidence.bulk, index, [receipt.action]);
  else if (evidence?.kind === 'recovered' && receipt.action.op === 'index') {
    validateRefreshResponse(200, evidence.refresh);
    if (
      evidence.current?._id !== receipt.subject ||
      evidence.current?._index !== index ||
      evidence.current?.found !== true ||
      !Number.isSafeInteger(evidence.current?._version) ||
      BigInt(evidence.current!._version!) !== receipt.action.version ||
      !isDeepStrictEqual(evidence.current?._source, receipt.action.document)
    )
      fail();
  } else fail();
}

/** Recheck retained evidence and lock the actual existing writer through the reader boundary. */
export async function verifySearchRepairWriterReceipt(
  db: Pick<Pool, 'query'>,
  search: OpenSearch,
  index: string,
  receipt: SearchRepairWriterReceipt,
): Promise<void> {
  validateSearchRepairWriterEvidence(index, receipt);
  const fail = () => {
    throw unavailable('Native repair receipt or final writer fence changed');
  };
  await verifyRetainedRepairWriter(db, index, receipt);
  const physical = await readSearchWriterPhysicalTarget(search, index);
  if (physical.incarnation !== receipt.incarnation || physical.writeAlias !== receipt.writeAlias) fail();
  await readSearchRepairWinner(search, index, receipt.action);
}

function repairReviver(_key: string, item: unknown) {
  if (
    item &&
    typeof item === 'object' &&
    Object.keys(item).length === 1 &&
    'nativeBigint' in item &&
    typeof item.nativeBigint === 'string'
  )
    return BigInt(item.nativeBigint);
  return item;
}
async function verifyRetainedRepairWriter(
  db: Pick<Pool, 'query'>,
  index: string,
  receipt: PublicFilterRepairWriterReceipt,
) {
  const fail = () => {
    throw unavailable('Native repair receipt or final writer fence changed');
  };
  // Each query is anchored to one native home; never join observation and subject partitions.
  const gate = (
    await db.query(
      `SELECT consumer,incarnation,owner_epoch,write_alias,closed_token
    FROM search.identity_writer_gate WHERE partition_no=$1 AND physical_target=$2 FOR SHARE`,
      [receipt.partition, index],
    )
  ).rows[0];
  if (
    !gate ||
    gate.consumer !== receipt.consumer ||
    gate.incarnation !== receipt.incarnation ||
    gate.owner_epoch !== receipt.epoch ||
    gate.write_alias !== receipt.writeAlias ||
    gate.closed_token
  )
    fail();
  const writer = (
    await db.query(
      `SELECT writer_token,dispatch_state,closed_job,repair_locator,repair_receipt,repair_action,repair_account,
    owner_epoch,incarnation,source_position,visible_position,visible_transaction_id,
    settled_position,settled_transaction_id,writer_transaction_id,writer_position
    FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 FOR SHARE`,
      [receipt.partition, index, receipt.subject],
    )
  ).rows[0];
  if (
    !writer ||
    writer.writer_token !== null ||
    writer.dispatch_state !== 'settled' ||
    writer.closed_job ||
    writer.owner_epoch !== receipt.epoch ||
    writer.incarnation !== receipt.incarnation ||
    writer.repair_locator !== receipt.locator ||
    !writer.repair_receipt ||
    !isDeepStrictEqual(JSON.parse(writer.repair_receipt, repairReviver), receipt) ||
    (isDiscoveryRepairWriterReceipt(receipt) &&
      receipt.owner === 'accounts' &&
      (!writer.repair_account ||
        !isDeepStrictEqual(JSON.parse(writer.repair_account, repairReviver), receipt.account))) ||
    (isDiscoveryRepairWriterReceipt(receipt) &&
      (!writer.repair_action ||
        !isDeepStrictEqual(
          JSON.parse(writer.repair_action, repairReviver),
          receipt.effects.map(({ action }) => action),
        ))) ||
    BigInt(writer.source_position ?? -1) !== repairWriterPosition(receipt) ||
    writer.writer_transaction_id !== receipt.enrollment.transactionId ||
    BigInt(writer.writer_position ?? -1) !== receipt.enrollment.position ||
    writer.visible_transaction_id !== receipt.completion.transactionId ||
    writer.settled_transaction_id !== receipt.completion.transactionId ||
    BigInt(writer.settled_position ?? -1) !== receipt.completion.position ||
    BigInt(writer.visible_position ?? -1) !== receipt.completion.position
  )
    fail();
  const owner = (
    await db.query(
      `SELECT epoch,write_state,position FROM core.partition
    WHERE partition_no=$1 FOR SHARE`,
      [receipt.partition],
    )
  ).rows[0];
  if (
    !owner ||
    owner.write_state !== 'active' ||
    owner.epoch !== receipt.epoch ||
    BigInt(owner.position) < receipt.completion.position
  )
    fail();
}

/** Dispatch by original physical family; no mixed receipt is accepted by the Subject verifier. */
export function validatePublicFilterRepairWriterEvidence(index: string, receipt: PublicFilterRepairWriterReceipt) {
  if (!isDiscoveryRepairWriterReceipt(receipt)) {
    if (!/subjects-g[1-9][0-9]*$/.test(index)) throw unavailable('Subject receipt cannot settle a mixed target');
    return validateSearchRepairWriterEvidence(index, receipt);
  }
  if (
    !/discovery-g[1-9][0-9]*$/.test(index) ||
    subjectPartition(receipt.subject) !== receipt.partition ||
    receipt.enrollment.partition !== receipt.partition ||
    receipt.completion.partition !== receipt.partition ||
    receipt.enrollment.epoch !== receipt.epoch ||
    receipt.completion.epoch !== receipt.epoch ||
    receipt.completion.position <= receipt.enrollment.position ||
    !receipt.allocation ||
    receipt.writeAlias !== `${index}-write` ||
    receipt.effects.length < 1 ||
    receipt.effects.length > 100
  )
    throw unavailable('Mixed repair receipt changed');
  if (
    receipt.owner === 'accounts'
      ? !receipt.account ||
        receipt.account.id !== receipt.subject ||
        receipt.account.head.partition !== receipt.partition ||
        receipt.account.head.epoch !== receipt.epoch ||
        receipt.account.position > receipt.sourcePosition
      : receipt.account !== undefined
  )
    throw unavailable('Mixed repair native Account binding changed');
  if (receipt.account) {
    const { binding, account, claimHead } = receipt.account;
    if (
      (account === null) !== (binding === null) ||
      (account !== null &&
        (account.id !== receipt.subject ||
          account.revision !== binding!.revision ||
          account.handle !== binding!.handle)) ||
      (binding?.claim
        ? !claimHead ||
          claimHead.partition !== partitionOf(binding.claim.route) ||
          claimHead.epoch < 1 ||
          claimHead.revision < 1n ||
          claimHead.claimRevision < 1n ||
          binding.consumedClaimRevision < binding.claim.revision
        : claimHead !== null)
    )
      throw unavailable('Mixed repair native claim binding changed');
  }
  const seen = new Set<string>();
  let floor: bigint | undefined;
  for (const { key, action, evidence, winner } of receipt.effects) {
    if (
      key.id !== receipt.subject ||
      subjectPartition(key.id) !== receipt.partition ||
      key.route !== routeOf(key.id) ||
      (receipt.owner !== undefined && key.owner !== receipt.owner) ||
      (key.owner === 'accounts' ? key.kind !== 'account' : key.owner !== 'semantic' || key.kind === 'account') ||
      action.id !== `discovery-v1:${encodeURIComponent(key.kind)}:${key.id}` ||
      seen.has(action.id) ||
      action.version < receipt.enrollment.position ||
      action.version >= receipt.completion.position ||
      action.version > 9223372036854775807n
    )
      throw unavailable('Mixed repair keyed Source action changed');
    seen.add(action.id);
    floor = floor === undefined || action.version < floor ? action.version : floor;
    if (evidence.kind === 'bulk') validateDiscoveryWriteReceipt(evidence.bulk, index, [action]);
    else if (evidence.kind === 'recovered' && action.op === 'index') validateRefreshResponse(200, evidence.refresh);
    else throw unavailable('Mixed repair has no native dispatch receipt');
    validateDiscoveryRepairWinner(index, action, winner);
  }
  if (floor !== receipt.sourcePosition) throw unavailable('Mixed repair Source version changed');
}
export async function readPublicFilterRepairPhysicalTarget(db: Pick<Pool, 'query'>, search: OpenSearch, index: string) {
  return /discovery-g[1-9][0-9]*$/.test(index)
    ? readDiscoveryWriterPhysicalTarget(db, search, index)
    : readSearchWriterPhysicalTarget(search, index);
}
export async function verifyPublicFilterRepairWriterReceipt(
  db: Pick<Pool, 'query'>,
  search: OpenSearch,
  index: string,
  receipt: PublicFilterRepairWriterReceipt,
) {
  validatePublicFilterRepairWriterEvidence(index, receipt);
  if (!isDiscoveryRepairWriterReceipt(receipt)) return verifySearchRepairWriterReceipt(db, search, index, receipt);
  await verifyRetainedRepairWriter(db, index, receipt);
  const target = await readDiscoveryWriterPhysicalTarget(db, search, index);
  if (
    target.incarnation !== receipt.incarnation ||
    target.allocation !== receipt.allocation ||
    target.writeAlias !== receipt.writeAlias
  )
    throw unavailable('Mixed repair allocation changed');
  for (const effect of receipt.effects) await readDiscoveryRepairWinner(search, index, effect.action);
}

/** Uses the existing native writer enrollment, dispatch and settlement rows, with the actual
 * mixed projection as the only body/version producer. An interrupted attempt replays its retained actions;
 * no copy flag, current ACK or engine conflict is a repair receipt.
 */
export function createDiscoveryRepairWriter(options: {
  pool: Pool;
  search: OpenSearch;
  consumer: string;
  projection: DiscoveryProjection;
}) {
  const { pool, search, projection, consumer } = options;
  const index = discoveryIndexName(projection.target.prefix, projection.target.generation);
  async function gate(
    tx: CommandTransaction,
    receipt: IdentityNativeReceipt,
    physical: { incarnation: string; writeAlias: string },
  ) {
    await tx.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,741))', [index]);
    const publication = await tx.query(
      'SELECT publication_fence FROM search.identity_writer_gate WHERE partition_no=0 AND physical_target=$1',
      [index],
    );
    if (publication.rows[0]?.publication_fence) throw unavailable('Mixed generation is fenced for native publication');
    const parameters = [receipt.partition, index, consumer, physical.incarnation, receipt.epoch, physical.writeAlias];
    const existing = await tx.query(gateSql.sql, parameters);
    const row =
      existing.rows[0] ??
      (
        await tx.query(
          `INSERT INTO search.identity_writer_gate(partition_no,physical_target,consumer,incarnation,owner_epoch,write_alias)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING closed_token`,
          parameters,
        )
      ).rows[0];
    if (!row || row.closed_token) throw unavailable('Mixed repair writer requires native generation/home handoff');
  }
  async function repair(
    subject: string,
    obligation: bigint,
    locator: string,
    context: PublicFilterConsumerContext,
    owner: 'semantic' | 'accounts' = 'semantic',
  ): Promise<DiscoveryRepairWriterReceipt> {
    if (!locator || locator.length > 8192 || obligation < 0n) throw new TypeError('Invalid mixed repair locator');
    const partition = subjectPartition(subject);
    const commandOptions = { partition, deadline: context.deadline };
    const physical = await readDiscoveryWriterPhysicalTarget(pool, search, index);
    if (physical.incarnation !== projection.target.uuid || physical.allocation !== projection.target.incarnation)
      throw unavailable('Mixed projection allocation changed');
    type Row = {
      repair_locator: string | null;
      repair_receipt: string | null;
      repair_action: string | null;
      repair_account: string | null;
      writer_token: string | null;
      writer_transaction_id: string;
      writer_position: string;
      owner_epoch: number;
      incarnation: string;
      dispatch_state: string;
      closed_job: string | null;
    };
    const read = async () =>
      (
        await pool.query<Row>(
          `SELECT repair_locator,repair_receipt,repair_action,repair_account,writer_token,writer_transaction_id,writer_position,owner_epoch,
         incarnation,dispatch_state,closed_job FROM search.identity_writer
         WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
          [partition, index, subject],
        )
      ).rows[0];
    let row = await read();
    if (row?.repair_locator !== locator) {
      const token = crypto.randomUUID();
      await runCommand(pool, commandOptions, async (tx, context) => {
        const enrollment = await native(tx, context.transactionId);
        await gate(tx, enrollment, physical);
        const enrolled = await tx.query(enroll.sql, [
          partition,
          index,
          physical.incarnation,
          enrollment.epoch,
          token,
          enrollment.transactionId,
          enrollment.position.toString(),
          [subject],
        ]);
        if (enrolled.rowCount !== 1) throw unavailable('Mixed repair writer is pending or structurally fenced');
        await tx.query(
          `UPDATE search.identity_writer SET repair_locator=$4,repair_action=NULL,repair_account=NULL,repair_receipt=NULL
            WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
          [partition, index, subject, locator],
        );
        await tx.query(
          `UPDATE search.identity_writer_gate SET enrollment_generation=enrollment_generation+1
            WHERE partition_no=$1 AND physical_target=$2`,
          [partition, index],
        );
        return { value: null, events: changed() };
      });
      row = await read();
    }
    if (!row || row.repair_locator !== locator || row.closed_job || row.incarnation !== physical.incarnation)
      throw unavailable('Mixed retained repair changed');
    if (row.dispatch_state === 'settled' && !row.writer_token && row.repair_receipt) {
      const receipt: PublicFilterRepairWriterReceipt = JSON.parse(row.repair_receipt, repairReviver);
      if (!isDiscoveryRepairWriterReceipt(receipt) || (receipt.owner ?? 'semantic') !== owner)
        throw unavailable('Mixed repair retained a different native owner');
      if (owner === 'accounts') {
        const current = await readAccountDiscoveryRepairObservation(pool, subject, context);
        if (!receipt.account || !isDeepStrictEqual({ ...current, position: receipt.account.position }, receipt.account))
          throw unavailable('Retained Account repair input changed');
      }
      return receipt;
    }
    if (!row.repair_action && row.dispatch_state === 'enrolled' && row.writer_token) {
      const token = row.writer_token;
      const epoch = row.owner_epoch;
      const account =
        owner === 'accounts' ? await readAccountDiscoveryRepairObservation(pool, subject, context) : undefined;
      const actions = await projection.prepareRepair(subject, obligation, owner);
      if (account) {
        const current = await readAccountDiscoveryRepairObservation(pool, subject, context);
        if (!isDeepStrictEqual({ ...current, position: account.position }, account))
          throw unavailable('Account repair changed during preparation');
      }
      const body = repairEncode(actions);
      if (Buffer.byteLength(body) > 1048576) throw unavailable('Mixed repair actions exceed native custody');
      await runCommand(pool, commandOptions, async (tx, command) => {
        const receipt = await native(tx, command.transactionId);
        if (receipt.epoch !== epoch) throw unavailable('Mixed repair home moved during preparation');
        await gate(tx, receipt, physical);
        const saved = await tx.query(
          `UPDATE search.identity_writer SET repair_action=$5,repair_account=$7
            WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 AND writer_token=$4
            AND dispatch_state='enrolled' AND repair_locator=$6 AND repair_action IS NULL RETURNING original_id`,
          [partition, index, subject, token, body, locator, account ? repairEncode(account) : null],
        );
        // A concurrent prepare of this same retained locator may already have won. Use ONLY that
        // immutable native action array, never the losing callback's current Source result.
        return saved.rowCount === 1 ? { value: null, events: changed() } : noEffect(null);
      });
      row = await read();
    }
    if (!row || row.repair_locator !== locator || row.closed_job || row.incarnation !== physical.incarnation)
      throw unavailable('Mixed retained actions changed before dispatch');
    if (!row.repair_action || !row.writer_token || !['enrolled', 'dispatched'].includes(row.dispatch_state))
      throw unavailable('Mixed repair dispatch custody is unavailable');
    const token = row.writer_token;
    const dispatchState = row.dispatch_state;
    const enrollment: IdentityNativeReceipt = {
      partition,
      epoch: row.owner_epoch,
      transactionId: row.writer_transaction_id,
      position: BigInt(row.writer_position),
    };
    await runCommand(pool, commandOptions, async (tx, context) => {
      const dispatch = await native(tx, context.transactionId);
      if (dispatch.epoch !== enrollment.epoch) throw unavailable('Mixed repair home moved');
      await gate(tx, dispatch, physical);
      if (dispatchState === 'enrolled') {
        const dispatched = await tx.query(dispatchSql.sql, [
          partition,
          index,
          physical.incarnation,
          dispatch.epoch,
          token,
          [subject],
        ]);
        if (dispatched.rowCount !== 1) throw unavailable('Mixed repair dispatch was revoked');
      } else {
        // Serialize replay admission against native cancellation and retain the same enrollment.
        const retained = await tx.query(
          `SELECT 1 FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2
            AND original_id=$3 AND writer_token=$4 AND dispatch_state='dispatched' FOR UPDATE`,
          [partition, index, subject, token],
        );
        if (retained.rowCount !== 1) throw unavailable('Mixed repair replay was revoked');
      }
      return { value: null, events: changed() };
    });
    const actions: DiscoveryIndexAction[] = JSON.parse(row.repair_action, repairReviver);
    if (actions.some((action) => parseDiscoveryDocumentId(projection.registry, action.id).owner !== owner))
      throw unavailable('Mixed repair actions belong to a different native owner');
    const account: AccountDiscoveryRepairObservation | undefined = row.repair_account
      ? JSON.parse(row.repair_account, repairReviver)
      : undefined;
    if ((owner === 'accounts') !== (account !== undefined))
      throw unavailable('Mixed repair original Account input is unavailable');
    if (account) {
      const current = await readAccountDiscoveryRepairObservation(pool, subject, context);
      if (!isDeepStrictEqual({ ...current, position: account.position }, account))
        throw unavailable('Account repair changed before dispatch');
    }
    const effects = await projection.applyRepair(actions);
    if (!effects.length) throw unavailable('Mixed repair produced no native action');
    const sourcePosition = effects.reduce(
      (floor, effect) => (effect.action.version < floor ? effect.action.version : floor),
      effects[0]!.action.version,
    );
    if (sourcePosition < obligation) throw unavailable('Mixed repair did not cover its own-home Source version');
    if (!isDeepStrictEqual(await readDiscoveryWriterPhysicalTarget(pool, search, index), physical))
      throw unavailable('Mixed repair allocation changed after dispatch');
    if (account) {
      const current = await readAccountDiscoveryRepairObservation(pool, subject, context);
      // Native writer commands advance core.position themselves. Compare the
      // independent Account/claim facts, retaining the original writer floor.
      if (!isDeepStrictEqual({ ...current, position: account.position }, account))
        throw unavailable('Account repair changed during dispatch');
    }
    const completed = await runCommand(pool, commandOptions, async (tx, context) => {
      const completion = await native(tx, context.transactionId);
      if (completion.epoch !== enrollment.epoch) throw unavailable('Mixed repair home moved before settlement');
      await gate(tx, completion, physical);
      const receipt: DiscoveryRepairWriterReceipt = {
        writer: 'discovery',
        owner,
        ...(account ? { account } : {}),
        locator,
        subject,
        partition,
        epoch: enrollment.epoch,
        ...physical,
        consumer,
        sourcePosition,
        effects,
        enrollment,
        completion,
      };
      validatePublicFilterRepairWriterEvidence(index, receipt);
      const settled = await tx.query(settle.sql, [
        partition,
        index,
        physical.incarnation,
        enrollment.epoch,
        token,
        enrollment.transactionId,
        enrollment.position.toString(),
        [subject],
        completion.transactionId,
        completion.position.toString(),
        sourcePosition.toString(),
      ]);
      if (settled.rowCount !== 1) throw unavailable('Mixed repair changed at final native fence');
      await tx.query(
        `UPDATE search.identity_writer SET repair_receipt=$4
          WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 AND repair_locator=$5`,
        [partition, index, subject, repairEncode(receipt), locator],
      );
      return { value: receipt, events: changed() };
    });
    return completed.value;
  }
  return {
    repair(subject: string, obligation: bigint, locator: string, context: PublicFilterConsumerContext) {
      return repair(subject, obligation, locator, context);
    },
    async repairAccount(account: string, locator: string, context: PublicFilterConsumerContext) {
      const original = await readAccountDiscoveryRepairObservation(pool, account, context);
      return repair(account, original.position, locator, context, 'accounts');
    },
  };
}

export const SEARCH_IDENTITY_WRITER_CHUNK = 100;
const unavailable = (detail: string) => new IdentityEpochStoreError('identity_epoch_unavailable', detail);

function keys(partition: number, ids: readonly string[]): string[] {
  if (ids.length < 1 || ids.length > SEARCH_IDENTITY_WRITER_CHUNK)
    throw new TypeError('Identity writer requires one through 100 raw keys');
  if (ids.some((id) => subjectPartition(id) !== partition) || new Set(ids).size !== ids.length)
    throw new TypeError('Identity writer requires unique keys in its native home');
  return [...ids].sort();
}

async function native(tx: CommandTransaction, transactionId: string): Promise<IdentityNativeReceipt> {
  const command = currentCommand(tx);
  if (command.basis !== null) throw new TypeError('Identity writer is trusted native projection work');
  const owner = await readPartition(tx, command.partition);
  if (!owner || owner.writeState !== 'active') throw unavailable('Search writer home is unavailable');
  // runCommand's final fence commits this exact next component or retries the entire transaction.
  return { partition: command.partition, epoch: owner.epoch, position: owner.position + 1n, transactionId };
}

/** A locator only. All adoption reads retained native rows under the current home owner. */
export type SearchWriterBarrierLocator = Readonly<{ partition: number; token: string }>;
export type SearchWriterBarrier = Readonly<{
  locator: SearchWriterBarrierLocator;
  consumer: string;
  physicalTarget: string;
  writeAlias: string;
  incarnation: string;
  physicalGeneration: number;
  enrollmentGeneration: bigint;
  fenceGeneration: bigint;
  native: IdentityNativeReceipt;
  ordinary: 'draining' | 'drained';
  /** The delivered receiving binding only accepts Library. No Search first-apply proof exists yet. */
  firstApply: 'unavailable';
  prepared: 'unavailable';
}>;
export type SearchRetainedCopy = Readonly<{
  original: string;
  sourcePosition: bigint | null;
  visible: IdentityNativeReceipt | null;
  enrollment: IdentityNativeReceipt | null;
  state: 'enrolled' | 'dispatched' | 'settled' | 'cancelled';
}>;
export type SearchWriterGuard = Readonly<{
  write(partition: number, ids: readonly string[], obligation: bigint): Promise<void>;
}>;
export type SearchWriterNativeCustody = SearchWriterGuard &
  Readonly<{
    /** Retained native repair, using the ordinary Source, serializer and writer enrollment. */
    repair(
      subject: string,
      obligation: bigint,
      locator: string,
      context: PublicFilterConsumerContext,
    ): Promise<SearchRepairWriterReceipt>;
    /** No caller body/version or saved positive can be submitted. */
    write(partition: number, ids: readonly string[], obligation: bigint): Promise<void>;
    fenceOriginal(job: IdentityJobRef, original: string): Promise<SearchIdentityWriterFence>;
    /** Closes first absence under the same native gate as enrollment; does not assert population. */
    closeGeneration(partition: number): Promise<SearchWriterBarrier>;
    /** Publication consumes retained state, never fields from a diagnostic read or caller certificate. */
    adoptGenerationPublicationBarrier(locator: SearchWriterBarrierLocator): Promise<SearchWriterBarrier>;
    readRetainedCopies(
      locator: SearchWriterBarrierLocator,
      after: string | null,
    ): Promise<
      Readonly<{
        copies: readonly SearchRetainedCopy[];
        next: string | null;
      }>
    >;
    /** Revokes at most 100 undispatched enrollments. Dispatched uncertainty remains a drain barrier. */
    recoverInterrupted(
      locator: SearchWriterBarrierLocator,
      after: string | null,
    ): Promise<
      Readonly<{
        examined: number;
        revoked: number;
        uncertain: number;
        next: string | null;
      }>
    >;
  }>;

export type SearchWriterPublicationFence = Readonly<{ consumer: PublicFilterConsumer; job: string; fence: string }>;
export type SearchWriterPublicationGuard = SearchWriterGuard &
  Readonly<{
    fencePublication(
      request: Readonly<{ consumer: PublicFilterConsumer; job: string }>,
      context: PublicFilterConsumerContext,
    ): Promise<
      | { status: 'fenced'; fence: SearchWriterPublicationFence; cost: PublicFilterCost }
      | PublicFilterConsumerUnavailable
    >;
    drainPublication(
      fence: SearchWriterPublicationFence,
      context: PublicFilterConsumerContext,
    ): Promise<
      | { status: 'draining' | 'drained'; fence: SearchWriterPublicationFence; cost: PublicFilterCost }
      | PublicFilterConsumerUnavailable
    >;
    adoptPublication(
      fence: SearchWriterPublicationFence,
      context: PublicFilterConsumerContext,
    ): Promise<
      { status: 'held'; fence: SearchWriterPublicationFence; cost: PublicFilterCost } | PublicFilterConsumerUnavailable
    >;
    releasePublication(
      fence: SearchWriterPublicationFence,
      context: PublicFilterConsumerContext,
    ): Promise<{ status: 'released'; cost: PublicFilterCost } | PublicFilterConsumerUnavailable>;
  }>;

// Producer-private native readers retain the actual supplied Source/listing composition. This is
// neither a generation registry nor caller evidence: only this factory installs a reader.
const generationReaders = new WeakMap<
  SearchWriterGuard,
  (
    partition: number,
    ids: readonly string[],
    obligation: bigint,
  ) => Promise<readonly IndexAction<SubjectDocument>[] | null>
>();

/** Read current native projection bodies with the external versions actually settled by this writer.
 * A later writer-custody command advances the home head without changing those external versions.
 * Missing/uncertain custody returns null and cannot certify a generation.
 */
export async function readSearchWriterGenerationActions(
  guard: SearchWriterGuard,
  partition: number,
  ids: readonly string[],
  obligation: bigint,
): Promise<readonly IndexAction<SubjectDocument>[] | null> {
  return generationReaders.get(guard)?.(partition, ids, obligation) ?? null;
}

type GateRow = {
  consumer: string;
  incarnation: string;
  write_alias: string;
  owner_epoch: number;
  enrollment_generation: string;
  fence_generation: string;
  closed_token: string | null;
  closed_transaction_id: string | null;
  closed_position: string | null;
};
type CopyRow = {
  original_id: string;
  incarnation: string;
  owner_epoch: number;
  writer_token: string | null;
  dispatch_state: SearchRetainedCopy['state'];
  source_position: string | null;
  visible_transaction_id: string | null;
  visible_position: string | null;
  writer_transaction_id: string | null;
  writer_position: string | null;
};

/** Ordinary writer custody, independent of the fixed participant and privacy-reduction continuation.
 * A submitted request with uncertain outcome retains its enrollment indefinitely until native reconciliation.
 * Time, retries, a refreshed 409 or a later physical UUID cannot release that request.
 */
export function createSearchWriterGuard(options: {
  pool: Pool;
  search: OpenSearch;
  index: string;
  calendarFormat?: 1;
  consumer: string;
  source: SubjectSource;
  listing: SubjectListingSource;
}): SearchWriterNativeCustody & SearchWriterPublicationGuard {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.consumer)) throw new TypeError('Invalid Search consumer');
  const match = /subjects-g([1-9][0-9]*)$/.exec(options.index);
  const generation = Number(match?.[1]);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new TypeError('Invalid physical generation');
  const point = (partition: number, epoch: number, transactionId: string | null, position: string | null) =>
    transactionId === null ? null : { partition, epoch, transactionId, position: BigInt(position!) };
  function locator(value: SearchWriterBarrierLocator, after: string | null = null) {
    if (
      !Number.isInteger(value.partition) ||
      value.partition < 0 ||
      value.partition > 4095 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.token)
    )
      throw new TypeError('Invalid native Search barrier locator');
    if (after !== null && subjectPartition(after) !== value.partition) throw new TypeError('Invalid copy frontier');
  }
  async function gate(tx: CommandTransaction, receipt: IdentityNativeReceipt, incarnation: string, writeAlias: string) {
    const parameters = [receipt.partition, options.index, options.consumer, incarnation, receipt.epoch, writeAlias];
    const existing = await tx.query(gateSql.sql, parameters);
    if (existing.rowCount === 1) return existing.rows[0]!;
    const inserted = await tx.query(
      `INSERT INTO search.identity_writer_gate (partition_no,physical_target,consumer,incarnation,owner_epoch,write_alias)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (partition_no,physical_target) DO NOTHING
       RETURNING enrollment_generation,fence_generation,closed_token`,
      parameters,
    );
    if (inserted.rowCount !== 1)
      throw unavailable('Search consumer, incarnation or home requires native handoff custody');
    return inserted.rows[0]!;
  }
  async function retained(tx: CommandTransaction, value: SearchWriterBarrierLocator) {
    const owner = await readPartition(tx, value.partition);
    const row = (
      await tx.query<GateRow>(
        `SELECT * FROM search.identity_writer_gate WHERE partition_no=$1 AND physical_target=$2 AND closed_token=$3`,
        [value.partition, options.index, value.token],
      )
    ).rows[0];
    if (
      !owner ||
      owner.writeState !== 'active' ||
      !row ||
      row.owner_epoch !== owner.epoch ||
      row.consumer !== options.consumer ||
      owner.position < BigInt(row.closed_position!)
    )
      throw unavailable('Search publication barrier is missing, moved or foreign');
    return row;
  }
  async function inspect(value: SearchWriterBarrierLocator): Promise<SearchWriterBarrier> {
    locator(value);
    const { incarnation, writeAlias } = await readSearchWriterPhysicalTarget(options.search, options.index);
    const barrier = await withReadTransaction(options.pool, async (tx) => {
      const row = await retained(tx, value);
      if (row.incarnation !== incarnation || row.write_alias !== writeAlias)
        throw unavailable('Search publication physical incarnation changed');
      const pending = await tx.query(
        `SELECT original_id FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2
         AND writer_token IS NOT NULL ORDER BY original_id LIMIT 1`,
        [value.partition, options.index],
      );
      return {
        locator: { partition: value.partition, token: value.token },
        consumer: row.consumer,
        physicalTarget: options.index,
        writeAlias: row.write_alias,
        incarnation: row.incarnation,
        physicalGeneration: generation,
        enrollmentGeneration: BigInt(row.enrollment_generation),
        fenceGeneration: BigInt(row.fence_generation),
        native: point(value.partition, row.owner_epoch, row.closed_transaction_id, row.closed_position)!,
        ordinary: pending.rows.length ? ('draining' as const) : ('drained' as const),
        firstApply: 'unavailable' as const,
        prepared: 'unavailable' as const,
      };
    });
    if ((await readIdentityIndexIncarnation(options.search, options.index)) !== incarnation)
      throw unavailable('Search publication physical incarnation changed during adoption');
    return barrier;
  }
  type PublicationRow = GateRow & {
    publication_job: string | null;
    publication_consumer: PublicFilterConsumer | null;
    publication_fence: string | null;
    publication_released_fence: string | null;
    publication_home: number;
    publication_after: string | null;
    publication_revision: string;
  };
  const publicationCost = (): PublicFilterCost => ({
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  });
  class PublicationPending extends Error {}
  const pendingPublication = () => {
    throw new PublicationPending();
  };
  function publicationDeadline(context: PublicFilterConsumerContext) {
    if (!Number.isSafeInteger(context.deadline)) throw new TypeError('Invalid publication deadline');
    if (context.deadline <= Date.now()) throw new PublicationPending('deadline');
  }
  async function publicationCall<T>(
    context: PublicFilterConsumerContext,
    work: (cost: PublicFilterCost) => Promise<T>,
  ): Promise<T | PublicFilterConsumerUnavailable> {
    const cost = publicationCost();
    try {
      publicationDeadline(context);
      return await work(cost);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return {
        status: error instanceof PublicationPending ? 'unready' : 'unavailable',
        reason: error instanceof PublicationPending && error.message === 'deadline' ? 'deadline' : 'source_pending',
        cost,
      };
    }
  }
  async function publicationLock(tx: CommandTransaction, exclusive: boolean) {
    // Same lock in native admission and publication, including first absence of the home-zero gate.
    await tx.query(
      exclusive
        ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,741))'
        : 'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,741))',
      [options.index],
    );
  }
  async function publicationAdmission(tx: CommandTransaction) {
    await publicationLock(tx, false);
    const result = await tx.query(
      'SELECT publication_fence FROM search.identity_writer_gate WHERE partition_no=0 AND physical_target=$1',
      [options.index],
    );
    if (result.rows[0]?.publication_fence) throw unavailable('Search generation is fenced for native publication');
  }
  async function publicationJob(
    tx: CommandTransaction,
    request: Readonly<{ consumer: PublicFilterConsumer; job: string }>,
  ) {
    if (request.consumer.physicalTarget !== options.index || !/^[0-9a-f-]{36}$/.test(request.job))
      return pendingPublication();
    const result = await tx.query<{ phase: string }>(
      `SELECT phase FROM search.generation_publication WHERE partition_no=0 AND job=$1
       AND physical_target=$2 AND consumer=$3 AND native_incarnation=$4`,
      [request.job, options.index, request.consumer, request.consumer.incarnation],
    );
    if (result.rowCount === 1) return { ...result.rows[0]!, barrier: null };
    // Erasure is an actual retained operational job in this same physical home, not an identity job
    // or a caller token. Match the immutable consumer, incarnation and committed Account locator.
    const erasure = await tx.query<{ phase: string; barrier: HistoryBarrier }>(
      `SELECT phase,barrier FROM search.erasure_effect WHERE partition_no=0 AND job=$1
       AND physical_target=$2 AND consumer=$3 AND incarnation=$4`,
      [request.job, options.index, request.consumer, request.consumer.incarnation],
    );
    if (erasure.rowCount !== 1) return pendingPublication();
    return erasure.rows[0]!;
  }
  async function publicationSource(value: SearchWriterPublicationFence, context: PublicFilterConsumerContext) {
    const job = await withReadTransaction(options.pool, (tx) => publicationJob(tx, value));
    // Generation publication retains its own owner protocol; its unavailable receiving proof stays pending.
    if (!job.barrier) return pendingPublication();
    const proof = await readSubjectErasureSourceProof({ pool: options.pool }, job.barrier, context);
    if (!proof) return pendingPublication();
    const verified = await runCommand(
      options.pool,
      { partition: job.barrier.accountRoute >> 4, deadline: context.deadline },
      async (tx) => noEffect(await verifySubjectErasureSourceProof(tx, job.barrier, proof)),
    );
    if (!verified.value) return pendingPublication();
  }
  async function publicationRetained(tx: CommandTransaction, value: SearchWriterPublicationFence) {
    await publicationJob(tx, value);
    const owner = await readPartition(tx, 0);
    const row = (
      await tx.query<PublicationRow>(
        'SELECT * FROM search.identity_writer_gate WHERE partition_no=0 AND physical_target=$1',
        [options.index],
      )
    ).rows[0];
    if (
      !owner ||
      owner.writeState !== 'active' ||
      !row ||
      row.owner_epoch !== owner.epoch ||
      row.consumer !== options.consumer ||
      row.incarnation !== value.consumer.incarnation ||
      row.publication_job !== value.job ||
      row.publication_fence !== value.fence ||
      !isDeepStrictEqual(row.publication_consumer, value.consumer)
    )
      return pendingPublication();
    return row;
  }
  async function publicationPhysical(value: Readonly<{ consumer: PublicFilterConsumer }>) {
    const target = await readSearchWriterPhysicalTarget(options.search, options.index);
    if (target.incarnation !== value.consumer.incarnation) return pendingPublication();
    return target;
  }
  const publication: Omit<SearchWriterPublicationGuard, 'write'> = {
    fencePublication(request, context) {
      const input = structuredClone(request);
      return publicationCall(context, async (cost) => {
        const target = await publicationPhysical(input);
        const result = await runCommand(options.pool, { partition: 0 }, async (tx, command) => {
          publicationDeadline(context);
          const receipt = await native(tx, command.transactionId);
          await publicationLock(tx, true);
          await publicationJob(tx, input);
          await gate(tx, receipt, target.incarnation, target.writeAlias);
          const row = (
            await tx.query<PublicationRow>(
              'SELECT * FROM search.identity_writer_gate WHERE partition_no=0 AND physical_target=$1 FOR UPDATE',
              [options.index],
            )
          ).rows[0]!;
          if (
            row.publication_job === input.job &&
            row.publication_fence &&
            isDeepStrictEqual(row.publication_consumer, input.consumer)
          )
            return noEffect(row.publication_fence);
          if (row.publication_fence) return pendingPublication();
          const token = crypto.randomUUID();
          await tx.query(
            `UPDATE search.identity_writer_gate SET publication_job=$2,publication_consumer=$3,
            publication_fence=$4,publication_home=0,publication_after=NULL,publication_revision=publication_revision+1
            WHERE partition_no=0 AND physical_target=$1`,
            [options.index, input.job, input.consumer, token],
          );
          return { value: token, events: changed() };
        });
        await publicationPhysical(input);
        return {
          status: 'fenced' as const,
          fence: { ...input, fence: result.value },
          cost: { ...cost, frontierWrites: 1 },
        };
      });
    },
    drainPublication(value, context) {
      const input = structuredClone(value);
      return publicationCall(context, async (cost) => {
        await publicationPhysical(input);
        const before = await withReadTransaction(options.pool, (tx) => publicationRetained(tx, input));
        if (before.publication_home === 4096) {
          await publicationSource(input, context);
          return { status: 'drained' as const, fence: input, cost };
        }
        const home = before.publication_home;
        const result = await runCommand(options.pool, { partition: home }, async (tx, command) => {
          publicationDeadline(context);
          const receipt = await native(tx, command.transactionId);
          await publicationLock(tx, false);
          const retained = await publicationRetained(tx, input);
          if (retained.publication_revision !== before.publication_revision) return pendingPublication();
          const copiesPending = await hasRetainedWriterPublicationCopies(tx, home, options.index);
          const page = (
            await tx.query<{
              copies: {
                original_id: string;
                dispatch_state: string;
                writer_token: string | null;
                incarnation: string;
                owner_epoch: number;
              }[];
              more: boolean;
            }>(
              `WITH page AS MATERIALIZED (
               SELECT original_id,dispatch_state,writer_token,incarnation,owner_epoch FROM search.identity_writer
               WHERE partition_no=$1 AND physical_target=$2 AND ($3::uuid IS NULL OR original_id>$3)
               ORDER BY original_id LIMIT 32 FOR UPDATE
             ) SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY original_id),'[]') AS copies,
               EXISTS(SELECT 1 FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2
                 AND original_id>COALESCE((SELECT max(original_id::text)::uuid FROM page),$3::uuid)
                 LIMIT 1) AS more FROM page`,
              [home, options.index, before.publication_after],
            )
          ).rows[0]!;
          if (
            page.copies.some(
              (row) => row.incarnation !== input.consumer.incarnation || row.owner_epoch !== receipt.epoch,
            )
          )
            return pendingPublication();
          const revocable = page.copies
            .filter((row) => row.writer_token && row.dispatch_state === 'enrolled')
            .map((row) => row.original_id);
          if (revocable.length)
            await tx.query(
              `UPDATE search.identity_writer SET writer_token=NULL,dispatch_state='cancelled',settled_transaction_id=$4,
             settled_position=$5 WHERE partition_no=$1 AND physical_target=$2 AND original_id=ANY($3::uuid[])
             AND dispatch_state='enrolled'`,
              [home, options.index, revocable, receipt.transactionId, receipt.position.toString()],
            );
          const progress = {
            page,
            uncertain:
              copiesPending || page.copies.some((row) => row.writer_token && row.dispatch_state === 'dispatched'),
            revoked: revocable.length,
          };
          return revocable.length ? { value: progress, events: changed() } : noEffect(progress);
        });
        const { page, uncertain, revoked } = result.value;
        await runCommand(options.pool, { partition: 0 }, async (tx, command) => {
          publicationDeadline(context);
          await native(tx, command.transactionId);
          await publicationLock(tx, true);
          const row = await publicationRetained(tx, input);
          if (row.publication_revision !== before.publication_revision) return pendingPublication();
          if (uncertain) return noEffect(null);
          await tx.query(
            `UPDATE search.identity_writer_gate SET publication_home=$3,publication_after=$4,
            publication_revision=publication_revision+1 WHERE partition_no=0 AND physical_target=$1 AND publication_fence=$2`,
            [
              options.index,
              input.fence,
              page.more ? home : home + 1,
              page.more ? page.copies.at(-1)!.original_id : null,
            ],
          );
          return { value: null, events: changed() };
        });
        await publicationPhysical(input);
        return {
          status: 'draining' as const,
          fence: input,
          cost: {
            ...cost,
            inputKeys: page.copies.length + Number(page.more),
            resultWrites: revoked,
            frontierWrites: Number(!uncertain),
          },
        };
      });
    },
    adoptPublication(value, context) {
      const input = structuredClone(value);
      return publicationCall(context, async (cost) => {
        await publicationSource(input, context);
        await publicationPhysical(input);
        const row = await withReadTransaction(options.pool, (tx) => publicationRetained(tx, input));
        if (row.publication_home !== 4096) return pendingPublication();
        return { status: 'held' as const, fence: input, cost };
      });
    },
    releasePublication(value, context) {
      const input = structuredClone(value);
      return publicationCall(context, async (cost) => {
        await publicationPhysical(input);
        await runCommand(options.pool, { partition: 0 }, async (tx, command) => {
          publicationDeadline(context);
          await native(tx, command.transactionId);
          await publicationLock(tx, true);
          const job = await publicationJob(tx, input);
          const row = (
            await tx.query<PublicationRow>(
              'SELECT * FROM search.identity_writer_gate WHERE partition_no=0 AND physical_target=$1 FOR UPDATE',
              [options.index],
            )
          ).rows[0];
          // A released locator remains retained for idempotent replay; another job cannot release it.
          const owner = await readPartition(tx, 0);
          if (
            owner?.writeState === 'active' &&
            row?.owner_epoch === owner.epoch &&
            row.consumer === options.consumer &&
            row.incarnation === input.consumer.incarnation &&
            row.publication_job === input.job &&
            row.publication_fence === null &&
            row.publication_released_fence === input.fence &&
            isDeepStrictEqual(row.publication_consumer, input.consumer)
          )
            return noEffect(null);
          await publicationRetained(tx, input);
          // Erasure never switches an alias. A fully drained gate can also be safely aborted
          // when a current Source page changes, before repairing the replacement page.
          if (job.barrier ? row!.publication_home !== 4096 : job.phase === 'intent') return pendingPublication();
          await tx.query(
            `UPDATE search.identity_writer_gate SET publication_released_fence=publication_fence,publication_fence=NULL,
            publication_revision=publication_revision+1 WHERE partition_no=0 AND physical_target=$1`,
            [options.index],
          );
          return { value: null, events: changed() };
        });
        return { status: 'released' as const, cost: { ...cost, frontierWrites: 1 } };
      });
    },
  };

  const guard: SearchWriterNativeCustody & SearchWriterPublicationGuard = {
    ...publication,
    fenceOriginal: (job, original) =>
      fenceSearchIdentityWriter(options.pool, { job, original, index: options.index, search: options.search }),
    adoptGenerationPublicationBarrier: inspect,
    async closeGeneration(partition) {
      const { incarnation, writeAlias } = await readSearchWriterPhysicalTarget(options.search, options.index);
      const token = crypto.randomUUID();
      const closed = await runCommand(options.pool, { partition }, async (tx, context) => {
        const receipt = await native(tx, context.transactionId);
        const row = await gate(tx, receipt, incarnation, writeAlias);
        if (row.closed_token) return noEffect(row.closed_token);
        await tx.query(
          `UPDATE search.identity_writer_gate SET closed_token=$3,closed_transaction_id=$4,
          closed_position=$5,fence_generation=fence_generation+1 WHERE partition_no=$1 AND physical_target=$2`,
          [partition, options.index, token, receipt.transactionId, receipt.position.toString()],
        );
        return { value: token, events: changed() };
      });
      return inspect({ partition, token: closed.value });
    },
    async readRetainedCopies(value, after) {
      locator(value, after);
      return withReadTransaction(options.pool, async (tx) => {
        const target = await retained(tx, value);
        const frontier = after === null ? '' : 'AND original_id>$3::uuid';
        const parameters = after === null ? [value.partition, options.index] : [value.partition, options.index, after];
        const rows = (
          await tx.query<CopyRow>(
            `SELECT original_id::text,source_position,visible_transaction_id,
          visible_position,writer_transaction_id,writer_position,writer_token,dispatch_state,owner_epoch,incarnation
          FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2
          ${frontier} ORDER BY original_id LIMIT 100`,
            parameters,
          )
        ).rows;
        if (rows.some((row) => row.owner_epoch !== target.owner_epoch || row.incarnation !== target.incarnation))
          throw unavailable('Retained Search copy requires native handoff custody');
        return {
          copies: rows.map((row) => ({
            original: row.original_id,
            state: row.dispatch_state,
            sourcePosition: row.source_position === null ? null : BigInt(row.source_position),
            visible: point(value.partition, row.owner_epoch, row.visible_transaction_id, row.visible_position),
            enrollment:
              row.writer_token === null
                ? null
                : point(value.partition, row.owner_epoch, row.writer_transaction_id, row.writer_position),
          })),
          next: rows.length === 100 ? rows.at(-1)!.original_id : null,
        };
      });
    },
    async recoverInterrupted(value, after) {
      locator(value, after);
      const result = await runCommand(options.pool, { partition: value.partition }, async (tx, context) => {
        const receipt = await native(tx, context.transactionId);
        const target = await retained(tx, value);
        await gate(tx, receipt, target.incarnation, target.write_alias);
        const frontier = after === null ? '' : 'AND original_id>$3::uuid';
        const parameters = after === null ? [value.partition, options.index] : [value.partition, options.index, after];
        const rows = (
          await tx.query<CopyRow>(
            `SELECT original_id::text,dispatch_state,owner_epoch,incarnation FROM search.identity_writer
          WHERE partition_no=$1 AND physical_target=$2 AND writer_token IS NOT NULL
          ${frontier} ORDER BY original_id LIMIT 100 FOR UPDATE`,
            parameters,
          )
        ).rows;
        if (rows.some((row) => row.owner_epoch !== target.owner_epoch || row.incarnation !== target.incarnation))
          throw unavailable('Interrupted Search writer requires native handoff custody');
        const revocable = rows.filter((row) => row.dispatch_state === 'enrolled').map((row) => row.original_id);
        if (revocable.length)
          await tx.query(
            `UPDATE search.identity_writer SET writer_token=NULL,dispatch_state='cancelled',
          settled_transaction_id=$4,settled_position=$5 WHERE partition_no=$1 AND physical_target=$2
          AND original_id=ANY($3::uuid[]) AND dispatch_state='enrolled'`,
            [value.partition, options.index, revocable, receipt.transactionId, receipt.position.toString()],
          );
        const progress = {
          examined: rows.length,
          revoked: revocable.length,
          uncertain: rows.length - revocable.length,
          next: rows.length === 100 ? rows.at(-1)!.original_id : null,
        };
        return revocable.length ? { value: progress, events: changed() } : noEffect(progress);
      });
      return result.value;
    },
    async repair(subject, obligation, repairLocator, context) {
      if (!repairLocator || repairLocator.length > 8192 || obligation < 0n)
        throw new TypeError('Repair requires its retained native step and own-home Source obligation');
      const partition = subjectPartition(subject);
      keys(partition, [subject]);
      const commandOptions = { partition, deadline: context.deadline };
      const physical = await readSearchWriterPhysicalTarget(options.search, options.index);
      type RepairRow = {
        repair_locator: string | null;
        repair_action: string | null;
        repair_receipt: string | null;
        writer_token: string | null;
        writer_transaction_id: string;
        writer_position: string;
        owner_epoch: number;
        incarnation: string;
        dispatch_state: string;
        closed_job: string | null;
      };
      const readWriter = async () =>
        (
          await options.pool.query<RepairRow>(
            `SELECT repair_locator,repair_action,repair_receipt,writer_token,writer_transaction_id,
        writer_position,owner_epoch,incarnation,dispatch_state,closed_job FROM search.identity_writer
        WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
            [partition, options.index, subject],
          )
        ).rows[0];
      let row = await readWriter();
      if (row?.repair_locator !== repairLocator) {
        // Ordinary current Source, counts and serializer; never splice a stale engine document.
        const snapshot = await options.source.read(partition, [subject]);
        const subjects = validateIndexObservation(snapshot, partition, [subject], obligation);
        const sourceSubject = subjects.get(subject);
        const counts =
          sourceSubject?.visibility === 'visible' && sourceSubject.redirect === null
            ? await options.listing.read(partition, [subject])
            : undefined;
        const actions = await prepareBoundedSortKeys(
          options.search,
          options.index,
          documentActions(snapshot, [subject], counts, options.calendarFormat),
        );
        const action = actions[0];
        if (!action || action.version < obligation || action.version > BigInt(Number.MAX_SAFE_INTEGER))
          throw unavailable('Repair Source version is not an ordinary exact native version');
        const encoded = repairEncode(action);
        if (Buffer.byteLength(encoded) > 1048576) throw unavailable('Repair action exceeds native custody');
        const token = crypto.randomUUID();
        await runCommand(options.pool, commandOptions, async (tx, command) => {
          const receipt = await native(tx, command.transactionId);
          await publicationAdmission(tx);
          const target = await gate(tx, receipt, physical.incarnation, physical.writeAlias);
          if (target.closed_token) throw unavailable('Search generation is closed to repair enrollment');
          const enrolled = await tx.query(enroll.sql, [
            partition,
            options.index,
            physical.incarnation,
            receipt.epoch,
            token,
            receipt.transactionId,
            receipt.position.toString(),
            [subject],
          ]);
          if (enrolled.rowCount !== 1) throw unavailable('Repair writer is pending or structurally fenced');
          await tx.query(
            `UPDATE search.identity_writer SET repair_locator=$4,repair_action=$5,repair_receipt=NULL
            WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3`,
            [partition, options.index, subject, repairLocator, encoded],
          );
          await tx.query(
            `UPDATE search.identity_writer_gate SET enrollment_generation=enrollment_generation+1
            WHERE partition_no=$1 AND physical_target=$2`,
            [partition, options.index],
          );
          return { value: null, events: changed() };
        });
        row = await readWriter();
      }
      if (
        !row ||
        row.repair_locator !== repairLocator ||
        !row.repair_action ||
        row.closed_job ||
        row.incarnation !== physical.incarnation
      )
        throw unavailable('Retained repair writer changed');
      if (row.dispatch_state === 'settled' && row.writer_token === null && row.repair_receipt)
        return decodeSearchRepairWriterReceipt(row.repair_receipt);
      if (!row.writer_token || !['enrolled', 'dispatched'].includes(row.dispatch_state))
        throw unavailable('Repair writer was cancelled or lost');
      const action = JSON.parse(row.repair_action, (_key, item) =>
        item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.nativeBigint === 'string'
          ? BigInt(item.nativeBigint)
          : item,
      ) as IndexAction;
      const token = row.writer_token;
      const enrollment: IdentityNativeReceipt = {
        partition,
        epoch: row.owner_epoch,
        transactionId: row.writer_transaction_id,
        position: BigInt(row.writer_position),
      };
      let evidence: unknown;
      if (row.dispatch_state === 'enrolled') {
        await runCommand(options.pool, commandOptions, async (tx, command) => {
          const receipt = await native(tx, command.transactionId);
          if (receipt.epoch !== enrollment.epoch) throw unavailable('Repair owner moved before dispatch');
          await gate(tx, receipt, physical.incarnation, physical.writeAlias);
          const dispatched = await tx.query(dispatchSql.sql, [
            partition,
            options.index,
            physical.incarnation,
            receipt.epoch,
            token,
            [subject],
          ]);
          if (dispatched.rowCount !== 1) throw unavailable('Repair dispatch was revoked');
          return { value: null, events: changed() };
        });
        let bulk: unknown;
        const transport: OpenSearch = {
          ...options.search,
          async bulk(lines, opts) {
            const response = await options.search.bulk(lines, opts);
            bulk = response;
            return response as never;
          },
        };
        // A throw after this boundary retains dispatched custody. No finally releases uncertainty.
        await writeIndexActions(transport, options.index, [action], {
          rejectConflicts: true,
          writeAlias: physical.writeAlias,
        });
        evidence = { kind: 'bulk', bulk };
      } else {
        if (action.op === 'delete') throw unavailable('An uncertain delete has no exact native item receipt');
        let current: {
          status: number;
          body: { _version?: number; _source?: unknown; _id?: string; _index?: string; found?: boolean };
        };
        try {
          current = await options.search.request('GET', `/${options.index}/_doc/${subject}`);
        } catch (error) {
          if (!(error instanceof OpenSearchError) || error.status !== 404) throw error;
          current = { status: 404, body: {} };
        }
        if (
          current.status !== 404 &&
          (current.status !== 200 ||
            current.body._id !== subject ||
            current.body._index !== options.index ||
            current.body.found !== true ||
            !Number.isSafeInteger(current.body._version))
        )
          throw unavailable('Repair response recovery has no current native winner');
        const version = current.status === 404 ? null : BigInt(current.body._version!);
        if (version === null || version < action.version) {
          // Absence authorizes only replay of the retained external-version action. A newer native
          // delete tombstone still rejects it; absence itself is never a successful item receipt.
          let bulk: unknown;
          const transport: OpenSearch = {
            ...options.search,
            async bulk(lines, opts) {
              const response = await options.search.bulk(lines, opts);
              bulk = response;
              return response as never;
            },
          };
          await writeIndexActions(transport, options.index, [action], {
            rejectConflicts: true,
            writeAlias: physical.writeAlias,
          });
          evidence = { kind: 'bulk', bulk };
        } else {
          if (version !== action.version || !isDeepStrictEqual(current.body._source, action.document))
            throw unavailable('Uncertain repair has a different current winner');
          const refreshed = await options.search.request('POST', `/${options.index}/_refresh`);
          validateRefreshResponse(refreshed.status, refreshed.body);
          evidence = { kind: 'recovered', current: current.body, refresh: refreshed.body };
        }
      }
      const winner = await readSearchRepairWinner(options.search, options.index, action);
      const finalPhysical = await readSearchWriterPhysicalTarget(options.search, options.index);
      if (!isDeepStrictEqual(finalPhysical, physical)) throw unavailable('Repair allocation changed after dispatch');
      const completed = await runCommand(options.pool, commandOptions, async (tx, command) => {
        const completion = await native(tx, command.transactionId);
        if (completion.epoch !== enrollment.epoch) throw unavailable('Repair owner moved before final fence');
        const target = await gate(tx, completion, physical.incarnation, physical.writeAlias);
        if (target.closed_token) throw unavailable('Repair generation closed before final fence');
        const receipt: SearchRepairWriterReceipt = {
          locator: repairLocator,
          subject,
          partition,
          epoch: enrollment.epoch,
          incarnation: physical.incarnation,
          writeAlias: physical.writeAlias,
          consumer: options.consumer,
          action,
          enrollment,
          completion,
          native: { evidence, winner },
        };
        const settled = await tx.query(settle.sql, [
          partition,
          options.index,
          physical.incarnation,
          enrollment.epoch,
          token,
          enrollment.transactionId,
          enrollment.position.toString(),
          [subject],
          completion.transactionId,
          completion.position.toString(),
          action.version.toString(),
        ]);
        if (settled.rowCount !== 1) throw unavailable('Repair writer changed at final fence');
        await tx.query(
          `UPDATE search.identity_writer SET repair_receipt=$4
          WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 AND repair_locator=$5`,
          [partition, options.index, subject, repairEncode(receipt), repairLocator],
        );
        return { value: receipt, events: changed() };
      });
      return completed.value;
    },
    async write(partition, input, obligation) {
      if (typeof obligation !== 'bigint' || obligation < 0n)
        throw new TypeError('Search writer requires a native nonnegative obligation');
      const ids = keys(partition, input);
      const { incarnation, writeAlias } = await readSearchWriterPhysicalTarget(options.search, options.index);
      const token = crypto.randomUUID();
      const enrollment = await runCommand(options.pool, { partition }, async (tx, context) => {
        const receipt = await native(tx, context.transactionId);
        await publicationAdmission(tx);
        const target = await gate(tx, receipt, incarnation, writeAlias);
        if (target.closed_token) throw unavailable('Search generation is closed to writer enrollment');
        await tx.query(
          `UPDATE search.identity_writer_gate SET enrollment_generation=enrollment_generation+1
          WHERE partition_no=$1 AND physical_target=$2`,
          [partition, options.index],
        );
        const result = await tx.query(enroll.sql, [
          partition,
          options.index,
          incarnation,
          receipt.epoch,
          token,
          receipt.transactionId,
          receipt.position.toString(),
          ids,
        ]);
        if (result.rowCount !== ids.length)
          throw unavailable('Search writer is enrolled, structurally closed, or awaiting owner custody');
        return { value: receipt, events: changed() };
      });
      const receipt = enrollment.value;
      let dispatched = false;
      let revoked = false;
      let sourcePosition: bigint | null = null;
      const release = async () => {
        await runCommand(options.pool, { partition }, async (tx, context) => {
          const completion = await native(tx, context.transactionId);
          if (completion.epoch !== receipt.epoch) throw unavailable('Search writer owner changed before custody');
          const result = await tx.query(settle.sql, [
            partition,
            options.index,
            incarnation,
            receipt.epoch,
            token,
            receipt.transactionId,
            receipt.position.toString(),
            ids,
            completion.transactionId,
            completion.position.toString(),
            sourcePosition?.toString() ?? null,
          ]);
          if (result.rowCount !== ids.length) throw unavailable('Search writer enrollment changed before custody');
          return { value: null, events: changed() };
        });
      };
      try {
        const snapshot = await options.source.read(partition, ids);
        const floor = receipt.position > obligation ? receipt.position : obligation;
        const subjects = validateIndexObservation(snapshot, partition, ids, floor);
        const visible = ids.filter((id) => {
          const subject = subjects.get(id);
          return subject?.visibility === 'visible' && subject.redirect === null;
        });
        const counts = visible.length ? await options.listing.read(partition, visible) : undefined;
        const actions = await prepareBoundedSortKeys(
          options.search,
          options.index,
          documentActions(snapshot, ids, counts, options.calendarFormat),
        );
        const current = await readSearchWriterPhysicalTarget(options.search, options.index);
        if (current.incarnation !== incarnation || current.writeAlias !== writeAlias)
          throw unavailable('Search physical index changed before dispatch');
        // Native CAS makes pre-dispatch recovery revoke a delayed continuation before external I/O.
        await runCommand(options.pool, { partition }, async (tx, context) => {
          const dispatch = await native(tx, context.transactionId);
          if (dispatch.epoch !== receipt.epoch) throw unavailable('Search writer home changed before dispatch');
          await gate(tx, dispatch, incarnation, writeAlias);
          const result = await tx.query(dispatchSql.sql, [
            partition,
            options.index,
            incarnation,
            receipt.epoch,
            token,
            ids,
          ]);
          if (result.rowCount !== ids.length) {
            revoked = true;
            throw unavailable('Search writer was revoked before dispatch');
          }
          return { value: null, events: changed() };
        });
        // Set BEFORE calling the transport: a thrown/lost response says nothing about native application.
        dispatched = true;
        await writeIndexActions(options.search, options.index, actions, { rejectConflicts: true, writeAlias });
        const observed = await readSearchWriterPhysicalTarget(options.search, options.index);
        if (observed.incarnation !== incarnation || observed.writeAlias !== writeAlias)
          throw unavailable('Search physical index changed after dispatch');
        sourcePosition = snapshot.position;
      } catch (error) {
        // No engine mutation was invoked on this branch. A failed release still retains native custody.
        if (!dispatched && !revoked) await release();
        throw error;
      }
      // Source and engine have released before this one-home native command. Failure retains enrollment.
      await release();
    },
  };
  generationReaders.set(guard, async (partition, input, obligation) => {
    const ids = keys(partition, input);
    const target = await readSearchWriterPhysicalTarget(options.search, options.index);
    const snapshot = await options.source.read(partition, ids);
    const subjects = validateIndexObservation(snapshot, partition, ids, obligation);
    const visible = ids.filter((id) => {
      const subject = subjects.get(id);
      return subject?.visibility === 'visible' && subject.redirect === null;
    });
    const counts = visible.length ? await options.listing.read(partition, visible) : undefined;
    const actions = await prepareBoundedSortKeys(
      options.search,
      options.index,
      documentActions(snapshot, ids, counts, options.calendarFormat),
    );
    const versions = await withReadTransaction(options.pool, async (tx) => {
      const owner = await readPartition(tx, partition);
      if (!owner || owner.writeState !== 'active' || owner.position !== snapshot.position) return null;
      const rows = (
        await tx.query<CopyRow>(
          `SELECT original_id::text,incarnation,owner_epoch,writer_token,dispatch_state,
         source_position::text,visible_transaction_id,visible_position::text
         FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2 AND original_id=ANY($3::uuid[])`,
          [partition, options.index, ids],
        )
      ).rows;
      if (
        rows.length !== ids.length ||
        rows.some(
          (row) =>
            row.incarnation !== target.incarnation ||
            row.owner_epoch !== owner.epoch ||
            row.writer_token !== null ||
            row.dispatch_state !== 'settled' ||
            row.source_position === null ||
            row.visible_transaction_id === null ||
            row.visible_position === null ||
            BigInt(row.source_position) > snapshot.position ||
            BigInt(row.visible_position) > snapshot.position,
        )
      )
        return null;
      return new Map(rows.map((row) => [row.original_id, BigInt(row.source_position!)]));
    });
    const current = await readSearchWriterPhysicalTarget(options.search, options.index);
    if (!versions || current.incarnation !== target.incarnation || current.writeAlias !== target.writeAlias)
      return null;
    return actions.map((action) => ({ ...action, version: versions.get(action.id)! }));
  });
  return guard;
}

export type SearchIdentityWriterFence = Readonly<{
  state: 'draining' | 'closed';
  gate: IdentityNativeReceipt;
  writer: IdentityNativeReceipt | null;
  settlement: IdentityNativeReceipt | null;
  sourcePosition: bigint | null;
}>;

/** Install the real home-local structural close, including first absence, and observe in-flight custody.
 * This is a local operational record, NEVER a fixed participant completion or a complete-support proof.
 * There is deliberately no timeout, force-release, caller completion flag or reopen method.
 */
export async function fenceSearchIdentityWriter(
  pool: Pool,
  options: Readonly<{ job: IdentityJobRef; original: string; index: string; search: OpenSearch }>,
): Promise<SearchIdentityWriterFence> {
  const partition = subjectPartition(options.original);
  const { incarnation } = await readSearchWriterPhysicalTarget(options.search, options.index);
  const result = await runCommand(pool, { partition }, async (tx, context) => {
    await identityEpochStore.admitHomeEffect(tx, { kind: 'structural', job: options.job, original: options.original });
    const receipt = await native(tx, context.transactionId);
    const previous = (
      await tx.query(
        `SELECT * FROM search.identity_writer
       WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3 FOR UPDATE`,
        [partition, options.index, options.original],
      )
    ).rows[0];
    if (previous && (previous.owner_epoch !== receipt.epoch || previous.incarnation !== incarnation))
      throw unavailable('Search writer incarnation or home requires native handoff custody');
    const point = (transactionId: string | null, position: string | null): IdentityNativeReceipt | null =>
      transactionId === null ? null : { partition, epoch: receipt.epoch, transactionId, position: BigInt(position!) };
    const decode = (row: typeof previous): SearchIdentityWriterFence => ({
      state: row.writer_token === null ? 'closed' : 'draining',
      gate: point(row.closed_transaction_id, row.closed_position)!,
      writer: row.writer_token === null ? null : point(row.writer_transaction_id, row.writer_position),
      settlement: point(row.settled_transaction_id, row.settled_position),
      sourcePosition: row.source_position === null ? null : BigInt(row.source_position),
    });
    if (previous?.closed_job) {
      if (previous.closed_job !== options.job.jobId || BigInt(previous.closed_epoch) !== options.job.epoch)
        throw unavailable('Search writer is closed for another native identity job');
      return noEffect(decode(previous));
    }
    const written = await tx.query(fence.sql, [
      partition,
      options.index,
      options.original,
      incarnation,
      receipt.epoch,
      options.job.jobId,
      options.job.epoch.toString(),
      receipt.transactionId,
      receipt.position.toString(),
    ]);
    if (written.rowCount !== 1) throw unavailable('Search writer structural close raced enrollment or handoff');
    recordIdentityEpochNativeCommit(tx, 'search-canonical-index');
    return {
      value: {
        state: previous?.writer_token ? ('draining' as const) : ('closed' as const),
        gate: receipt,
        writer: previous?.writer_token ? point(previous.writer_transaction_id, previous.writer_position) : null,
        settlement: previous ? point(previous.settled_transaction_id, previous.settled_position) : null,
        sourcePosition: previous?.source_position == null ? null : BigInt(previous.source_position),
      },
      events: changed(),
    };
  });
  return result.value;
}

/** Provisional publication surface until the native producer installs its admission/copy barrier.
 * Composing these methods with the real ordinary writer grants no publication authority.
 */
const publicationUnavailable = async (): Promise<PublicFilterConsumerUnavailable> => ({
  status: 'unready',
  reason: 'source_pending',
  cost: {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  },
});
export const unavailableSearchWriterPublication: Omit<SearchWriterPublicationGuard, 'write'> = Object.freeze({
  fencePublication: publicationUnavailable,
  drainPublication: publicationUnavailable,
  adoptPublication: publicationUnavailable,
  releasePublication: publicationUnavailable,
});
