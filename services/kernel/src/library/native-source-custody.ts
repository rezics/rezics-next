import {
  nativeIdentityPartitionQuery,
  isNativeIdentitySourceBasisSQL,
  nativeIdentitySourceBasisFootprint,
} from './identity-native-planner-selected-pricing.ts';
import type { Pool, QueryResultRow } from 'pg';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  commandTime,
  currentCommand,
  currentCommandResources,
  type AuthoritativeTime,
  type CommandTransaction,
} from '../command/command.ts';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf, partitionOf } from '../route/route.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from './collection-source-work.ts';
import {
  assertLibraryIdentityResources,
  revalidateBoundLibraryIdentityWork,
  withLibraryIdentityWork,
} from './identity-native-planner-work.ts';
import type { WorkAllowance, WorkDimensions, WorkReceipt } from './collection-source.ts';

import type { NativePublicOutputIdentity } from './native-source-output-types.ts';
export type { NativeOutputActivation, NativePublicOutputIdentity } from './native-source-output-types.ts';

/** Lookup hints only. Native records, not possession of this value, establish custody. */
type AccountSourceIdentity = Readonly<
  {
    route: number;
    collectionId: string;
    accountId: string;
    incarnation: string;
    generation: string;
    ownerEpoch: number;
    receivingEpoch: string;
    effectKey: string;
  } & (
    | {
        scope: 'curated' | 'private_builtin';
        outputGeneration?: never;
        publicationTransactionId?: never;
        publicationPosition?: never;
      }
    | {
        scope: 'active_explicit_output';
        outputGeneration: string;
        publicationTransactionId: string;
        publicationPosition: string;
      }
  )
>;
export type NativeSourceIdentity = AccountSourceIdentity | NativePublicOutputIdentity;
export type NativeSourceDriver =
  | 'member'
  | 'entry'
  | 'entry_deleted'
  | 'label'
  | 'assignment'
  | 'session'
  | 'unit'
  | 'change'
  | 'copy'
  | 'output'
  | 'done';
export type NativeSourceFrontier = Readonly<{
  captureId: string;
  driver: NativeSourceDriver;
  after: string;
  tie: string;
  sessionId: string | null;
  scanned: string;
  version: number;
}>;
const captureEvidence: unique symbol = Symbol('native source capture');
export type NativeSourceCapture = Readonly<{
  [captureEvidence]: true;
  identity: NativeSourceIdentity;
  captureId: string;
  transactionId: string;
  position: string;
  scanned: string;
}>;
const custodyEvidence: unique symbol = Symbol('native source custody');
export type NativeSourceCustody = Readonly<{
  [custodyEvidence]: true;
  identity: NativeSourceIdentity;
  captureId: string;
  holdId: string;
  transactionId: string;
}>;
export type NativeSourceCaptureWork = Readonly<{ allowance: WorkAllowance; deadline: number }>;
/** Exact current owner episode, independently reread under native locks. Never an allow flag. */
export type NativeSourceRetirement = Readonly<{
  sourceGeneration: string;
  episode: { kind: 'deleted'; deletionId: string; revision: number; purgeAfter: string } | { kind: 'terminal' };
}>;
export type NativeSourceRetirementResult =
  | Unavailable
  | { status: 'blocked'; reason: 'live_hold' | 'release_uncommitted' | 'source' | 'public_custody'; work: WorkReceipt }
  | { status: 'retired' | 'progress'; removed: number; work: WorkReceipt };
export type NativeSourceDependency = Readonly<{
  driver: NativeSourceDriver;
  key: string;
  tie: string;
  subjectId: string | null;
  transactionId: string | null;
}>;
type Unavailable = {
  status: 'unavailable';
  reason: 'binding' | 'writer' | 'allowance' | 'output_authority';
  work: WorkReceipt;
};
export interface NativeLibrarySourceCustody {
  retireCapture(
    input: NativeSourceCaptureWork &
      NativeSourceRetirement & {
        client: CommandTransaction;
        at: AuthoritativeTime;
        identity: NativeSourceIdentity;
        captureId: string;
      },
  ): Promise<NativeSourceRetirementResult>;
  capturePage(
    input: NativeSourceCaptureWork & {
      identity: NativeSourceIdentity;
      frontier: NativeSourceFrontier | null;
      limit: number;
    },
  ): Promise<
    | Unavailable
    | { status: 'pending'; frontier: NativeSourceFrontier; rows: readonly NativeSourceDependency[]; work: WorkReceipt }
  >;
  finishCapture(
    input: NativeSourceCaptureWork & {
      identity: NativeSourceIdentity;
      frontier: NativeSourceFrontier;
    },
  ): Promise<
    | Unavailable
    | {
        status: 'complete';
        capture: NativeSourceCapture & Readonly<{ identity: AccountSourceIdentity }>;
        work: WorkReceipt;
      }
  >;
  /** Same live native command or admitted operational client and T; never a foreign checkout/callback. */
  readAndHold(
    input: NativeSourceCaptureWork & {
      client: CommandTransaction;
      at: AuthoritativeTime;
      identity: NativeSourceIdentity;
      captureId: string;
      holdId: string;
    },
  ): Promise<Unavailable | { status: 'held'; custody: NativeSourceCustody; work: WorkReceipt }>;
  /** Existing committed custody only; never a fresh read or a new hold. Same live command client and T. */
  revalidateHold: NativeLibrarySourceCustody['readAndHold'];
  releaseHold(
    input: NativeSourceCaptureWork & {
      client: CommandTransaction;
      at: AuthoritativeTime;
      identity: NativeSourceIdentity;
      captureId: string;
      holdId: string;
    },
  ): Promise<Unavailable | { status: 'released'; work: WorkReceipt }>;
}

