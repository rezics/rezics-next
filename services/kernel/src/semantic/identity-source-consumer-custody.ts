import type { Pool, QueryResultRow } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { CommandTransaction } from '../command/command.ts';
import type { HistoryBarrier } from '../history/registry.ts';
import type {
  IdentityFrontier,
  IdentityJobRef,
  IdentityNativeReceipt,
  IdentityReceipt,
  NativeStepWork,
} from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketData } from './identity-epoch-prearm-contract.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { LibraryScopeEffectSeal, LibraryScopeEffectsPage, LibraryScopeEffectsKey } from '../library/identity-scope-effects.ts';
import { readLibraryScopeEffectsPage, verifyLibraryScopeEffectsSeal } from '../library/identity-scope-effects.ts';
import type { LibraryExpectedEffectAfter } from '../library/identity-scope-effects.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { instrumentNativeCollectionWork, requireNativeCollectionFootprint } from '../library/collection-source-work.ts';
import { readIdentityPrearmCustodyPage, verifyIdentityPrearmCustodyCut } from './identity-epoch-prearm-custody.ts';
import { identityScopeAddress, scopeConsumerFootprint } from './identity-scoped-observations.ts';
import { readIdentityReceivingSelection, reconcileIdentityReceivingEffect } from './identity-receiving-effects.ts';
import type { IdentityReceivingSelection, IdentityReceivingRecord } from './identity-receiving-effects-types.ts';
import { readAccountIdentitySource, type AccountIdentitySource } from '../access/agent-verification-identity.ts';
import type { AccountIdentityReversalSettlement } from '../access/agent-verification-identity-reversal.ts';
import {
  currentCommand,
  currentCommandResources,
  noEffect,
  registerCommandCallback,
  runCommand,
} from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { bindSemanticProducerRoles, recordSemanticSourceCommit } from './erasure-producer.ts';
import { identityBindingData, lookupIdentityBinding, readAccountIdentityUndo } from './identity-epoch-binding.ts';
import {
  identityEpochStore,
  identityJobPartition,
  identityReceiptKey,
  IdentityEpochStoreError,
  serializeIdentityValue,
} from './identity-epoch-store.ts';
import { SEMANTIC_ERASURE_PROGRESS } from './account-erasure.ts';
import claim from './identity-source-consumer-custody-claim.sql';
import job from './identity-source-consumer-custody-job.sql';
import insert from './identity-source-consumer-custody-insert.sql';
import select from './identity-source-consumer-custody-select.sql';
import progressSQL from './identity-source-consumer-custody-progress.sql';
import appendSQL from './identity-source-consumer-custody-append.sql';
import historySQL from './identity-source-consumer-custody-history.sql';
import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { AgentIdentityRetirementStage } from '../history/agent-identity-retirement.ts';
import type { AgentIdentitySDKReceivingBinding } from '../history/agent-identity-sdk-fence.ts';
import {
  lockSdkWorkflowWriterState,
  SDK_TRANSACTION_FENCE_COST,
  type SdkWriterState,
} from '../work/sdk-retirement-fence.ts';
import type { IdentitySourceConsumerMaintenanceWork } from './identity-source-consumer-maintenance.ts';
import {
  identitySourceConsumerDirectoryPlan,
  type IdentitySourceScheduledOperation,
} from './identity-source-maintenance-config.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../command/dispatch-lifetime.ts';
import {
  currentIdentitySourceConsumerMaintenance,
  withIdentitySourceConsumerLibraryRemainder,
  isLiveIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
  isPrepaidIdentitySourceConsumerMaintenance,
  claimIdentitySourceCustodyAdvancement,
  claimIdentitySourceScheduledCall,
  claimIdentitySourceLibraryCall,
  withIdentitySourceNoEffectCommand,
  withIdentitySourceFenceCommand,
  IdentitySourceOriginalUnavailable,
  identitySourceConsumerLibraryWork,
} from './identity-source-consumer-maintenance.ts';

// The selected path does not return arbitrarily large saved intent/sources.
// Receipt equality is performed on the native row. Its digest, accepted job and
// generation still resolve the very same immutable accepted input.
const selectedClaimSQL = `SELECT c.generation::text,c.scope_digest,c.job_home,
  k.transaction_id AS binding_transaction_id
FROM semantic.identity_epoch_receipt_binding b
JOIN semantic.identity_epoch_receipt_claim c USING(partition_no,receipt_key,generation)
JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no
  AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin
JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active'
  AND p.epoch=n.epoch AND p.position>=n.position
WHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.state='accepted'
  AND b.intent_digest=$3 AND c.intent_digest=$3 AND c.job_id=$4 AND c.job_epoch=$5
  AND b.accepted_job=c.job_id AND b.accepted_epoch=c.job_epoch AND c.receipt=$6::jsonb
  AND octet_length(c.scope_digest)<=128 AND c.job_home BETWEEN 0 AND 4095
FOR UPDATE OF b FOR SHARE OF c,k,n,p`;
// The ordinary imported job query projects unbounded text. This selected literal
// proves the width before projecting it; it does not truncate or alter job intent.
const selectedPublishedSQL = `SELECT j.scope_digest
FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=j.partition_no
  AND n.transaction_id=j.recorded_transaction_id AND n.purpose='admission'
JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'
  AND p.epoch=n.epoch AND p.position>=n.position
JOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='published'
  AND octet_length(j.scope_digest)<=128
  AND c.published_epoch>=j.epoch AND c.pending_job IS DISTINCT FROM j.job_id
FOR SHARE OF j,n,p,c`;
export const IDENTITY_SOURCE_LOCAL_SQL = Object.freeze({
  retained: select.sql, progress: progressSQL.sql, accepted: selectedClaimSQL, published: selectedPublishedSQL,
});
const sourcePrice = (rows: number, points: number, statements: number, bytes: number, seeks: number) =>
  Object.freeze({ engineRequests: 0 as const, work: Object.freeze({
    candidateKeys: 0, nativeRows: rows, identityMetadataRows: 0, nativePoints: points,
    witnessKeys: 0, statements, bytes, emptySeeks: seeks,
  }) });
// Native indexed rows only: no candidate enumeration, Semantic identity mapping
// metadata or listing witness expansion. SELECTs fire no write/FK/row triggers.
// Scalar result sizes are schema-width JSON projections, including property names.
const scalarJSONBytes = (row: object) => Buffer.byteLength(JSON.stringify([row]));
const n19 = '9'.repeat(19), uuid36 = 'f'.repeat(36);
const sourceLiterals = Object.freeze({
  retained: Object.freeze({ sql: select.sql, rows: 6, points: 6,
    output: scalarJSONBytes({ erasure_key: n19, binding_generation: n19,
      transaction_id: uuid36, owner_epoch: 2147483647, position: n19 }),
    // 13 operands: receipt_key<=160, digest64, three UUIDs, position/job
    // bigint strings, timestamp<=128, closed role<=9, four bounded integers.
    binds: 2 + 12 + 2 * 9 + 6 * (160 + 64 + 36 * 3 + 19 * 2 + 128 + 9) + 4 * 10 }),
  progress: Object.freeze({ sql: progressSQL.sql, rows: 3, points: 3,
    // Combined directory/effect JSON is schema-bounded to 2048 bytes. The
    // literal scalar projection is separately bounded; NULLs are not a bound
    // on the eventual cursor. LIMIT 1 and the leading custody index bound reads.
    output: 2048 + scalarJSONBytes({ sequence: n19, state: 'transferred', directory_after: null,
      ticket_key: 'f'.repeat(64), effect_after: null, seal_digest: 'f'.repeat(64),
      replay_generation: n19, undo_generation: n19, restore_generation: n19,
      transaction_id: uuid36, owner_epoch: 2147483647, position: n19,
      native_current: false, receiving_partition: 4095, receiving_epoch: 2147483647,
      receiving_position: n19, receiving_transaction_id: uuid36 }),
    binds: 2 + 1 + 4 + 2 + 19 }),
  accepted: Object.freeze({ sql: selectedClaimSQL, rows: 5, points: 5,
    output: 5 * 128 + scalarJSONBytes({ generation: n19, scope_digest: 'f'.repeat(128),
      job_home: 4095, binding_transaction_id: uuid36 }),
    binds: 2 + 5 + 10 + 2 * 5 + 6 * (160 + 64 + 36 + 19 + 256) }),
  published: Object.freeze({ sql: selectedPublishedSQL, rows: 4, points: 4,
    output: 5 * 128 + scalarJSONBytes({ scope_digest: 'f'.repeat(128) }),
    binds: 2 + 2 + 4 + 2 * 2 + 36 + 19 }),
});

/** Complete fixed local READ declarations, independent of all foreign children.
 * Bytes include the actual SQL text, bounded serialized binds and full schema
 * projection. A hit/absence reserves the same leading-key probes and one EOF.
 */
export const IDENTITY_SOURCE_LOCAL_READ_DECLARATIONS = Object.freeze(Object.fromEntries(
  Object.entries(sourceLiterals).map(([name, literal]) => [name,
    sourcePrice(literal.rows, literal.points, 1,
      Buffer.byteLength(literal.sql) + literal.binds + literal.output, 1)]),
) as Readonly<Record<keyof typeof sourceLiterals, ReturnType<typeof sourcePrice>>>);

/** Disjoint local INSERT bodies. These are not successful whole commands: default
 * sequence allocation, FK checks, erasure capture and terminal binding triggers
 * must be composed as named children before dispatch. In particular their native
 * work cannot inherit Core's single-no-effect envelope.
 * Parameter maxima include JSON escaping (six bytes per bounded text byte).
 */