import partitionQuery from './native-source-custody-partition.sql';
import sourceQuery from './native-source-custody-source.sql';
import accountQuery from './native-source-custody-account.sql';
import ensureQuery from './native-source-custody-ensure.sql';
import fencesQuery from './native-source-custody-fences.sql';
import readQuery from './native-source-custody-read.sql';
import startQuery from './native-source-custody-start.sql';
import advanceQuery from './native-source-custody-advance.sql';
import finishQuery from './native-source-custody-finish.sql';
import proofQuery from './native-source-custody-proof.sql';
import holdQuery from './native-source-custody-hold.sql';
import heldQuery from './native-source-custody-held.sql';
import retainedQuery from './native-source-custody-retained.sql';
import releaseQuery from './native-source-custody-release.sql';
import retireSource from './native-source-custody-retire-source.sql';
import retireReceipt from './native-source-custody-retire-receipt.sql';
import retireActive from './native-source-custody-retire-active.sql';
import retireHolds from './native-source-custody-retire-holds.sql';
import retireChildren from './native-source-custody-retire-children.sql';
import retireProof from './native-source-custody-retire-proof.sql';
import retireCapture from './native-source-custody-retire-capture.sql';
import nextCapture from './native-source-custody-next.sql';
import identityCapture from './identity-native-planner-source.sql';
import identityRetention from './identity-native-planner-retention.sql';
import terminalScope from './erasure-scope.sql';
import rawMember from './native-source-custody-raw-member.sql';
import rawEntry from './native-source-custody-raw-entry.sql';
import rawEntryDeleted from './native-source-custody-raw-entry_deleted.sql';
import rawLabel from './native-source-custody-raw-label.sql';
import rawAssignment from './native-source-custody-raw-assignment.sql';
import rawSession from './native-source-custody-raw-session.sql';
import rawUnit from './native-source-custody-raw-unit.sql';
import rawChange from './native-source-custody-raw-change.sql';
import rawCopy from './native-source-custody-raw-copy.sql';
import rawOutput from './native-source-custody-raw-output.sql';
import rawExplicitOutput from './native-source-custody-raw-explicit-output.sql';
import outputQuery from './native-source-custody-output.sql';

const rawQueries = {
  member: rawMember,
  entry: rawEntry,
  entry_deleted: rawEntryDeleted,
  label: rawLabel,
  assignment: rawAssignment,
  session: rawSession,
  unit: rawUnit,
  change: rawChange,
  copy: rawCopy,
  output: rawOutput,
};
const zeroId = '00000000-0000-0000-0000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Query = { sql: string; params: readonly string[] };
// Identity capture only consumes the move target's nullness. Keep that native fact
// under the same row lock without projecting an unbounded node address.
const identityPartitionQuery = nativeIdentityPartitionQuery;
type Parameters = Record<string, unknown>;
type State = NativeSourceIdentity &
  NativeSourceFrontier & { collectionFence: string; accountFence: string; complete: boolean };
type Reason = Unavailable['reason'];
class Refused extends Error {
  constructor(readonly reason: Reason) {
    super(reason);
  }
}
const identityKeys = [
  'route',
  'collectionId',
  'accountId',
  'incarnation',
  'generation',
  'scope',
  'ownerEpoch',
  'receivingEpoch',
  'effectKey',
  'outputGeneration',
  'publicationTransactionId',
  'publicationPosition',
] as const;
const frontierKeys = ['captureId', 'driver', 'after', 'tie', 'sessionId', 'scanned', 'version'] as const;
function sameIdentity(state: NativeSourceIdentity, identity: NativeSourceIdentity): boolean {
  if (state.scope === 'public_output' || identity.scope === 'public_output') return false;
  return identityKeys.every((key) => (state[key] ?? undefined) === (identity[key] ?? undefined));
}
function sameFrontier(state: NativeSourceFrontier, frontier: NativeSourceFrontier): boolean {
  return frontierKeys.every((key) => state[key] === frontier[key]);
}
function validate(identity: NativeSourceIdentity): asserts identity is AccountSourceIdentity {
  // Public output custody is supplied by its native producer, never the account predicate.
  if (identity.scope === 'public_output') throw new Refused('output_authority');
  const accountRoute = routeOf(identity.accountId);
  if (
    !uuid.test(identity.collectionId) ||
    !uuid.test(identity.accountId) ||
    routeOf(identity.collectionId) !== identity.route ||
    accountRoute === null ||
    accountRoute === undefined ||
    partitionOf(accountRoute) !== partitionOf(identity.route) ||
    !Number.isSafeInteger(identity.ownerEpoch) ||
    identity.ownerEpoch < 1 ||
    !/^(0|[1-9][0-9]{0,18})$/.test(identity.generation) ||
    !/^[1-9][0-9]{0,18}$/.test(identity.receivingEpoch) ||
    BigInt(identity.generation) > 9223372036854775807n ||
    BigInt(identity.receivingEpoch) > 9223372036854775807n ||
    !identity.incarnation ||
    Buffer.byteLength(identity.incarnation) > 128 ||
    !identity.effectKey ||
    Buffer.byteLength(identity.effectKey) > 256 ||
    !['curated', 'private_builtin', 'active_explicit_output'].includes(identity.scope)
  )
    throw new Refused('binding');
  if (identity.scope === 'active_explicit_output') {
    if (
      !uuid.test(identity.outputGeneration) ||
      !uuid.test(identity.publicationTransactionId) ||
      !/^[1-9][0-9]{0,18}$/.test(identity.publicationPosition) ||
      BigInt(identity.publicationPosition) > 9223372036854775807n
    )
      throw new Refused('binding');
  } else if (
    identity.outputGeneration != null ||
    identity.publicationTransactionId != null ||
    identity.publicationPosition != null
  ) {
    throw new Refused('binding');
  }
}
/** Structural native bind validation only; this grants no Source or original authority. */
export function validateNativeIdentitySource(identity: NativeSourceIdentity): void {
  validate(identity);
}
function parameters(identity: NativeSourceIdentity): Parameters {
  validate(identity);
  return {
    route: identity.route,
    collection_id: identity.collectionId,
    account_id: identity.accountId,
    account_route: routeOf(identity.accountId),
    partition_no: partitionOf(identity.route),
    incarnation: identity.incarnation,
    generation: identity.generation,
    scope: identity.scope,
    owner_epoch: identity.ownerEpoch,
    receiving_epoch: identity.receivingEpoch,
    effect_key: identity.effectKey,
    output_generation: identity.outputGeneration ?? null,
    publication_transaction_id: identity.publicationTransactionId ?? null,
    publication_position: identity.publicationPosition ?? null,
  };
}
/** Fixed projections and primary-key/route-leading range plans only; no observed row-count cost classifier. */
function footprint(text: string, values: unknown[], rows: number, points: number, keys = 0, metadata = 0) {
  return {
    nativeRows: rows,
    nativePoints: points,
    candidateKeys: keys,
    identityMetadataRows: metadata,
    witnessKeys: 0,
    statements: 1,
    bytes:
      Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(values)) + (rows || points ? 4096 : 0) + keys * 1024,
    // Native point probes can miss even without a returned raw key. Keep these
    // admitted slots inclusive; a positive outer join result cannot measure inner misses.
    emptySeeks: keys ? 1 : points,
  };
}
const sameSQL = (sql: string) =>
  sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;$/, '');