export const IDENTITY_SOURCE_LOCAL_MUTATION_COMPONENTS = Object.freeze({
  custodyInsert: Object.freeze({
    body: sourcePrice(1, 1, 1, Buffer.byteLength(insert.sql) +
      2 + 17 + 18 * 2 + 6 * (160 + 64 + 19 * 3 + 36 * 5 + 128 + 9 + 128) + 5 * 10, 1),
    foreignKeys: Object.freeze([
      'identity_epoch_receipt_claim(partition_no,receipt_key,generation)',
      'erasure_source_commit(partition_no,transaction_id)',
    ]),
    children: Object.freeze(['semantic.erasure_record_key default',
      'semantic.capture_identity_source_consumer_custody_erasure / capture_erasure_roles']),
  }),
  terminalAppend: Object.freeze({
    body: sourcePrice(1, 1, 1, Buffer.byteLength(appendSQL.sql) +
      2 + 21 + 22 * 2 + 6 * (19 * 8 + 11 + 2048 * 2 + 64 * 2 + 36 * 3) + 6 * 10, 1),
    foreignKeys: Object.freeze([
      'identity_epoch_source_consumer_custody(partition_no,erasure_key)',
      'identity_epoch_source_consumer_terminal(partition_no,custody_key,sequence)',
      'erasure_source_commit(partition_no,transaction_id)',
    ]),
    children: Object.freeze(['semantic.erasure_record_key default',
      'semantic.capture_identity_source_consumer_custody_erasure / capture_erasure_roles',
      'semantic.bind_identity_source_consumer_terminal / keep_identity_epoch_accepted_binding']),
  }),
});

/** Closed body composition, independently useful to the declaration owners. The
 * same SQL component can appear at multiple reached sites; no receipt cache or
 * alternative branch makes repeated work free. Each list names its exact child
 * rather than accepting a caller-supplied total.
 */
export const IDENTITY_SOURCE_LOCAL_CALLS = Object.freeze({
  retainedDiscovery: Object.freeze({ controls: COMMAND_DISPATCH_ALLOWANCE,
    reads: Object.freeze({ retained: 1, progress: 1 }), foreign: Object.freeze([]) }),
  acceptedBinding: Object.freeze({ controls: COMMAND_DISPATCH_ALLOWANCE,
    reads: Object.freeze({ accepted: 1 }), foreign: Object.freeze([]) }),
  published: Object.freeze({ controls: COMMAND_DISPATCH_ALLOWANCE,
    reads: Object.freeze({ published: 1 }),
    foreign: Object.freeze(['identityEpochStore.readJob; fixed mapping/Search/Library reconcileStepReceipt']) }),
  terminalVerify: Object.freeze({ controls: COMMAND_DISPATCH_ALLOWANCE,
    reads: Object.freeze({ retained: 1, accepted: 1, progress: 1 }),
    foreign: Object.freeze(['binding.verifyIdentitySourceConsumerCut; Account technical/reversal verifier']) }),
  progress: Object.freeze({ controls: COMMAND_DISPATCH_ALLOWANCE,
    reads: Object.freeze({ progress: 1 }), foreign: Object.freeze([]) }),
  prepare: Object.freeze({ profile: 'event-callback-source-association',
    reads: Object.freeze({ accepted: 1, retained: 1 }), mutation: 'custodyInsert',
    foreign: Object.freeze(['readAccountIdentitySource; readPartition; bindSemanticProducerRoles; recordSemanticSourceCommit']) }),
  checkpoint: Object.freeze({ profile: 'event-callback-source-association',
    reads: Object.freeze({ accepted: 1, progress: 1 }), mutation: 'terminalAppend',
    foreign: Object.freeze(['readAccountIdentitySource; readPartition; bindSemanticProducerRoles; recordSemanticSourceCommit']) }),
  finish: Object.freeze({ profile: 'event-callback-source-association',
    reads: Object.freeze({ accepted: 1, progress: 1 }), mutation: 'terminalAppend',
    foreign: Object.freeze(['verifyIdentityPrearmCustodyCut; binding cut; Account receiving/reversal; erasure roles; source commit']) }),
});

export function identitySourceCustodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const id = (v: unknown) => typeof v === 'string' && uuid.test(v);
  const int = (v: unknown, max: number, min = 0) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
  const big = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9223372036854775807n;
  const str = (v: unknown, max: number) => typeof v === 'string' && Buffer.byteLength(v) <= max;
  const key = (v: unknown) => {
    if (!str(v, 160)) return false;
    try { const tuple: unknown = JSON.parse(v as string); return Array.isArray(tuple) && tuple.length === 3 &&
      ['account-agent.verify', 'account-agent.unverify'].includes(tuple[0]) && id(tuple[1]) && id(tuple[2]); }
    catch { return false; }
  };
  let name: keyof typeof sourceLiterals;
  if (sql === select.sql) {
    if (values.length !== 13 || !int(values[0],4095) || !key(values[1]) || !str(values[2],64) ||
        !digest.test(values[2] as string) || !int(values[3],2147483647,1) || !big(values[4]) ||
        !id(values[5]) || !id(values[6]) || !big(values[7]) || !id(values[8]) || !int(values[9],65535) ||
        !int(values[10],2147483647,1) || !str(values[11],128) || !Number.isFinite(Date.parse(values[11] as string)) ||
        !['subject','requester','decider'].includes(values[12] as string)) return undefined;
    name = 'retained';
  } else if (sql === progressSQL.sql) {
    if (values.length !== 2 || !int(values[0],4095) || !big(values[1])) return undefined;
    name = 'progress';
  } else if (sql === selectedPublishedSQL) {
    if (values.length !== 3 || !int(values[0],4095) || !id(values[1]) || !big(values[2])) return undefined;
    name = 'published';
  } else if (sql === selectedClaimSQL) {
    if (values.length !== 6 || !int(values[0],4095) || !key(values[1]) || !str(values[2],64) ||
        !digest.test(values[2] as string) || !id(values[3]) || !big(values[4]) || !str(values[5],256)) return undefined;
    try {
      const receipt = JSON.parse(values[5] as string);
      if (Object.keys(receipt).length !== 3 || !id(receipt.account) || !id(receipt.receipt) ||
          identityReceiptKey(receipt) !== values[1]) return undefined;
    } catch { return undefined; }
    name = 'accepted';
  } else return undefined;
  const literal = sourceLiterals[name];
  const binds = Buffer.byteLength(json(values));
  if (binds > literal.binds) return undefined;
  return sourcePrice(literal.rows, literal.points, 1, Buffer.byteLength(sql) + binds + literal.output, 1).work;
}

/** Source-owned body SQL reserves from the Source partition, never the Library
 * partition. Core alone owns its disjoint executor/cleanup controls.
 */
async function sourceQuery<Row extends QueryResultRow = QueryResultRow>(
  tx: CommandTransaction, sql: string, values: unknown[],
) {
  const { pool, deadline } = currentCommandResources(tx);
  if (!isPrepaidIdentitySourceConsumerMaintenance(pool)) return tx.query<Row>(sql, values);
  values = structuredClone(values);
  const token = currentIdentitySourceConsumerMaintenance(pool, deadline);
  const cost = identitySourceCustodyFootprint(sql, values);
  if (!token || !cost || !reserveIdentitySourceConsumerNativeWork(pool, token, {
    rows: cost.nativeRows, points: cost.nativePoints, statements: cost.statements,
    bytes: cost.bytes, engineRequests: 0,
  }, cost)) throw new IdentitySourceOriginalUnavailable('identity-source-literal-unavailable-before-dispatch');
  const answer = await tx.query<Row>(sql, values);
  if (!isLiveIdentitySourceConsumerMaintenance(pool, token, deadline))
    throw new IdentitySourceOriginalUnavailable('identity-source-literal-lifetime-ended');
  return answer;
}

function sourceNoEffectCommand<T>(pool: Pool, partition: number, deadline: number,
  operation: IdentitySourceScheduledOperation, body: (tx: CommandTransaction) => Promise<T>) {
  if (isPrepaidIdentitySourceConsumerMaintenance(pool)) claimIdentitySourceScheduledCall(pool, operation);
  return withIdentitySourceNoEffectCommand(pool, deadline,
    () => runCommand(pool, { partition, deadline }, async (tx) => noEffect(await body(tx))));
}

/** These are precise dependent executor gaps, not prices. Preserve the event and
 * callback semantics rather than relabeling them single-no-effect. */
export const IDENTITY_SOURCE_WIDER_COMMAND_REQUIREMENTS = Object.freeze({
  prepare: 'custody insert + recordSemanticSourceCommit + producer roles + SEMANTIC_ERASURE_PROGRESS',
  checkpoint: 'terminal append + recordSemanticSourceCommit + producer roles + SEMANTIC_ERASURE_PROGRESS',
  exhaustedReceiving: 'single-source-fence: retainIdentityScopeConsumerFence + native commit SQL + SEMANTIC_ERASURE_PROGRESS',
  finish: 'terminal append + binding cut + Account technical receiver + SEMANTIC_ERASURE_PROGRESS',
});
function requireWiderSourceCommand(pool: Pool, operation: keyof typeof IDENTITY_SOURCE_WIDER_COMMAND_REQUIREMENTS): void {
  if (isPrepaidIdentitySourceConsumerMaintenance(pool))
    throw new IdentitySourceOriginalUnavailable(`identity-source-wider-executor-profile-missing:${operation}`);
}

/** Exact additive receiving ABI. The ordinary Library entry constructs its own
 * ledger and is therefore ineligible for this authentic original. An absent
 * WithWork producer refuses this operation; it never falls back to that entry.
 */
export async function readIdentitySourcePrepaidLibraryPage(
  pool: Pool, context: IdentitySourceConsumerContext,
  input: LibraryScopeEffectsKey & Readonly<{
    after: LibraryExpectedEffectAfter | null; limit: number; allowance: WorkAllowance; deadline: number;
  }>,
): Promise<LibraryScopeEffectsPage> {
  const work = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline);
  if (!work || !isPrepaidIdentitySourceConsumerMaintenance(pool) || input.limit !== 1 ||
      input.deadline !== context.deadline || input.allowance.reservationId !== work.receipt().reservationId)
    throw new IdentitySourceOriginalUnavailable('identity-source-Library-original-resources-changed');
  claimIdentitySourceLibraryCall(pool, 'effectPages');
  input = structuredClone(input);
  const installed = await import('../library/identity-scope-effects.ts');
  if (identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline) !== work)
    throw new IdentitySourceOriginalUnavailable('identity-source-Library-original-ended');
  const entry = Object.getOwnPropertyDescriptor(installed, 'readLibraryScopeEffectsPageWithWork');
  if (!entry || !('value' in entry) || typeof entry.value !== 'function')
    throw new IdentitySourceOriginalUnavailable('identity-source-readLibraryScopeEffectsPageWithWork-not-installed');
  const libraryOwner = await import('../library/collection-source-work.ts');
  if (identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline) !== work)
    throw new IdentitySourceOriginalUnavailable('identity-source-Library-original-ended');
  const declaration = Object.getOwnPropertyDescriptor(libraryOwner, 'IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION');
  if (!declaration || !('value' in declaration) || !declaration.value)
    throw new IdentitySourceOriginalUnavailable('identity-source-LibraryAllReachedCalls-declaration-not-installed');
  const read = entry.value as (pool: Pool, pageInput: typeof input,
    work: import('../library/collection-source-work.ts').NativeCollectionWork) => Promise<LibraryScopeEffectsPage>;
  // The installed Library body enforces its own exact literal policy on the
  // SAME ledger. Its Core controls are reserved by the private Source adapter
  // from the disjoint Source partition, outside Library body observation.
  const page = await read(pool, input, work);
  if (identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline) !== work)
    throw new IdentitySourceOriginalUnavailable('identity-source-Library-original-ended');
  const receipt = work.receipt();
  if (page.work.reservationId !== receipt.reservationId ||
      (Object.keys(receipt.used) as (keyof WorkDimensions)[]).some((axis) => page.work.used[axis] !== receipt.used[axis]))
    throw new IdentitySourceOriginalUnavailable('identity-source-Library-replaced-original-ledger');
  return page;
}

export type IdentitySourceConsumerReference = Readonly<{
  receipt: Exclude<IdentityReceipt, { kind: 'subject.merge' }>;
  job: IdentityJobRef;
  source: IdentityNativeReceipt;
  sourceDigest: string;
  barrier: HistoryBarrier;
  /** subject is the original source key's account, distinct from requester/decider. */
  erasedRole: 'subject' | 'requester' | 'decider';
}>;
declare const identitySourceConsumerCustody: unique symbol;
export type IdentitySourceConsumerCustody = Readonly<{
  [identitySourceConsumerCustody]: true;
}>;

/** Required additive owner exchange, not a caller proof or an installed adapter. Native
 * implementations must resolve these generations from the original accepted input. */
export type IdentitySourceConsumerGeneration = Readonly<{
  replayGeneration: string;
  undoGeneration: string;
  restoreGeneration: string;
}>;
export type IdentitySourceConsumerWork = IdentitySourceConsumerGeneration & Readonly<{ allowance: NativeStepWork }>;
export type IdentitySourceConsumerContext = Readonly<{
  deadline: number;
  identityConsumerWork?: IdentitySourceConsumerMaintenanceWork;
}>;
export type IdentitySourceConsumerDisposition = 'discharged' | 'transferred';
export type IdentitySourceScopeConsumerWork = Readonly<{
  allowance: WorkAllowance;
  /** Native owners provide proved SQL bounds. Unknown SQL must be refused before dispatch. */
  footprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined;
}>;

/** Original modules supply these methods. There is deliberately no setter/default ACK.
 * See the owning contract for the native locks, writer obligations and accounting required. */
type BindingConsumerOwner = {
  readIdentitySourceConsumerWork(
    pool: Pool,
    reference: IdentitySourceConsumerReference,
    context: IdentitySourceConsumerContext,
  ): Promise<IdentitySourceConsumerWork | null>;
  lockIdentitySourceConsumerCut(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
    expected: IdentitySourceConsumerGeneration,
    reversal?: AccountIdentityReversalSettlement,
  ): Promise<IdentitySourceConsumerDisposition | null>;
  verifyIdentitySourceConsumerCut(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
    expected: IdentitySourceConsumerGeneration,
    disposition: IdentitySourceConsumerDisposition,
    reversal?: AccountIdentityReversalSettlement,
  ): Promise<boolean>;
};
type ScopedConsumerOwner = {
  readIdentityScopeConsumerWork(
    pool: Pool,
    ticket: IdentityPrearmTicketData,
    context: IdentitySourceConsumerContext,
  ): Promise<IdentitySourceScopeConsumerWork | null>;
  retainIdentityScopeConsumerFence(
    tx: CommandTransaction,
    ticket: IdentityPrearmTicketData,
    seal: LibraryScopeEffectSeal,
  ): Promise<IdentityNativeReceipt | null>;
};
type TechnicalConsumerOwner = {
  readAccountIdentityReversalSettlement(
    pool: Pool,
    reference: IdentitySourceConsumerReference,
    context: IdentitySourceConsumerContext,
  ): Promise<AccountIdentityReversalSettlement | null>;
  acceptAccountIdentityTechnicalSource(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
  ): Promise<IdentityNativeReceipt | null>;
  verifyAccountIdentityTechnicalSource(
    tx: CommandTransaction,
    reference: IdentitySourceConsumerReference,
    receiving: IdentityNativeReceipt,
  ): Promise<boolean>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = /^[0-9a-f]{64}$/;
const json = (value: unknown): string => canonicalize(JSON.parse(serializeIdentityValue(value)))!;
const locator = Symbol('identity-source-consumer-custody-locator');
type LocalProof = IdentitySourceConsumerCustody &
  Readonly<{
    [locator]: Readonly<{
      source: IdentityNativeReceipt;
      reversal: AccountIdentityReversalSettlement | null;
    }>;
  }>;

function valid(reference: IdentitySourceConsumerReference): boolean {
  const { receipt, source, barrier } = reference;
  const accountRoute = routeOf(receipt.account);
  return (
    (receipt.kind === 'account-agent.verify' || receipt.kind === 'account-agent.unverify') &&
    uuid.test(receipt.account) &&
    uuid.test(receipt.receipt) &&
    accountRoute !== null &&
    source.partition === partitionOf(accountRoute) &&
    uuid.test(source.transactionId) &&
    Number.isSafeInteger(source.epoch) &&
    source.epoch > 0 &&
    source.epoch <= 2147483647 &&
    typeof source.position === 'bigint' &&
    source.position > 0n &&
    source.position <= 9223372036854775807n &&
    digest.test(reference.sourceDigest) &&
    uuid.test(reference.job.jobId) &&
    routeOf(reference.job.jobId) !== null &&
    typeof reference.job.epoch === 'bigint' &&
    reference.job.epoch > 0n &&
    reference.job.epoch <= 9223372036854775807n &&
    uuid.test(barrier.accountId) &&
    routeOf(barrier.accountId) === barrier.accountRoute &&
    Number.isSafeInteger(barrier.version) &&
    barrier.version > 0 &&
    barrier.version <= 2147483647 &&
    Number.isFinite(Date.parse(barrier.at)) &&
    ['subject', 'requester', 'decider'].includes(reference.erasedRole) &&
    (reference.erasedRole !== 'subject' || barrier.accountId === receipt.account)
  );
}

function sameSource(reference: IdentitySourceConsumerReference, source: AccountIdentitySource): boolean {
  const role = { subject: 'subject', requester: 'actor', decider: 'editor' }[reference.erasedRole];
  return (
    json(source.input.receipt) === json(reference.receipt) &&
    source.partition === reference.source.partition &&
    source.epoch === reference.source.epoch &&
    source.position === reference.source.position &&
    source.transactionId === reference.source.transactionId &&
    source.digest === reference.sourceDigest &&
    source.roles.some((entry) => entry.account_id === reference.barrier.accountId && entry.role === role)
  );
}

/** Resolve only already accepted native inputs. Verification uses the undo-only Accounts port
 * after T; reversal resolves ITS OWN accepted claim, never intent.undoJob. Each command releases
 * its home before the next probe. No admission is performed to repair a missing hint.
 */
async function original(pool: Pool, reference: IdentitySourceConsumerReference, deadline: number) {
  if (isPrepaidIdentitySourceConsumerMaintenance(pool)) {
    claimIdentitySourceScheduledCall(pool, 'original');
    throw new IdentitySourceOriginalUnavailable('identity-source-original-Account-reader-declaration-missing');
  }
  let source: AccountIdentitySource;
  if (reference.receipt.kind === 'account-agent.verify') {
    const undo = await readAccountIdentityUndo(pool, reference.receipt);
    if (undo.job.jobId !== reference.job.jobId || undo.job.epoch !== reference.job.epoch) return null;
    source = undo.source;
  } else {
    source = (
      await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) =>
        noEffect(await readAccountIdentitySource(tx, reference.receipt)),
      )
    ).value;
    if (!sameSource(reference, source)) return null;
    const binding = await lookupIdentityBinding(pool, { deadline }, source.input);
    if (!binding) return null;
    const data = identityBindingData(binding);
    if (
      data.state !== 'accepted' ||
      data.key !== identityReceiptKey(reference.receipt) ||
      data.digest !== reference.sourceDigest ||
      data.job.jobId !== reference.job.jobId ||
      data.job.epoch !== reference.job.epoch ||
      data.home !== identityJobPartition(reference.job)
    )
      return null;
  }
  return sameSource(reference, source) ? source : null;
}