const boundId = 'f'.repeat(36),
  boundDecimal = '9'.repeat(20),
  boundText = String.fromCharCode(1);
const captureProjectionBytes = Buffer.byteLength(
  JSON.stringify({
    route: 65535,
    captureId: boundId,
    collectionId: boundId,
    accountId: boundId,
    incarnation: boundText.repeat(128),
    generation: boundDecimal,
    scope: 'active_explicit_output',
    ownerEpoch: 2147483647,
    receivingEpoch: boundDecimal,
    effectKey: boundText.repeat(256),
    outputGeneration: boundId,
    publicationTransactionId: boundId,
    publicationPosition: boundDecimal,
    collectionFence: boundDecimal,
    accountFence: boundDecimal,
    driver: 'entry_deleted',
    after: boundText.repeat(512),
    tie: boundText.repeat(64),
    sessionId: boundId,
    scanned: boundDecimal,
    version: 2147483647,
    complete: false,
  }),
);
/** Literal reached capture/basis declarations; no table-prefix or arbitrary observer callback. */
export function nativeSourceCustodyFootprint(sql: string, values: readonly unknown[]): WorkDimensions | undefined {
  const text = sameSQL(sql);
  if (isNativeIdentitySourceBasisSQL(sql)) return nativeIdentitySourceBasisFootprint(sql, values);
  if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text)) return footprint(sql, [...values], 0, 0);
  for (const [query, rows, points, metadata, keys = 0] of [
    [identityPartitionQuery, 16, 1, 1],
    [accountQuery, 16, 1, 0],
    [sourceQuery, 16, 1, 0],
    [outputQuery, 56, 7, 1],
    [ensureQuery, 32, 2, 0],
    [fencesQuery, 32, 2, 0],
    [readQuery, 16, 1, 0],
    [startQuery, 32, 1, 0],
    [advanceQuery, 32, 1, 0],
    [identityCapture, 32, 1, 0],
    [proofQuery, 64, 3, 1],
    [finishQuery, 80, 3, 1],
    [holdQuery, 48, 1, 0],
    [heldQuery, 16, 1, 0],
    [retainedQuery, 16, 1, 0],
    [releaseQuery, 32, 1, 0],
    [retireSource, 16, 1, 0],
    [retireReceipt, 16, 1, 0],
    [terminalScope, 48, 3, 0],
    [identityRetention, 2, 1, 0, 1],
    [retireActive, 16, 1, 0, 1],
    [retireHolds, 16 * 80 + 32, 1, 0, 80],
    [retireChildren, 16 * 80, 80, 0],
    [retireProof, 32, 2, 0],
    [retireCapture, 32, 2, 0],
    [nextCapture, 32, 2, 0, 1],
  ] as const) {
    if (sameSQL(query.sql) === text && query.params.length === values.length) {
      if (query === retireChildren) {
        const ids = values[query.params.indexOf('hold_ids')];
        if (!Array.isArray(ids) || ids.length > 80 || ids.some((id) => typeof id !== 'string' || !uuid.test(id)))
          return undefined;
      }
      const work = footprint(sql, [...values], rows, points, keys, metadata);
      const projection = query === readQuery ? captureProjectionBytes : undefined;
      if (projection !== undefined) work.bytes += projection - 4096;
      return work;
    }
  }
  for (const query of [...Object.values(rawQueries), rawExplicitOutput]) {
    if (sameSQL(query.sql) !== text || query.params.length !== values.length) continue;
    const n = values[query.params.indexOf('limit')];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1 || n > 100) return undefined;
    return footprint(sql, [...values], 16 * n + 32, 1, n);
  }
  return undefined;
}