async function acceptedClaim(tx: CommandTransaction, reference: IdentitySourceConsumerReference) {
  if (currentCommand(tx).partition !== reference.source.partition) return null;
  const prepaid = isPrepaidIdentitySourceConsumerMaintenance(currentCommandResources(tx).pool);
  const row = (
    await sourceQuery<{
      generation: string;
      scope_digest: string;
      binding_transaction_id: string;
      job_home: number;
      sources: unknown;
      receipt: unknown;
      intent: unknown;
    }>(tx, prepaid ? selectedClaimSQL : claim.sql, [
      reference.source.partition,
      identityReceiptKey(reference.receipt),
      reference.sourceDigest,
      reference.job.jobId,
      reference.job.epoch.toString(),
      ...(prepaid ? [json(reference.receipt)] : []),
    ])
  ).rows[0];
  return row && row.job_home === identityJobPartition(reference.job) && (prepaid || json(row.receipt) === json(reference.receipt))
    ? row
    : null;
}

/** Publication is only a prerequisite. Reconcile ALL three fixed native receipts through
 * their real producer; a saved complete flag or coordinator return cannot replace this step.
 */
async function published(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  scope: string,
  source: AccountIdentitySource,
  deadline: number,
): Promise<boolean> {
  const home = identityJobPartition(reference.job);
  if (isPrepaidIdentitySourceConsumerMaintenance(pool)) {
    const native = (await sourceNoEffectCommand(pool, home, deadline, 'published', async (tx) =>
      (await sourceQuery<{ scope_digest: string }>(tx, selectedPublishedSQL,
        [home, reference.job.jobId, reference.job.epoch.toString()])).rows[0])).value;
    if (native?.scope_digest !== scope) return false;
    throw new IdentitySourceOriginalUnavailable('identity-source-published-native-job-and-participant-declarations-missing');
  }
  const read = () =>
    runCommand(pool, { partition: home, deadline }, async (tx) => {
      const saved = await identityEpochStore.readJob(tx, reference.job);
      const native = (
        await tx.query<{ scope_digest: string }>(job.sql, [home, reference.job.jobId, reference.job.epoch.toString()])
      ).rows[0];
      return noEffect(
        saved &&
          native?.scope_digest === scope &&
          json(saved.receipt) === json(reference.receipt) &&
          json(saved.intent) === json(source.input.intent)
          ? saved
          : null,
      );
    });
  const saved = (await read()).value;
  if (!saved || saved.state !== 'published') return false;
  for (const [step, progress] of [
    ['mapping', saved.mapping],
    ['search-canonical-index', saved.participants['search-canonical-index']],
    ['library-private-follow-counts', saved.participants['library-private-follow-counts']],
  ] as const) {
    if (
      !progress ||
      progress.state !== 'complete' ||
      progress.job.jobId !== reference.job.jobId ||
      progress.job.epoch !== reference.job.epoch ||
      progress.receipt.step !== step ||
      progress.receipt.job.jobId !== reference.job.jobId ||
      progress.receipt.job.epoch !== reference.job.epoch
    )
      return false;
    const reconciled = await identityEpochStore.reconcileStepReceipt(pool, progress.receipt);
    if (reconciled.state !== 'complete' || json(reconciled) !== json(progress)) return false;
  }
  return (await read()).value?.state === 'published';
}

/** Prepare retained native custody, then advance one exhaustive consumer-cut step. Missing
 * native fences or technical receiving authority leave the original bytes retained. */
export async function readIdentitySourceConsumerCustody(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  context: IdentitySourceConsumerContext,
): Promise<IdentitySourceConsumerCustody | null> {
  const funded = context.identityConsumerWork;
  if (!funded || !isLiveIdentitySourceConsumerMaintenance(pool, funded, context.deadline)) return null;
  if (!valid(reference) || !Number.isFinite(context.deadline) || context.deadline <= Date.now()) return null;
  // Fixed Source admission, original-source/claim/job and participant probes, progress,
  // terminal and cleanup commands are reserved before this callback's first checkout.
  if (
    !isPrepaidIdentitySourceConsumerMaintenance(pool) && !reserveIdentitySourceConsumerNativeWork(pool, funded, {
      rows: 32,
      points: 32,
      statements: 29,
      bytes: 32768,
      engineRequests: 0,
    })
  )
    return null;
  if (!claimIdentitySourceCustodyAdvancement(pool, funded, context.deadline, reference.barrier)) return null;
  reference = Object.freeze({
    ...reference,
    receipt: Object.freeze({ ...reference.receipt }),
    job: Object.freeze({ ...reference.job }),
    source: Object.freeze({ ...reference.source }),
    barrier: Object.freeze({ ...reference.barrier }),
  });
  return withRequestDeadline(context.deadline, async () => {
    try {
      // A genuine transferred source remains readable after Accounts minimizes its original
      // bytes. Resolve terminal native custody before asking the old-source/undo reader.
      const committedRow = (
        await sourceNoEffectCommand(pool, reference.source.partition, context.deadline, 'retainedDiscovery', async (tx) => {
          const retained = (await sourceQuery<Retained>(tx, select.sql, referenceValues(reference))).rows[0];
          if (!retained) return null;
          const row = await latest(tx, retained);
          return row && terminal(row.state) ? row : null;
        })
      ).value;
      if (committedRow) return await verifiedTerminal(pool, reference, committedRow, context.deadline, funded);
      const source = await original(pool, reference, context.deadline);
      if (!source) return null;
      const binding = (
        await sourceNoEffectCommand(pool, reference.source.partition, context.deadline, 'acceptedBinding',
          (tx) => acceptedClaim(tx, reference))
      ).value;
      if (!binding || (!isPrepaidIdentitySourceConsumerMaintenance(pool) &&
          json(binding.intent) !== json(source.input.intent))) return null;
      if (!(await published(pool, reference, binding.scope_digest, source, context.deadline))) return null;

      // Every foreign Source/receiver/control checkout has been released. Re-resolve the native
      // claim, source and current owner in this single original-home command. Retention alone
      // grants no cleanup, and does not assert that released foreign observations stay current.
      requireWiderSourceCommand(pool, 'prepare');
      const retained = await runCommand(
        pool,
        { partition: reference.source.partition, deadline: context.deadline },
        async (tx) => {
          const current = await acceptedClaim(tx, reference);
          if (
            !current ||
            current.generation !== binding.generation ||
            current.binding_transaction_id !== binding.binding_transaction_id ||
            current.scope_digest !== binding.scope_digest ||
            json(current.sources) !== json(binding.sources)
          )
            return noEffect(null);
          const live = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
          const owner = await readPartition(tx, reference.source.partition);
          if (!sameSource(reference, live) || !owner || owner.writeState !== 'active') return noEffect(null);
          const values = referenceValues(reference);
          const existing = (await tx.query<Retained>(select.sql, values)).rows[0];
          if (existing) return noEffect(existing);
          bindSemanticProducerRoles(tx, live.roles);
          registerCommandCallback(tx, async (transactionId) => {
            await recordSemanticSourceCommit(tx, transactionId);
            await tx.query(insert.sql, [
              ...values,
              current.generation,
              current.binding_transaction_id,
              current.scope_digest,
              owner.epoch,
              transactionId,
            ]);
          });
          return {
            value: null,
            events: [
              {
                type: SEMANTIC_ERASURE_PROGRESS,
                subject: reference.barrier.accountId,
                data: { accountId: reference.barrier.accountId },
              },
            ],
          };
        },
      );
      // A newly inserted retained receipt is deliberately not used before its native commit.
      // No foreign home is held while the bounded consumer continuation runs.
      const saved =
        retained.value ??
        (
          await sourceNoEffectCommand(pool, reference.source.partition, context.deadline, 'retainedFallback', async (tx) =>
            (await sourceQuery<Retained>(tx, select.sql, referenceValues(reference))).rows[0] ?? null)
        ).value;
      return saved ? await advanceConsumers(pool, reference, saved, source.roles, context.deadline, funded) : null;
    } catch (error) {
      if (error instanceof IdentitySourceOriginalUnavailable) return null;
      if (
        error instanceof IdentityEpochStoreError &&
        ['identity_epoch_unavailable', 'identity_effect_stale', 'identity_step_receipt_invalid'].includes(error.code)
      )
        return null;
      throw error;
    }
  });
}

function referenceValues(reference: IdentitySourceConsumerReference): unknown[] {
  const { source, receipt, job, barrier } = reference;
  return [
    source.partition,
    identityReceiptKey(receipt),
    reference.sourceDigest,
    source.epoch,
    source.position.toString(),
    source.transactionId,
    job.jobId,
    job.epoch.toString(),
    barrier.accountId,
    barrier.accountRoute,
    barrier.version,
    barrier.at,
    reference.erasedRole,
  ];
}

type Retained = {
  erasure_key: string;
  binding_generation: string;
  transaction_id: string;
  owner_epoch: number;
  position: string;
};
type Progress = {
  sequence: string;
  state: 'scope' | 'directory' | IdentitySourceConsumerDisposition;
  directory_after: IdentityFrontier | null;
  ticket_key: string | null;
  effect_after: LibraryExpectedEffectAfter | null;
  seal_digest: string | null;
  replay_generation: string;
  undo_generation: string;
  restore_generation: string;
  transaction_id: string;
  owner_epoch: number;
  position: string;
  native_current: boolean;
  receiving_partition: number | null;
  receiving_epoch: number | null;
  receiving_position: string | null;
  receiving_transaction_id: string | null;
};
const hash = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
const terminal = (state: Progress['state']): state is IdentitySourceConsumerDisposition =>
  state === 'discharged' || state === 'transferred';
const generations = (row: Progress): IdentitySourceConsumerGeneration => ({
  replayGeneration: row.replay_generation,
  undoGeneration: row.undo_generation,
  restoreGeneration: row.restore_generation,
});
const sameGeneration = (a: IdentitySourceConsumerGeneration, b: IdentitySourceConsumerGeneration) =>
  a.replayGeneration === b.replayGeneration &&
  a.undoGeneration === b.undoGeneration &&
  a.restoreGeneration === b.restoreGeneration;
const validGeneration = (value: IdentitySourceConsumerGeneration) =>
  [value.replayGeneration, value.undoGeneration, value.restoreGeneration].every(
    (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n,
  );
function boundedFrontier(value: IdentityFrontier): boolean {
  return (
    Number.isSafeInteger(value.segment) &&
    value.segment >= 0 &&
    value.after.length <= 8 &&
    value.after.every(
      (v) => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v)),
    ) &&
    Buffer.byteLength(json(value)) <= 2048
  );
}
function nativeProof(
  reference: IdentitySourceConsumerReference,
  row: Progress,
  reversal: AccountIdentityReversalSettlement | null = null,
): IdentitySourceConsumerCustody {
  return Object.freeze({
    [locator]: Object.freeze({
      source: Object.freeze({
        partition: reference.source.partition,
        epoch: row.owner_epoch,
        position: BigInt(row.position),
        transactionId: row.transaction_id,
      }),
      reversal,
    }),
  }) as LocalProof;
}
async function verifiedTerminal(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  row: Progress,
  deadline: number,
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork,
): Promise<IdentitySourceConsumerCustody | null> {
  let reversal: AccountIdentityReversalSettlement | null = null;
  if (row.state === 'discharged') {
    if (isPrepaidIdentitySourceConsumerMaintenance(pool))
      throw new IdentitySourceOriginalUnavailable('identity-source-Account-reversal-settlement-declaration-missing');
    if (reference.erasedRole !== 'subject') return null;
    reversal =
      (await (
        await owners()
      ).technical.readAccountIdentityReversalSettlement?.(pool, reference, {
        deadline,
        identityConsumerWork,
      })) ?? null;
    if (!reversal) return null;
  }
  const proof = nativeProof(reference, row, reversal);
  return (
    await withIdentitySourceNoEffectCommand(pool, deadline, () =>
      runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) =>
        noEffect((await verifyIdentitySourceConsumerCustody(tx, reference, proof)) ? proof : null),
      ))
  ).value;
}
async function owners() {
  // Only exact original modules are consulted. Missing additive exports fail pending, with
  // their complete native requirements published in the owner contract. No replacement producer.
  const binding = (await import('./identity-epoch-binding.ts')) as Partial<BindingConsumerOwner>;
  const scope = (await import('./identity-scoped-observations.ts')) as Partial<ScopedConsumerOwner>;
  const technical = (await import('../access/agent-verification-identity.ts')) as Partial<TechnicalConsumerOwner>;
  return { binding, scope, technical };
}
async function latest(tx: CommandTransaction, retained: Retained): Promise<Progress | null> {
  const row =
    (await sourceQuery<Progress>(tx, progressSQL.sql, [currentCommand(tx).partition, retained.erasure_key])).rows[0] ?? null;
  if (row && !row.native_current)
    throw new IdentityEpochStoreError(
      'identity_epoch_unavailable',
      'Consumer continuation lost current native provenance',
    );
  return row;
}

/** Native and Library accounting remain separate; no conversion between units.
 * The binding owner's planning ceiling bounds both children; their ReadWork counters
 * charge the same live Source frame before dispatch, without another allocation. */
class DirectoryWork {
  private readonly remaining: { -readonly [K in keyof NativeStepWork]: number };
  constructor(allowance: NativeStepWork) {
    this.remaining = { ...identitySourceConsumerDirectoryPlan(allowance).envelope };
    if (Object.values(this.remaining).some((v) => !Number.isSafeInteger(v) || v < 0))
      throw new TypeError('Invalid admitted consumer work');
  }
  reserve(): NativeStepWork | null {
    // The read's opaque cut saves this allowance for its independent verify. Reserve BOTH
    // calls before either dispatch; failed/unavailable work is never refunded for reuse.
    const allowance = identitySourceConsumerDirectoryPlan(this.remaining).child;
    if (allowance.rows < 1 || allowance.points < 1 || allowance.statements < 1) return null;
    for (const k of Object.keys(this.remaining) as (keyof NativeStepWork)[]) this.remaining[k] -= allowance[k] * 2;
    return allowance;
  }
}
function matchesReceiving(
  ticket: IdentityPrearmTicketData,
  selection: IdentityReceivingSelection,
  record: IdentityReceivingRecord,
): boolean {
  if (ticket.scope.source.kind !== 'library' || ticket.scope.source.identity.scope === 'public_output') return false;
  const identity = ticket.scope.source.identity;
  const { effectKey: _effect, receivingEpoch: _epoch, ...source } = identity;
  const { effectKey: _recordEffect, receivingEpoch: _recordEpoch, ...received } = record.source.native.identity;
  return (
    json(selection.job) === json(ticket.locator.job) &&
    json(record.job) === json(selection.job) &&
    selection.sourceId === identity.collectionId &&
    selection.owner === identity.collectionId &&
    selection.scope === ticket.scope.scopeId &&
    record.original === selection.original &&
    record.effectKey === selection.effectKey &&
    record.owner === selection.owner &&
    record.source.id === selection.sourceId &&
    record.source.scope === selection.scope &&
    record.source.disposition === selection.disposition &&
    record.step === 'library-private-follow-counts' &&
    record.version === 1 &&
    record.source.incarnation === identity.incarnation &&
    record.source.generation === identity.generation &&
    json(source) === json(received) &&
    !!selection.capture &&
    json(selection.capture.identity) === json(record.source.native.identity) &&
    selection.capture.frontier.captureId === record.source.native.captureId &&
    record.source.native.captureId === ticket.captureId &&
    record.applied !== null
  );
}

type Next = Readonly<{
  state: Progress['state'];
  directory: IdentityFrontier | null;
  ticket: string | null;
  after: LibraryExpectedEffectAfter | null;
  seal: LibraryScopeEffectSeal | null;
  fence: IdentityNativeReceipt | null;
}>;
async function checkpoint(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  retained: Retained,
  previous: Progress | null,
  generation: IdentitySourceConsumerGeneration,
  next: Next,
  roles: AccountIdentitySource['roles'],
  deadline: number,
): Promise<boolean> {
  requireWiderSourceCommand(pool, 'checkpoint');
  if (
    (next.directory && !boundedFrontier(next.directory)) ||
    (next.directory?.after.length ?? 0) + (next.directory ? 1 : 0) + (next.after ? 2 : 0) > 8 ||
    Buffer.byteLength(json([next.directory, next.after])) > 2048
  )
    return false;
  return (
    await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) => {
      const claim = await acceptedClaim(tx, reference);
      if (!claim || claim.generation !== retained.binding_generation) return noEffect(false);
      const current = await latest(tx, retained);
      if ((current?.sequence ?? null) !== (previous?.sequence ?? null) || (current && terminal(current.state)))
        return noEffect(false);
      const owner = await readPartition(tx, reference.source.partition);
      const source = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
      if (!owner || owner.writeState !== 'active' || !sameSource(reference, source)) return noEffect(false);
      bindSemanticProducerRoles(tx, roles);
      registerCommandCallback(tx, async (transactionId) => {
        await recordSemanticSourceCommit(tx, transactionId);
        await tx.query(appendSQL.sql, [
          reference.source.partition,
          retained.erasure_key,
          (BigInt(previous?.sequence ?? '0') + 1n).toString(),
          previous?.sequence ?? null,
          next.state,
          next.directory ? json(next.directory) : null,
          next.ticket,
          next.after ? json(next.after) : null,
          next.seal ? hash(next.seal) : null,
          next.fence?.partition ?? null,
          next.fence?.epoch ?? null,
          next.fence?.position.toString() ?? null,
          next.fence?.transactionId ?? null,
          generation.replayGeneration,
          generation.undoGeneration,
          generation.restoreGeneration,
          owner.epoch,
          transactionId,
          null,
          null,
          null,
          null,
        ]);
      });
      return {
        value: true,
        events: [
          {
            type: SEMANTIC_ERASURE_PROGRESS,
            subject: reference.barrier.accountId,
            data: { accountId: reference.barrier.accountId },
          },
        ],
      };
    })
  ).value;
}

/** One retained directory page and one native effect page per call. The saved cursor can
 * advance only after each exact scope has a durable later-writer fence, including sealed zero. */