export { declareNativeIdentitySourceBasisStatements } from './identity-native-planner-selected-pricing.ts';
function executor(client: CommandTransaction, work: NativeCollectionWork, deadline: number, strict = false) {
  return async <R extends QueryResultRow = QueryResultRow>(
    query: Query,
    values: Parameters,
    rows = 16,
    points = 1,
    keys = 0,
  ): Promise<R[]> => {
    revalidateBoundLibraryIdentityWork(work);
    if (Date.now() >= deadline) throw new Refused('allowance');
    if (query === partitionQuery) query = identityPartitionQuery;
    const args = query.params.map((name) => values[name]);
    const metadata =
      query === partitionQuery || query === finishQuery || query === proofQuery || query === outputQuery ? 1 : 0;
    // Shared original descendants can only dispatch the owner's recognized literals.
    // The explicit reservation suppresses duplicate observation, never unknown SQL.
    const declared = nativeSourceCustodyFootprint(query.sql, args);
    const requested = footprint(query.sql, args, rows, points, keys, metadata);
    const admitted = work.reserve(
      strict || !declared ? declared : { ...declared, bytes: Math.max(declared.bytes, requested.bytes) },
    );
    admitted.dispatch();
    try {
      const config = {
        text: query.sql,
        values: args,
        // A shared genuine CommandTransaction owns its immutable deadline and query surface.
        ...(!strict ? { query_timeout: Math.max(1, deadline - Date.now()) } : {}),
      };
      const result = await admitted.query(() => client.query<R>(config));
      revalidateBoundLibraryIdentityWork(work);
      // Dispatched native bounds, including possible inner misses, are never repriced from output.
      admitted.settle();
      return result.rows;
    } catch (error) {
      admitted.settle();
      throw error;
    }
  };
}
type Execute = ReturnType<typeof executor>;
async function terminalOwner(run: Execute, values: Parameters): Promise<boolean> {
  const [scope] = await run<{ version: number; outcome: string | null }>(
    terminalScope,
    {
      ...values,
      route: values.account_route,
    },
    48,
    3,
  );
  return scope?.version === 1 && scope.outcome === null;
}
async function bindOwner(
  run: Execute,
  identity: NativeSourceIdentity,
  ensure: boolean,
  retained = false,
): Promise<{ collectionFence: string; accountFence: string; outputMembers?: string }> {
  validate(identity);
  const values = parameters(identity);
  const [partition] = await run<{ epoch: number; writeState: string; movedTo: string | null }>(partitionQuery, values);
  if (
    !partition ||
    partition.writeState !== 'active' ||
    partition.movedTo !== null ||
    partition.epoch !== identity.ownerEpoch
  )
    throw new Refused('binding');
  const [account] = await run<{ state: string; fenced: boolean }>(accountQuery, values);
  if (!account || account.state !== 'active' || account.fenced) {
    if (!retained || account?.state !== 'deleted' || !account.fenced || !(await terminalOwner(run, values)))
      throw new Refused('binding');
  }
  const [source] = await run<{
    accountId: string | null;
    incarnation: string;
    generation: string;
    state: string;
    kind: string;
    builtin: string | null;
    visibility: string;
    ruleReady: boolean;
  }>(sourceQuery, values);
  if (
    !source ||
    source.accountId !== identity.accountId ||
    source.incarnation !== identity.incarnation ||
    (!retained && source.generation !== identity.generation) ||
    (source.state !== 'active' && !(retained && source.state === 'deleted'))
  )
    throw new Refused('binding');
  let outputMembers: string | undefined;
  if (identity.scope === 'active_explicit_output') {
    if (source.kind !== 'dynamic' || source.builtin !== null) throw new Refused('output_authority');
    if (!retained) {
      if (source.visibility === 'private') throw new Refused('output_authority');
      const [output] = await run<{ members: string }>(outputQuery, values, 56, 7);
      if (!output) throw new Refused('output_authority');
      outputMembers = output.members;
    }
  } else if (
    source.kind === 'dynamic' &&
    source.visibility !== 'private' &&
    (identity.scope !== 'private_builtin' || source.builtin !== null || !source.ruleReady)
  ) {
    throw new Refused('output_authority');
  }
  if (
    (identity.scope === 'curated' && source.kind !== 'curated') ||
    (identity.scope === 'private_builtin' && source.kind !== 'dynamic')
  )
    throw new Refused('binding');
  if (ensure) await run(ensureQuery, values, 32, 2);
  const heads = await run<{ kind: string; generation: string }>(fencesQuery, values, 32, 2);
  const collectionFence = heads.find((row) => row.kind === 'collection')?.generation;
  const accountFence = heads.find((row) => row.kind === 'account')?.generation;
  if (collectionFence === undefined || accountFence === undefined) throw new Refused('binding');
  return { collectionFence, accountFence, ...(outputMembers === undefined ? {} : { outputMembers }) };
}
function compareFences(state: State, fences: { collectionFence: string; accountFence: string }): void {
  if (state.collectionFence !== fences.collectionFence || state.accountFence !== fences.accountFence)
    throw new Refused('writer');
}
function frontier(state: NativeSourceFrontier): NativeSourceFrontier {
  return Object.freeze(Object.fromEntries(frontierKeys.map((key) => [key, state[key]]))) as NativeSourceFrontier;
}
async function readState(run: Execute, identity: NativeSourceIdentity, captureId: string): Promise<State> {
  if (!uuid.test(captureId)) throw new Refused('binding');
  const [state] = await run<State>(readQuery, { ...parameters(identity), capture_id: captureId });
  if (!state || !sameIdentity(state, identity)) throw new Refused('binding');
  return state;
}
function compareOutputCount(state: State, fences: { outputMembers?: string }): void {
  if (fences.outputMembers !== undefined && state.scanned !== fences.outputMembers) throw new Refused('writer');
}

/** Existing-owner raw dependency capture. No identity, canonical Source, permission or destination authority. */
export function createNativeLibrarySourceCustody(options: {
  pool: Pool;
  clock?: KernelClock;
}): NativeLibrarySourceCustody {
  return nativeLibrarySourceCustody(options);
}
export function createNativeLibrarySourceCustodyWithWork(
  pool: Pool,
  work: NativeCollectionWork,
): NativeLibrarySourceCustody {
  revalidateBoundLibraryIdentityWork(work);
  return nativeLibrarySourceCustody({ pool }, work);
}
function nativeLibrarySourceCustody(
  { pool, clock: _clock }: { pool: Pool; clock?: KernelClock },
  sharedWork?: NativeCollectionWork,
): NativeLibrarySourceCustody {
  async function account<T>(
    input: NativeSourceCaptureWork,
    operation: (work: NativeCollectionWork) => Promise<T>,
  ): Promise<T | Unavailable> {
    const work = sharedWork ?? new NativeCollectionWork(input.allowance, input.deadline);
    try {
      if (sharedWork) assertLibraryIdentityResources(pool, work, input.deadline);
      return sharedWork ? await withLibraryIdentityWork(pool, work, () => operation(work)) : await operation(work);
    } catch (error) {
      if (error instanceof Refused) return { status: 'unavailable', reason: error.reason, work: work.receipt() };
      if (error instanceof ProblemError && error.code === 'dependency_unavailable')
        return { status: 'unavailable', reason: 'allowance', work: work.receipt() };
      if (error instanceof Error)
        Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
      throw error;
    }
  }
  async function transaction<T>(
    input: NativeSourceCaptureWork,
    work: NativeCollectionWork,
    operation: (run: Execute) => Promise<T>,
  ): Promise<T> {
    // Both terminal slots precede checkout. A rejected COMMIT never consumes rollback's slot.
    const commit = work.reserve(footprint('COMMIT', [], 0, 0), true);
    let rollback: ReturnType<NativeCollectionWork['reserve']>;
    try {
      rollback = work.reserve(footprint('ROLLBACK', [], 0, 0), true);
    } catch (error) {
      commit.cancel();
      throw error;
    }
    let committed = false,
      rolledBack = false;
    try {
      return await instrumentNativeCollectionWork(
        pool,
        work,
        (sql, values) => {
          revalidateBoundLibraryIdentityWork(work);
          return nativeSourceCustodyFootprint(sql, values);
        },
        () =>
          withConnection(pool, async (client) => {
            revalidateBoundLibraryIdentityWork(work);
            const run = executor(client, work, input.deadline, sharedWork !== undefined);
            let begun = false;
            try {
              await run({ sql: 'BEGIN', params: [] }, {}, 0, 0);
              begun = true;
              const result = await operation(run);
              revalidateBoundLibraryIdentityWork(work);
              if (Date.now() >= input.deadline) throw new Refused('allowance');
              commit.dispatch();
              committed = true;
              try {
                const request = { text: 'COMMIT', query_timeout: Math.max(1, input.deadline - Date.now()) };
                await commit.query(() => client.query(request));
              } finally {
                commit.settle();
              }
              begun = false;
              revalidateBoundLibraryIdentityWork(work);
              return result;
            } catch (error) {
              if (begun) {
                try {
                  rollback.dispatch();
                  rolledBack = true;
                  await rollback.query(() => client.query('ROLLBACK'));
                } catch (cleanup) {
                  discardConnection(
                    client,
                    cleanup instanceof Error ? cleanup : new Error('Native source rollback failed'),
                  );
                  throw cleanup;
                } finally {
                  if (rolledBack) rollback.settle();
                }
              }
              throw error;
            }
          }),
      );
    } finally {
      if (!committed) commit.cancel();
      if (!rolledBack) rollback.cancel();
    }
  }

  function live(input: { client: CommandTransaction; at: AuthoritativeTime; identity: NativeSourceIdentity }): void {
    validate(input.identity);
    if (commandTime(input.client) !== input.at) throw new Refused('binding');
    try {
      if (hasLiveOperationalTransaction(input.client)) {
        const resources = currentOperationalResources(input.client);
        if (
          resources.pool !== pool ||
          resources.mode !== 'work-step' ||
          resources.partition !== partitionOf(input.identity.route) ||
          resources.accounts.length !== 1 ||
          resources.accounts[0] !== input.identity.accountId
        )
          throw new Refused('binding');
      } else {
        const context = currentCommand(input.client);
        if (context.partition !== partitionOf(input.identity.route) || context.time !== input.at)
          throw new Refused('binding');
      }
      authoritativeTimeValue(input.at);
    } catch {
      throw new Refused('binding');
    }
  }
  return {
    retireCapture(input) {
      return account(input, async (work): Promise<NativeSourceRetirementResult> => {
        if (hasLiveOperationalTransaction(input.client)) throw new Refused('binding');
        live(input);
        validate(input.identity);
        if (!uuid.test(input.captureId) || !/^(0|[1-9][0-9]{0,18})$/.test(input.sourceGeneration))
          throw new Refused('binding');
        const run = executor(
          input.client,
          work,
          Math.min(input.deadline, currentCommandResources(input.client).deadline),
        );
        const episode = input.episode;
        if (
          episode.kind !== 'terminal' &&
          (episode.kind !== 'deleted' ||
            !uuid.test(episode.deletionId) ||
            !Number.isSafeInteger(episode.revision) ||
            episode.revision < 2 ||
            !Number.isFinite(Date.parse(episode.purgeAfter)))
        )
          throw new Refused('binding');
        const values = {
          ...parameters(input.identity),
          capture_id: input.captureId,
          purge_after: episode.kind === 'deleted' ? episode.purgeAfter : null,
          time: authoritativeTimeValue(input.at),
        };
        const blocked = (reason: Extract<NativeSourceRetirementResult, { status: 'blocked' }>['reason']) => ({
          status: 'blocked' as const,
          reason,
          work: work.receipt(),
        });
        const [partition] = await run<{ epoch: number; writeState: string; movedTo: string | null }>(
          partitionQuery,
          values,
        );
        if (
          !partition ||
          partition.epoch !== input.identity.ownerEpoch ||
          partition.writeState !== 'active' ||
          partition.movedTo !== null
        )
          throw new Refused('binding');
        // Same order as adoption/retained release: account, Collection, controls, capture, receipt, holds.
        const [owner] = await run<{ state: string; fenced: boolean }>(accountQuery, values);
        if (episode.kind === 'terminal') {
          if (owner?.state !== 'deleted' || !owner.fenced || !(await terminalOwner(run, values)))
            throw new Refused('binding');
        } else if (owner?.state !== 'active' || owner.fenced) throw new Refused('binding');
        const [source] = await run<{
          accountId: string | null;
          incarnation: string;
          generation: string;
          state: string;
          kind: string;
          builtin: string | null;
          visibility: string;
          deletionId: string | null;
          revision: number;
          deadlineMatches: boolean | null;
          due: boolean | null;
          publicCustody: boolean;
        }>(retireSource, values, 32, 2);
        if (
          !source ||
          source.accountId !== input.identity.accountId ||
          source.incarnation !== input.identity.incarnation ||
          source.generation !== input.sourceGeneration ||
          (input.identity.scope === 'curated'
            ? source.kind !== 'curated'
            : input.identity.scope === 'private_builtin'
              ? source.kind !== 'dynamic' || (episode.kind !== 'terminal' && source.visibility !== 'private')
              : source.kind !== 'dynamic' || source.builtin !== null)
        )
          return blocked('source');
        if (
          (source.publicCustody && !(episode.kind === 'terminal' && input.identity.scope === 'private_builtin')) ||
          input.identity.scope === 'active_explicit_output'
        )
          return blocked('public_custody');
        if (
          episode.kind === 'deleted' &&
          (source.state !== 'deleted' ||
            source.deletionId !== episode.deletionId ||
            source.revision !== episode.revision ||
            !source.deadlineMatches ||
            !source.due)
        )
          return blocked('source');
        const controls = await run(fencesQuery, values, 32, 2);
        if (controls.length !== 2) throw new Refused('binding');
        const [state] = await run<State>(readQuery, values);
        if (!state) return { status: 'retired', removed: 0, work: work.receipt() };
        if (!sameIdentity(state, input.identity)) throw new Refused('binding');
        const [receipt] = await run<{ transactionId: string }>(retireReceipt, values);
        if (state.complete) {
          const [proof] = await run<{ transactionId: string }>(proofQuery, values, 64, 3);
          if (!receipt || !proof || receipt.transactionId !== proof.transactionId) throw new Refused('binding');
        } else if (receipt) throw new Refused('binding');
        // Never partially delete receipts/holds below native plan evidence. The FK is also a
        // concurrent-registration barrier; missing handoff is a retained source, not erased data.
        if ((await run(identityRetention, values, 2, 1, 1)).length) return blocked('source');
        if ((await run(retireActive, values, 16, 1, 1)).length) return blocked('live_hold');
        const children = await run<{ id: string; transactionId: string; released: boolean; committed: boolean }>(
          retireHolds,
          values,
          16 * 80 + 32,
          1,
          80,
        );
        if (children.some((child) => !child.released)) return blocked('live_hold');
        if (children.some((child) => child.transactionId !== receipt?.transactionId)) throw new Refused('binding');
        if (children.some((child) => !child.committed)) return blocked('release_uncommitted');
        let removed = 0;
        if (children.length) {
          removed = (await run(retireChildren, { ...values, hold_ids: children.map((child) => child.id) }, 16 * 80, 80))
            .length;
          if (removed !== children.length) throw new Refused('binding');
        }
        // Leave the two parent keys for another attempt when this raw page is full.
        if (children.length === 80) return { status: 'progress', removed, work: work.receipt() };
        removed += (await run(retireProof, values, 32, 2)).length;
        if ((await run(retireCapture, values, 32, 2)).length !== 1) throw new Refused('binding');
        return { status: 'retired', removed: removed + 1, work: work.receipt() };
      });
    },
    capturePage(input) {
      return account(input, async (work) => {
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Refused('binding');
        const result = await transaction(input, work, async (run) => {
          const fences = await bindOwner(run, input.identity, true);
          let state: State;
          if (input.frontier === null) {
            const captureId = crypto.randomUUID();
            await run(
              startQuery,
              {
                ...parameters(input.identity),
                capture_id: captureId,
                collection_fence: fences.collectionFence,
                account_fence: fences.accountFence,
                driver: input.identity.scope === 'active_explicit_output' ? 'output' : 'member',
              },
              32,
            );
            state = {
              ...input.identity,
              ...fences,
              captureId,
              driver: input.identity.scope === 'active_explicit_output' ? 'output' : 'member',
              after: '',
              tie: '',
              sessionId: null,
              scanned: '0',
              version: 0,
              complete: false,
            };
          } else {
            state = await readState(run, input.identity, input.frontier.captureId);
            if (!sameFrontier(state, input.frontier) || state.complete) throw new Refused('binding');
            compareFences(state, fences);
          }
          let rows: NativeSourceDependency[] = [];
          if (state.driver !== 'done') {
            const driver = state.driver;
            // Sessions are native parent points, then bounded child ranges. No foreign per-row lookup.
            const limit = driver === 'session' ? 1 : input.limit;
            const after =
              state.after || (driver === 'member' || driver === 'unit' ? '' : driver === 'change' ? '0' : null);
            const raw = await run<Omit<NativeSourceDependency, 'driver'>>(
              input.identity.scope === 'active_explicit_output' ? rawExplicitOutput : rawQueries[driver],
              {
                ...parameters(input.identity),
                after: input.identity.scope === 'active_explicit_output' ? state.after || null : after,
                tie: state.tie || zeroId,
                session_id: state.sessionId,
                limit,
              },
              16 * limit + 32,
              1,
              limit,
            );
            rows = raw.map((row) => Object.freeze({ ...row, driver }));
            state = { ...state, scanned: (BigInt(state.scanned) + BigInt(raw.length)).toString() };
            const last = raw.at(-1);
            if (driver === 'session' && last) {
              state = { ...state, driver: 'unit', sessionId: last.key, after: '', tie: '' };
            } else if (raw.length === limit && last) {
              state = { ...state, after: last.key, tie: last.tie };
            } else {
              const next: Record<Exclude<NativeSourceDriver, 'done'>, NativeSourceDriver> = {
                member: 'entry',
                entry: 'entry_deleted',
                entry_deleted: 'label',
                label: 'assignment',
                assignment: 'session',
                session: 'copy',
                unit: 'change',
                change: 'session',
                copy: 'output',
                output: 'done',
              };
              state = {
                ...state,
                driver: next[driver],
                after: driver === 'change' ? state.sessionId! : '',
                tie: '',
                sessionId: driver === 'unit' ? state.sessionId : null,
              };
            }
            if (state.driver === 'done') compareOutputCount(state, fences);
            await run(
              advanceQuery,
              {
                ...parameters(input.identity),
                capture_id: state.captureId,
                driver: state.driver,
                after: state.after,
                tie: state.tie,
                session_id: state.sessionId,
                scanned: state.scanned,
              },
              32,
            );
            state = { ...state, version: state.version + 1 };
          }
          return { status: 'pending' as const, frontier: frontier(state), rows };
        });
        return { ...result, work: work.receipt() };
      });
    },
    finishCapture(input) {
      return account(input, async (work) => {
        const result = await transaction(input, work, async (run) => {
          const fences = await bindOwner(run, input.identity, false);
          const state = await readState(run, input.identity, input.frontier.captureId);
          if (!sameFrontier(state, input.frontier) || state.driver !== 'done') throw new Refused('binding');
          compareFences(state, fences);
          compareOutputCount(state, fences);
          const values = { ...parameters(input.identity), capture_id: state.captureId };
          const [receipt] = state.complete
            ? await run<{ transactionId: string; position: string }>(proofQuery, values, 64, 3)
            : await run<{ transactionId: string; position: string }>(
                finishQuery,
                { ...values, transaction_id: crypto.randomUUID() },
                80,
                3,
              );
          if (!receipt) throw new Refused('binding');
          validate(input.identity);
          return {
            status: 'complete' as const,
            capture: Object.freeze({
              [captureEvidence]: true as const,
              identity: Object.freeze({ ...input.identity }),
              captureId: state.captureId,
              transactionId: receipt.transactionId,
              position: receipt.position,
              scanned: state.scanned,
            }),
          };
        });
        return { ...result, work: work.receipt() };
      });
    },
    readAndHold(input) {
      return account(input, async (work) => {
        live(input);
        if (!uuid.test(input.holdId)) throw new Refused('binding');
        const run = executor(input.client, work, input.deadline);
        const fences = await bindOwner(run, input.identity, false);
        const state = await readState(run, input.identity, input.captureId);
        compareFences(state, fences);
        compareOutputCount(state, fences);
        const values = { ...parameters(input.identity), capture_id: input.captureId, hold_id: input.holdId };
        const [receipt] = await run<{ transactionId: string }>(proofQuery, values, 64, 3);
        if (!receipt) throw new Refused('binding');
        const [held] = await run<{ transactionId: string; released: boolean }>(
          holdQuery,
          { ...values, transaction_id: receipt.transactionId },
          48,
        );
        if (!held || held.released || held.transactionId !== receipt.transactionId) throw new Refused('binding');
        return {
          status: 'held' as const,
          custody: Object.freeze({
            [custodyEvidence]: true as const,
            identity: Object.freeze({ ...input.identity }),
            captureId: input.captureId,
            holdId: input.holdId,
            transactionId: receipt.transactionId,
          }),
          work: work.receipt(),
        };
      });
    },
    revalidateHold(input) {
      return account(input, async (work) => {
        live(input);
        if (!uuid.test(input.holdId)) throw new Refused('binding');
        const run = executor(input.client, work, input.deadline);
        // Current lifecycle/ownership fences still apply. Writer generations describe fresh reads,
        // not the lifetime of an exact retained obligation from an earlier committed capture.
        await bindOwner(run, input.identity, false, true);
        await readState(run, input.identity, input.captureId);
        const values = { ...parameters(input.identity), capture_id: input.captureId, hold_id: input.holdId };
        const [receipt] = await run<{ transactionId: string }>(proofQuery, values, 64, 3);
        if (!receipt) throw new Refused('binding');
        const [held] = await run<{ transactionId: string }>(retainedQuery, values);
        if (!held || held.transactionId !== receipt.transactionId) throw new Refused('binding');
        return {
          status: 'held' as const,
          custody: Object.freeze({
            [custodyEvidence]: true as const,
            identity: Object.freeze({ ...input.identity }),
            captureId: input.captureId,
            holdId: input.holdId,
            transactionId: receipt.transactionId,
          }),
          work: work.receipt(),
        };
      });
    },
    releaseHold(input) {
      return account(input, async (work) => {
        live(input);
        if (!uuid.test(input.holdId)) throw new Refused('binding');
        const run = executor(input.client, work, input.deadline);
        // Release checks exact native binding and current owner/account fences, but never requires unchanged facts.
        // A stale fact generation cannot strand an existing hold or authorize deleting its business source.
        await bindOwner(run, input.identity, false, true);
        await readState(run, input.identity, input.captureId);
        const values = { ...parameters(input.identity), capture_id: input.captureId, hold_id: input.holdId };
        const [receipt] = await run<{ transactionId: string }>(proofQuery, values, 64, 3);
        const [held] = await run<{ transactionId: string; released: boolean }>(heldQuery, values);
        if (!receipt || !held || held.transactionId !== receipt.transactionId) throw new Refused('binding');
        if (!held.released) await run(releaseQuery, values, 32);
        return { status: 'released' as const, work: work.receipt() };
      });
    },
  };
}