async function advanceConsumers(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  retained: Retained,
  roles: AccountIdentitySource['roles'],
  deadline: number,
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork,
): Promise<IdentitySourceConsumerCustody | null> {
  const ports = await owners();
  const saved = (await sourceNoEffectCommand(pool, reference.source.partition, deadline, 'progress',
    (tx) => latest(tx, retained))).value;
  if (saved && terminal(saved.state)) {
    return verifiedTerminal(pool, reference, saved, deadline, identityConsumerWork);
  }
  if (isPrepaidIdentitySourceConsumerMaintenance(pool))
    throw new IdentitySourceOriginalUnavailable('identity-source-binding-consumer-eight-axis-declaration-missing');
  const work = await ports.binding.readIdentitySourceConsumerWork?.(pool, reference, {
    deadline,
    identityConsumerWork,
  });
  if (!work || !validGeneration(work)) return null;
  const previous = saved && sameGeneration(generations(saved), work) ? saved : null;
  const allowance = new DirectoryWork(work.allowance).reserve();
  if (!allowance) return null;
  claimIdentitySourceScheduledCall(pool, 'directory');
  const directory = await readIdentityPrearmCustodyPage(
    pool,
    { job: reference.job, after: previous?.directory_after ?? null, limit: 1, allowance },
    { deadline, identityConsumerWork },
  );
  if (directory.status === 'unavailable') {
    // Native directory continuations are process-authenticated locators. A restart may
    // invalidate their MAC; restart enumeration without reusing any checked scope prefix.
    if (directory.reason === 'invalid-frontier' && previous?.directory_after)
      await checkpoint(
        pool,
        reference,
        retained,
        saved,
        work,
        { state: 'directory', directory: null, ticket: null, after: null, seal: null, fence: null },
        roles,
        deadline,
      );
    return null;
  }
  if (!boundedFrontier(directory.frontier) || directory.tickets.length > 1) return null;
  if (previous?.directory_after && json(directory.frontier) === json(previous.directory_after)) return null;
  const ticket = directory.tickets[0];
  if (ticket) {
    if (
      json(ticket.locator.job) !== json(reference.job) ||
      ticket.scope.source.kind !== 'library' ||
      ticket.scope.source.identity.scope === 'public_output'
    )
      return null;
    const reservation = await ports.scope.readIdentityScopeConsumerWork?.(pool, ticket, {
      deadline,
      identityConsumerWork,
    });
    if (!reservation || !ports.scope.retainIdentityScopeConsumerFence) return null;
    const key = { job: reference.job, sourceIdentity: ticket.scope.source.identity, scope: ticket.scope.scopeId };
    return withIdentitySourceConsumerLibraryRemainder(
      pool,
      identityConsumerWork,
      deadline,
      reservation.allowance,
      (budget) => {
        const prepaid = isPrepaidIdentitySourceConsumerMaintenance(pool);
        const observe = <T>(body: () => Promise<T>, tx?: CommandTransaction) =>
          requireNativeCollectionFootprint(pool, budget, reservation.footprint, () =>
            instrumentNativeCollectionWork(pool, budget, reservation.footprint, body, tx));
        const advance = async () => {
          const ticketKey = hash(ticket);
          const prior = previous?.state === 'scope' && previous.ticket_key === ticketKey ? previous : null;
          const readPage = (allowance: WorkAllowance) => readLibraryScopeEffectsPage(pool, {
            ...key, after: prior?.effect_after ?? null, limit: 1, allowance, deadline,
          });
          // The authentic original already owns one Library object. Its producer must
          // dispatch on that SAME ledger, observed here, rather than transfer it to a
          // fresh per-page ledger. Independent producers retain their existing ABI.
          const page = prepaid ? await readIdentitySourcePrepaidLibraryPage(pool,
            { deadline, identityConsumerWork }, {
              ...key, after: prior?.effect_after ?? null, limit: 1, allowance: reservation.allowance, deadline,
            }) : await budget.compose(readPage);
          if (prepaid && page.status === 'sealed') {
            const receipt = budget.receipt();
            if (page.work.reservationId !== receipt.reservationId ||
                (Object.keys(receipt.used) as (keyof WorkDimensions)[]).some((axis) =>
                  page.work.used[axis] !== receipt.used[axis])) return null;
          }
          if (
            page.status !== 'sealed' ||
            page.rows.length > 1 ||
            json(page.seal.key) !== json(key) ||
            !boundedFrontier(page.seal.frontier) ||
            !page.seal.generation ||
            !page.seal.version ||
            (!page.exhausted && (!page.after || json(page.after) === json(prior?.effect_after ?? null)))
          )
            return null;
          if (prior?.seal_digest && prior.seal_digest !== hash(page.seal)) {
            // A changed seal restarts this scope, never reuses its previously checked prefix.
            await checkpoint(
              pool,
              reference,
              retained,
              saved,
              work,
              {
                state: 'scope',
                directory: previous?.directory_after ?? null,
                ticket: ticketKey,
                after: null,
                seal: null,
                fence: null,
              },
              roles,
              deadline,
            );
            return null;
          }
          const receiveCurrent = async () => {
              for (const selection of page.rows) {
                claimIdentitySourceScheduledCall(pool, 'receivingSelection');
                if (prepaid) throw new IdentitySourceOriginalUnavailable(
                  'identity-source-receiving-selection-native-hold-declaration-missing');
                const record = await readIdentityReceivingSelection(pool, selection, { deadline });
                if (!record || !matchesReceiving(ticket, selection, record) || !record.applied) return null;
                claimIdentitySourceScheduledCall(pool, 'receivingReconcile');
                const applied = await reconcileIdentityReceivingEffect(pool, {
                  kind: 'receiving',
                  job: reference.job,
                  original: selection.original,
                  effectKey: selection.effectKey,
                  receipt: record.receipt,
                });
                if (json(applied) !== json(record.applied.receipt)) return null;
              }
              // No foreign read under this local Source command. Revalidate the SAME seal even
              // for intermediate pages, then pin the complete cut before releasing this home.
              const receive = () => runCommand<{ fence: IdentityNativeReceipt | null } | null>(
                pool,
                { partition: identityScopeAddress(ticket.scope).partition, deadline },
                async (tx) => {
                  claimIdentitySourceLibraryCall(pool, 'currentVerifications');
                  const verify = () => verifyLibraryScopeEffectsSeal(tx, key, page.seal);
                  if (!(await (prepaid ? observe(verify, tx) : verify()))) return noEffect(null);
                  if (!page.exhausted) return noEffect({ fence: null });
                  const fence = await ports.scope.retainIdentityScopeConsumerFence!(tx, ticket, page.seal);
                  if (!fence) return noEffect(null);
                  return {
                    value: { fence },
                    events: [
                      {
                        type: SEMANTIC_ERASURE_PROGRESS,
                        subject: reference.barrier.accountId,
                        data: { accountId: reference.barrier.accountId },
                      },
                    ],
                  };
                },
              );
              // An exhausted page retains both current checks in this SAME
              // transaction and preserves its genuine progress event.
              if (prepaid) {
                claimIdentitySourceScheduledCall(pool, 'receivingCommand');
                return page.exhausted
                  ? withIdentitySourceFenceCommand(pool, deadline, reference.barrier.accountId, receive)
                  : withIdentitySourceNoEffectCommand(pool, deadline, receive);
              }
              return receive();
          };
          const current = await receiveCurrent();
          if (!current?.value) return null;
          const fence = current.value.fence;
          if (
            page.exhausted &&
            (!fence ||
              fence.partition !== current.partition ||
              fence.epoch !== current.epoch ||
              fence.position <= 0n ||
              fence.position > current.position ||
              (fence.transactionId === current.transactionId && fence.position !== current.position))
          )
            return null;
          if (!page.exhausted) {
            await checkpoint(
              pool,
              reference,
              retained,
              saved,
              work,
              {
                state: 'scope',
                directory: previous?.directory_after ?? null,
                ticket: ticketKey,
                after: page.after,
                seal: page.seal,
                fence: null,
              },
              roles,
              deadline,
            );
            return null;
          }
          if (directory.status !== 'complete') {
            await checkpoint(
              pool,
              reference,
              retained,
              saved,
              work,
              {
                state: 'directory',
                directory: directory.frontier,
                ticket: ticketKey,
                after: null,
                seal: page.seal,
                fence,
              },
              roles,
              deadline,
            );
            return null;
          }
          // The last real scope fence is recorded before terminal transition, in the same final
          // source command below. No opaque directory cut or in-process Library brand is persisted.
          return finishConsumers(
            pool,
            reference,
            retained,
            saved,
            work,
            directory,
            ports,
            { state: 'directory', directory: directory.frontier, ticket: ticketKey, after: null, seal: page.seal, fence },
            roles,
            deadline,
            identityConsumerWork,
          );
        };
        // The Core adapter owns its real controls on Source's native partition.
        // Only Library bodies run under the Library observer on the prepaid path.
        return prepaid ? advance() : observe(advance);
      },
    );
  }
  if (directory.status !== 'complete') {
    if (json(directory.frontier) === json(previous?.directory_after ?? null)) return null;
    await checkpoint(
      pool,
      reference,
      retained,
      saved,
      work,
      { state: 'directory', directory: directory.frontier, ticket: null, after: null, seal: null, fence: null },
      roles,
      deadline,
    );
    return null;
  }
  return finishConsumers(
    pool,
    reference,
    retained,
    saved,
    work,
    directory,
    ports,
    { state: 'directory', directory: directory.frontier, ticket: null, after: null, seal: null, fence: null },
    roles,
    deadline,
    identityConsumerWork,
  );
}

type CompleteDirectory = Extract<Awaited<ReturnType<typeof readIdentityPrearmCustodyPage>>, { status: 'complete' }>;
async function finishConsumers(
  pool: Pool,
  reference: IdentitySourceConsumerReference,
  retained: Retained,
  previous: Progress | null,
  generation: IdentitySourceConsumerGeneration,
  directory: CompleteDirectory,
  ports: Awaited<ReturnType<typeof owners>>,
  next: Next,
  roles: AccountIdentitySource['roles'],
  deadline: number,
  identityConsumerWork: IdentitySourceConsumerMaintenanceWork,
): Promise<IdentitySourceConsumerCustody | null> {
  requireWiderSourceCommand(pool, 'finish');
  if (!ports.binding.lockIdentitySourceConsumerCut || !ports.binding.verifyIdentitySourceConsumerCut) return null;
  let reversal: AccountIdentityReversalSettlement | null = null;
  if (reference.erasedRole === 'subject') {
    reversal =
      (await ports.technical.readAccountIdentityReversalSettlement?.(pool, reference, {
        deadline,
        identityConsumerWork,
      })) ?? null;
    if (!reversal) return null;
  }
  if (
    (await verifyIdentityPrearmCustodyCut(pool, reference.job, directory.cut, { deadline, identityConsumerWork }))
      .status !== 'current'
  )
    return null;
  // Last foreign probe is released. The local binding lock also belongs to every later
  // original-source admission/replay/undo/restore consumer, as required of the owner hook.
  const result = await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) => {
    const claim = await acceptedClaim(tx, reference);
    const saved = await latest(tx, retained);
    if (
      !claim ||
      claim.generation !== retained.binding_generation ||
      (saved?.sequence ?? null) !== (previous?.sequence ?? null)
    )
      return noEffect(false);
    const owner = await readPartition(tx, reference.source.partition);
    const source = await readAccountIdentitySource(tx, reference.receipt, undefined, true);
    if (!owner || owner.writeState !== 'active' || !sameSource(reference, source)) return noEffect(false);
    const disposition = await ports.binding.lockIdentitySourceConsumerCut!(
      tx,
      reference,
      generation,
      reversal ?? undefined,
    );
    if (
      !disposition ||
      (reference.erasedRole === 'subject' && disposition !== 'discharged') ||
      (reference.receipt.kind === 'account-agent.verify' &&
        reference.erasedRole !== 'subject' &&
        disposition !== 'transferred')
    )
      return noEffect(false);
    let receiving: IdentityNativeReceipt | null = null;
    if (disposition === 'transferred') {
      if (
        !ports.technical.acceptAccountIdentityTechnicalSource ||
        !ports.technical.verifyAccountIdentityTechnicalSource
      )
        return noEffect(false);
      receiving = await ports.technical.acceptAccountIdentityTechnicalSource(tx, reference);
      if (!receiving) return noEffect(false);
      if (
        receiving.partition !== reference.source.partition ||
        receiving.epoch !== owner.epoch ||
        receiving.position <= 0n ||
        !uuid.test(receiving.transactionId) ||
        !(await ports.technical.verifyAccountIdentityTechnicalSource(tx, reference, receiving))
      )
        throw new IdentityEpochStoreError('identity_effect_stale', 'Technical source acceptance lost native custody');
    }
    if (
      !(await ports.binding.verifyIdentitySourceConsumerCut!(
        tx,
        reference,
        generation,
        disposition,
        reversal ?? undefined,
      ))
    )
      throw new IdentityEpochStoreError('identity_effect_stale', 'Original consumer fence changed during transfer');
    bindSemanticProducerRoles(tx, roles);
    registerCommandCallback(tx, async (transactionId) => {
      await recordSemanticSourceCommit(tx, transactionId);
      await tx.query(appendSQL.sql, [
        reference.source.partition,
        retained.erasure_key,
        (BigInt(previous?.sequence ?? '0') + 1n).toString(),
        previous?.sequence ?? null,
        disposition,
        json(directory.frontier),
        next.ticket,
        null,
        next.seal ? hash(next.seal) : null,
        next.fence?.partition ?? null,
        next.fence?.epoch ?? null,
        next.fence?.position.toString() ?? null,
        next.fence?.transactionId ?? null,
        generation.replayGeneration,
        generation.undoGeneration,
        generation.restoreGeneration,
        owner.epoch,
        transactionId,
        receiving?.partition ?? null,
        receiving?.epoch ?? null,
        receiving?.position.toString() ?? null,
        receiving?.transactionId ?? null,
      ]);
    });
    return {
      value: true,
      events: [
        {
          type: SEMANTIC_ERASURE_PROGRESS,
          subject: reference.barrier.accountId,
          data: { accountId: reference.barrier.accountId },
        },
      ],
    };
  });
  if (!result.value) return null;
  const proof = Object.freeze({
    [locator]: Object.freeze({
      source: Object.freeze({
        partition: result.partition,
        epoch: result.epoch,
        position: result.position,
        transactionId: result.transactionId,
      }),
      reversal,
    }),
  }) as LocalProof;
  // Re-enter only this home after commit. The brand cannot replace durable live revalidation.
  return (
    await runCommand(pool, { partition: reference.source.partition, deadline }, async (tx) =>
      noEffect(await verifyIdentitySourceConsumerCustody(tx, reference, proof)),
    )
  ).value
    ? proof
    : null;
}

/** Original 4/4/6/8192 reservation plus 96/96/16/131072 for the complete
 * nested Source verifier. Reserve here, rather than only in the History wrapper:
 * initial staging, post-commit reconstruction and independent History checks also
 * invoke this verifier. Subject Account settlement reserves separately in its owner. */
export const IDENTITY_SOURCE_CONSUMER_VERIFY_COST: NativeStepWork = Object.freeze({
  rows: 100,
  points: 100,
  statements: 22,
  bytes: 139264,
  engineRequests: 0,
});

/** Same genuine live original-home command, fixed indexed points, no foreign checkout. */
export async function verifyIdentitySourceConsumerCustody(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  proof: IdentitySourceConsumerCustody,
): Promise<boolean> {
  const resources = currentCommandResources(tx);
  const frame = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  if (
    !frame ||
    !isLiveIdentitySourceConsumerMaintenance(resources.pool, frame, resources.deadline) ||
    (!isPrepaidIdentitySourceConsumerMaintenance(resources.pool) &&
      !reserveIdentitySourceConsumerNativeWork(resources.pool, frame, IDENTITY_SOURCE_CONSUMER_VERIFY_COST))
  )
    return false;
  if (
    !valid(reference) ||
    currentCommand(tx).partition !== reference.source.partition ||
    currentCommand(tx).basis !== null ||
    resources.deadline <= Date.now()
  )
    return false;
  if (isPrepaidIdentitySourceConsumerMaintenance(resources.pool))
    claimIdentitySourceScheduledCall(resources.pool, 'terminalVerify');
  const local = (proof as LocalProof | null)?.[locator];
  const native = local?.source;
  if (!native || native.partition !== reference.source.partition) return false;
  const retained = (await sourceQuery<Retained>(tx, select.sql, referenceValues(reference))).rows[0];
  if (!retained || !(await acceptedClaim(tx, reference))) return false;
  const row = await latest(tx, retained);
  if (
    !row ||
    !terminal(row.state) ||
    row.transaction_id !== native.transactionId ||
    row.owner_epoch !== native.epoch ||
    BigInt(row.position) !== native.position ||
    !validGeneration(generations(row))
  )
    return false;
  if (
    (reference.erasedRole === 'subject' && row.state !== 'discharged') ||
    (reference.receipt.kind === 'account-agent.verify' &&
      reference.erasedRole !== 'subject' &&
      row.state !== 'transferred')
  )
    return false;
  if (isPrepaidIdentitySourceConsumerMaintenance(resources.pool)) return false; // Binding/Account child declarations are absent.
  const ports = await owners();
  if (
    !(await ports.binding.verifyIdentitySourceConsumerCut?.(
      tx,
      reference,
      generations(row),
      row.state,
      local.reversal ?? undefined,
    ))
  )
    return false;
  if (row.state !== 'transferred') return true;
  if (
    row.receiving_partition !== reference.source.partition ||
    row.receiving_epoch !== row.owner_epoch ||
    !row.receiving_position ||
    !row.receiving_transaction_id
  )
    return false;
  const receiving = {
    partition: row.receiving_partition,
    epoch: row.receiving_epoch,
    position: BigInt(row.receiving_position),
    transactionId: row.receiving_transaction_id,
  };
  return (await ports.technical.verifyAccountIdentityTechnicalSource?.(tx, reference, receiving)) === true;
}

type HistoryNativeLocator = Omit<IdentityNativeReceipt, 'position'> & Readonly<{ position: string }>;
export type IdentitySourceHistoryReference = Omit<IdentitySourceConsumerReference, 'source' | 'job'> &
  Readonly<{
    source: HistoryNativeLocator;
    job: Readonly<{ jobId: string; epoch: string }>;
  }>;

/** Persistable address of original Source authority, never a portable certificate.
 * The native consumer must resolve this SAME original row through the Source function
 * on every guarded transition, including the later receiving commit. */
export type IdentitySourceHistoryAuthority = Readonly<{
  kind: 'identity-source-history-guard/v1';
  custody: string;
  sequence: string;
  reference: IdentitySourceHistoryReference;
  generation: IdentitySourceConsumerGeneration;
  disposition: IdentitySourceConsumerDisposition;
  terminal: HistoryNativeLocator;
  receiving: HistoryNativeLocator | null;
}>;

// Closed JSON constructed by lock_identity_source_history_handoff. Its receipt
// equals the validated closed input, and every other field comes from fixed-width
// native scalars. Include the longest closed kind/disposition, all three receipts,
// bigint projections and the bounded timestamp; no saved intent is returned.
const historyAuthorityOutputBytes = scalarJSONBytes({ authority: {
  kind: 'identity-source-history-guard/v1', custody: n19, sequence: n19,
  reference: {
    receipt: { kind: 'account-agent.unverify', account: uuid36, receipt: uuid36 },
    sourceDigest: 'f'.repeat(64), erasedRole: 'requester',
    source: { partition: 4095, epoch: 2147483647, position: n19, transactionId: uuid36 },
    job: { jobId: uuid36, epoch: n19 },
    barrier: { accountId: uuid36, accountRoute: 65535, version: 2147483647, at: '9'.repeat(128) },
  },
  generation: { replayGeneration: n19, undoGeneration: n19, restoreGeneration: n19 },
  disposition: 'transferred',
  terminal: { partition: 4095, epoch: 2147483647, position: n19, transactionId: uuid36 },
  receiving: { partition: 4095, epoch: 2147483647, position: n19, transactionId: uuid36 },
} }) + 5 * 128;

/** Outer SELECT, fifteen exact native keyed inputs, and the returned native tuple.
 * There are two SQL statements: the outer SELECT and the function's joined SELECT.
 * PL/pgSQL comparisons/RETURN dispatch no SQL and this read fires no row triggers. */
export const IDENTITY_SOURCE_HISTORY_GUARD_COST: NativeStepWork = Object.freeze({
  rows: 17,
  points: 15,
  statements: 2,
  bytes: 32768,
  engineRequests: 0,
});

// History-only recheck. The Source verifier now reserves its entire native body at
// its own entry, including independent calls outside this handoff. The combined
// composition remains 377/293/57/507904/0; every repeated entry is charged again.
export const IDENTITY_SOURCE_HISTORY_RECHECK_COST: NativeStepWork = Object.freeze({
  rows: 32,
  points: 32,
  statements: 8,
  bytes: 131072,
  engineRequests: 0,
});
export const IDENTITY_SOURCE_HISTORY_RECEIVER_COST: NativeStepWork = Object.freeze({
  rows: 160,
  points: 80,
  statements: 6,
  bytes: 131072,
  engineRequests: 0,
});