/** Fixed local cleanup budget; composed discovery and retirement share one receipt and command deadline. */
export async function retireNativeCollectionCapturePage(
  client: CommandTransaction,
  input: { accountId: string; collectionId: string; captureId?: string; episode: NativeSourceRetirement['episode'] },
): Promise<NativeSourceRetirementResult> {
  const { pool, deadline } = currentCommandResources(client);
  const at = currentCommand(client).time;
  const allowance: WorkAllowance = {
    reservationId: crypto.randomUUID(),
    remaining: {
      candidateKeys: 100,
      nativeRows: 10000,
      nativePoints: 256,
      identityMetadataRows: 2, // The existing retirement step reads the partition and completed receipt.
      witnessKeys: 0,
      statements: 32,
      bytes: 1024 * 1024,
      emptySeeks: 32,
    },
  };
  const work = new NativeCollectionWork(allowance, deadline);
  const run = executor(client, work, deadline);
  const [capture] = await run<NativeSourceIdentity & { captureId: string; sourceGeneration: string | null }>(
    nextCapture,
    { route: routeOf(input.collectionId), collection_id: input.collectionId, capture_id: input.captureId ?? null },
    32,
    2,
    1,
  );
  if (!capture) return { status: 'retired', removed: 0, work: work.receipt() };
  if (capture.scope === 'public_output' || capture.accountId !== input.accountId || capture.sourceGeneration === null)
    return { status: 'blocked', reason: 'source', work: work.receipt() };
  const result = await work.compose((remaining) =>
    createNativeLibrarySourceCustody({ pool }).retireCapture({
      client,
      at,
      identity: capture,
      captureId: capture.captureId,
      sourceGeneration: capture.sourceGeneration!,
      episode: input.episode,
      allowance: remaining,
      deadline,
    }),
  );
  return { ...result, work: work.receipt() };
}
/** A maintenance observation of the real retained raw capture. Does not consult ready-reader Scope state.
 * The caller holds the Source-local Core transaction; all owner/capture locks remain on that client.
 */
export async function readNativeIdentitySourceBasis(
  tx: CommandTransaction,
  identity: NativeSourceIdentity,
  input: NativeSourceCaptureWork & { captureId?: string },
  sharedWork?: NativeCollectionWork,
): Promise<
  | Unavailable
  | {
      status: 'current';
      frontier: NativeSourceFrontier;
      complete: boolean;
      collectionFence: string;
      accountFence: string;
      work: WorkReceipt;
    }
> {
  const work = sharedWork ?? new NativeCollectionWork(input.allowance, input.deadline);
  try {
    if (sharedWork) assertLibraryIdentityResources(currentCommandResources(tx).pool, work, input.deadline);
    if (currentCommand(tx).partition !== partitionOf(identity.route)) throw new Refused('binding');
    const run = executor(tx, work, input.deadline, sharedWork !== undefined);
    const fences = await bindOwner(run, identity, false);
    const [capture] = await run<
      NativeSourceFrontier & {
        complete: boolean;
        collectionFence: string;
        accountFence: string;
      }
    >(
      identityCapture,
      {
        ...parameters(identity),
        capture_id: input.captureId ?? null,
        collection_fence: fences.collectionFence,
        account_fence: fences.accountFence,
      },
      32,
      1,
    );
    if (!capture) throw new Refused('binding');
    if (capture.complete) {
      const [proof] = await run(
        proofQuery,
        {
          ...parameters(identity),
          capture_id: capture.captureId,
        },
        64,
        3,
      );
      if (!proof || capture.driver !== 'done') throw new Refused('binding');
    }
    return {
      status: 'current',
      frontier: frontier(capture),
      complete: capture.complete,
      ...fences,
      work: work.receipt(),
    };
  } catch (error) {
    if (error instanceof Refused) return { status: 'unavailable', reason: error.reason, work: work.receipt() };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}