export type IdentitySourceHistoryHandoff = Readonly<{
  phase: 'readiness' | 'closure';
  sourceAuthority: IdentitySourceHistoryAuthority;
  binding: AgentIdentitySDKReceivingBinding;
  writer: SdkWriterState;
}>;
export type IdentitySourceHistoryHandoffResult =
  | Readonly<{ state: 'pending'; gap: string }>
  | Readonly<{ state: 'guarded'; handoff: IdentitySourceHistoryHandoff }>;

function reserveHistoryWork(tx: CommandTransaction, cost: NativeStepWork, declaration?: WorkDimensions): boolean {
  const resources = currentCommandResources(tx);
  const frame = currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline);
  return !!frame && reserveIdentitySourceConsumerNativeWork(resources.pool, frame, cost, declaration);
}

/** Resolve durable ORIGINAL Source state, not a copied terminal receipt. This same
 * function is the supported native Source half of History's installed row guard:
 * semantic.lock_identity_source_history_handoff(reference, expectedAuthority).
 * It locks original custody, current binding/generations and native enrollment until
 * COMMIT. It does not supply Account verification, SDK closure or History readiness. */
export async function lockIdentitySourceHistoryAuthority(
  tx: CommandTransaction,
  reference: IdentitySourceConsumerReference,
  expected: IdentitySourceHistoryAuthority | null = null,
): Promise<IdentitySourceHistoryAuthority | null> {
  const prepaid = isPrepaidIdentitySourceConsumerMaintenance(currentCommandResources(tx).pool);
  if (prepaid) claimIdentitySourceScheduledCall(currentCommandResources(tx).pool, 'historyAuthority');
  const serialized = json(reference);
  const expectedJSON = expected === null ? null : json(expected);
  if (
    !valid(reference) ||
    (prepaid && (Object.keys(reference.receipt).sort().join(',') !== 'account,kind,receipt' ||
      Buffer.byteLength(reference.barrier.at) > 128)) ||
    Buffer.byteLength(serialized) > 2048 ||
    (expectedJSON !== null && Buffer.byteLength(expectedJSON) > 4096) ||
    reference.source.partition !== 0 ||
    partitionOf(reference.barrier.accountRoute) !== 0 ||
    currentCommand(tx).partition !== 0 ||
    currentCommand(tx).basis !== null ||
    !reserveHistoryWork(tx, isPrepaidIdentitySourceConsumerMaintenance(currentCommandResources(tx).pool)
      ? { ...IDENTITY_SOURCE_HISTORY_GUARD_COST,
          bytes: Buffer.byteLength(historySQL.sql) + Buffer.byteLength(json([serialized, expectedJSON])) + historyAuthorityOutputBytes }
      : IDENTITY_SOURCE_HISTORY_GUARD_COST, {
        ...IDENTITY_SOURCE_HISTORY_GUARD_DECLARATION.work,
        bytes: Buffer.byteLength(historySQL.sql) + Buffer.byteLength(json([serialized, expectedJSON])) + historyAuthorityOutputBytes,
      })
  )
    return null;
  const result = await tx.query<{ authority: IdentitySourceHistoryAuthority | null }>(historySQL.sql, [serialized, expectedJSON]);
  const resources = currentCommandResources(tx);
  if (!currentIdentitySourceConsumerMaintenance(resources.pool, resources.deadline)) return null;
  return result.rows[0]?.authority ?? null;
}

/** Exact local Source function declaration. The body has fifteen fixed native
 * inputs (including the installed trigger catalogue point), one outer result and
 * one JSON result. No candidate enumeration, basis-metadata sweep, witness expansion
 * or engine request occurs. Failed exact-key lookup reserves one empty seek.
 * SQL/parameter bytes include the 2048/4096 inputs and the closed native output
 * projection above. The independent legacy allowance is not the prepaid price. */
export const IDENTITY_SOURCE_HISTORY_GUARD_DECLARATION = Object.freeze({
  engineRequests: 0 as const,
  work: Object.freeze({
    candidateKeys: 0, nativeRows: 17, identityMetadataRows: 0, nativePoints: 15,
    witnessKeys: 0, statements: 2,
    bytes: Buffer.byteLength(historySQL.sql) + 6 * (2048 + 4096) + 7 + historyAuthorityOutputBytes,
    emptySeeks: 1,
  }),
});

/** Default owner composition on the genuine original Source command. Both phases
 * re-run native History/Source/Account verification and exact receiving admission,
 * then lock the actual SDK state on this SAME command. No foreign SQL, callbacks,
 * fresh frame, SDK retirement or History state mutation is substituted here.
 *
 * History owns persisting distinct guarded readiness/closure transitions. Its native
 * row guard must consume the Source function with the stored exact authority AND
 * its own current association, barrier, receiver and SDK prerequisites. Returning
 * this locator cannot authorize a later write by itself. */
export async function lockIdentitySourceHistoryHandoff(
  tx: CommandTransaction,
  stage: AgentIdentityRetirementStage,
  binding: AgentIdentitySDKReceivingBinding,
  expectedWriter: SdkWriterState,
  phase: 'readiness' | 'closure',
  sdk: DBOSClient,
): Promise<IdentitySourceHistoryHandoffResult> {
  const pending = (gap: string): IdentitySourceHistoryHandoffResult => ({ state: 'pending', gap });
  const reference = stage.reference;
  if (!valid(reference) || currentCommand(tx).basis !== null)
    return pending('identity-source-history-reference-changed');
  // No receiving-home read may be smuggled into a different Source command. Shared
  // PostgreSQL placement alone does not establish single-partition atomicity.
  if (
    reference.source.partition !== 0 ||
    currentCommand(tx).partition !== 0 ||
    partitionOf(reference.barrier.accountRoute) !== 0
  )
    return pending('identity-source-history-shared-home-unavailable');
  if (
    (phase !== 'readiness' && phase !== 'closure') ||
    expectedWriter.workflowID !== binding.workflowId ||
    expectedWriter.workflowID !== stage.handoff.source.workflowId ||
    (phase === 'readiness'
      ? expectedWriter.generation !== '1' || expectedWriter.closureID !== null || expectedWriter.closedAt !== null
      : expectedWriter.generation !== '2' ||
        !expectedWriter.closureID ||
        !Number.isSafeInteger(expectedWriter.closedAt) ||
        expectedWriter.closedAt! <= 0) ||
    !sameHistoryBinding(stage, binding)
  )
    return pending('identity-source-history-binding-or-writer-changed');
  // Clone data across the awaited owner calls; preserve only the actual Source proof.
  stage = { reference: structuredClone(reference), handoff: structuredClone(stage.handoff), consumer: stage.consumer };
  binding = structuredClone(binding);
  expectedWriter = structuredClone(expectedWriter);
  if (isPrepaidIdentitySourceConsumerMaintenance(currentCommandResources(tx).pool)) {
    claimIdentitySourceScheduledCall(currentCommandResources(tx).pool, 'historyHandoff');
    return pending('identity-source-History-SDK-reached-eight-axis-declarations-missing');
  }
  if (!reserveHistoryWork(tx, IDENTITY_SOURCE_HISTORY_RECHECK_COST))
    return pending('identity-source-history-funding-unavailable');
  const { verifyAgentIdentityRetirementStage } = await import('../history/agent-identity-retirement.ts');
  const source = await verifyAgentIdentityRetirementStage(tx, stage);
  if (source.state === 'pending') return source;
  if (source.custodyId !== binding.custodyId || source.workflowId !== binding.workflowId)
    return pending('identity-source-history-association-changed');
  if (!reserveHistoryWork(tx, IDENTITY_SOURCE_HISTORY_RECEIVER_COST))
    return pending('identity-source-history-funding-unavailable');
  const { readAgentIdentitySDKReceivingBinding } = await import('../history/agent-identity-sdk-fence.ts');
  const receiver = await readAgentIdentitySDKReceivingBinding(
    tx,
    {
      partition: 0,
      locator: { artifactType: 'durable-work/v1', workId: binding.custodyId },
      accounts: binding.source.accounts,
    },
    stage.reference.barrier,
  );
  if (receiver.state === 'pending') return receiver;
  if (json(receiver.binding) !== json(binding)) return pending('identity-source-history-receiver-changed');
  const sourceAuthority = await lockIdentitySourceHistoryAuthority(tx, stage.reference);
  if (!sourceAuthority) return pending('identity-source-history-native-custody-pending');
  // SDK owner cost, including its nested domain/fence locks and return SELECT.
  // Stale, pool, serialization and deadlock failures propagate: roll back the whole
  // command. Every repeated entry pre-reserves again in the SAME live frame.
  if (
    !reserveHistoryWork(tx, {
      rows: SDK_TRANSACTION_FENCE_COST.rows,
      points: SDK_TRANSACTION_FENCE_COST.points,
      statements: SDK_TRANSACTION_FENCE_COST.statements,
      bytes: SDK_TRANSACTION_FENCE_COST.bytes,
      engineRequests: SDK_TRANSACTION_FENCE_COST.engineWork,
    })
  )
    return pending('identity-source-history-funding-unavailable');
  let writer: SdkWriterState;
  try {
    writer = await lockSdkWorkflowWriterState(tx, expectedWriter, sdk);
  } catch (error) {
    if (error instanceof Error && error.message === 'DBOS writer fence requires the same native transaction pool')
      return pending('identity-source-history-sdk-pool-mismatch');
    throw error;
  }
  return { state: 'guarded', handoff: { phase, sourceAuthority, binding: receiver.binding, writer } };
}

function sameHistoryBinding(stage: AgentIdentityRetirementStage, binding: AgentIdentitySDKReceivingBinding): boolean {
  return (
    binding.custodyId === stage.handoff.custodyId &&
    binding.workflowId === stage.handoff.source.workflowId &&
    binding.receiver.partition === 0 &&
    binding.receiver.writerVersion === 1 &&
    binding.receiver.generation === stage.handoff.generation &&
    json(binding.source) === json(stage.handoff.source) &&
    json(binding.barrier) === json(stage.reference.barrier)
  );
}
