import { memoizedValue } from '../memoized.ts';
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
import type { WorkAllowance, WorkReceipt } from './contract/work-dimensions.ts';
import {
  nativeSourceCustodyExecutionBound,
  nativeSourceCustodyFootprint,
  nativeSourceCustodyOperationBound,
  NATIVE_SOURCE_CUSTODY_RETIREMENT_PAGE_BOUND,
  nativeSourceCustodyQueries,
  nativeSourceCustodyWorkDimensions,
  createNativeSourceCustodyOperationUse,
  type NativeSourceCustodyOperationUse,
  type NativeSourceCustodyOperation,
} from './native-source-custody-bounds.ts';

export { nativeSourceCustodyFootprint };
export { declareNativeIdentitySourceBasisStatements } from './identity-native-planner-selected-pricing.ts';

function identityPartitionQuery() {
  return memoizedValue(identityPartitionQuery, () => nativeSourceCustodyQueries().partition);
}
function sourceQuery() {
  return memoizedValue(sourceQuery, () => nativeSourceCustodyQueries().source);
}
function accountQuery() {
  return memoizedValue(accountQuery, () => nativeSourceCustodyQueries().account);
}
function outputQuery() {
  return memoizedValue(outputQuery, () => nativeSourceCustodyQueries().output);
}
function ensureQuery() {
  return memoizedValue(ensureQuery, () => nativeSourceCustodyQueries().ensure);
}
function fencesQuery() {
  return memoizedValue(fencesQuery, () => nativeSourceCustodyQueries().fences);
}
function readQuery() {
  return memoizedValue(readQuery, () => nativeSourceCustodyQueries().read);
}
function startQuery() {
  return memoizedValue(startQuery, () => nativeSourceCustodyQueries().start);
}
function advanceQuery() {
  return memoizedValue(advanceQuery, () => nativeSourceCustodyQueries().advance);
}
function identityCapture() {
  return memoizedValue(identityCapture, () => nativeSourceCustodyQueries().identityCapture);
}
function proofQuery() {
  return memoizedValue(proofQuery, () => nativeSourceCustodyQueries().proof);
}
function finishQuery() {
  return memoizedValue(finishQuery, () => nativeSourceCustodyQueries().finish);
}
function holdQuery() {
  return memoizedValue(holdQuery, () => nativeSourceCustodyQueries().hold);
}
function heldQuery() {
  return memoizedValue(heldQuery, () => nativeSourceCustodyQueries().held);
}
function retainedQuery() {
  return memoizedValue(retainedQuery, () => nativeSourceCustodyQueries().retained);
}
function releaseQuery() {
  return memoizedValue(releaseQuery, () => nativeSourceCustodyQueries().release);
}
function terminalScope() {
  return memoizedValue(terminalScope, () => nativeSourceCustodyQueries().terminalScope);
}
function rawQueries() {
  return memoizedValue(rawQueries, () => nativeSourceCustodyQueries().raw);
}
function rawExplicitOutput() {
  return memoizedValue(rawExplicitOutput, () => nativeSourceCustodyQueries().rawExplicitOutput);
}
function partitionQuery() {
  return memoizedValue(partitionQuery, () => nativeSourceCustodyQueries().retirement.partition);
}
function retireSource() {
  return memoizedValue(retireSource, () => nativeSourceCustodyQueries().retirement.source);
}
function retireReceipt() {
  return memoizedValue(retireReceipt, () => nativeSourceCustodyQueries().retirement.receipt);
}
function retireActive() {
  return memoizedValue(retireActive, () => nativeSourceCustodyQueries().retirement.active);
}
function retireHolds() {
  return memoizedValue(retireHolds, () => nativeSourceCustodyQueries().retirement.holds);
}
function retireChildren() {
  return memoizedValue(retireChildren, () => nativeSourceCustodyQueries().retirement.children);
}
function retireProof() {
  return memoizedValue(retireProof, () => nativeSourceCustodyQueries().retirement.proof);
}
function retireCapture() {
  return memoizedValue(retireCapture, () => nativeSourceCustodyQueries().retirement.capture);
}
function identityRetention() {
  return memoizedValue(identityRetention, () => nativeSourceCustodyQueries().retirement.identityRetention);
}
function nextCapture() {
  return memoizedValue(nextCapture, () => nativeSourceCustodyQueries().retirement.nextCapture);
}

import type { NativeAccountSourceIdentity, NativeSourceIdentity } from './contract/source.ts';
export type {
  NativeAccountSourceIdentity,
  NativeOutputActivation,
  NativePublicOutputIdentity,
  NativeSourceIdentity,
} from './contract/source.ts';
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
        capture: NativeSourceCapture & Readonly<{ identity: NativeAccountSourceIdentity }>;
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

const zeroId = '00000000-0000-0000-0000-000000000000';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Query = { sql: string; params: readonly string[] };
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
function validate(identity: NativeSourceIdentity): asserts identity is NativeAccountSourceIdentity {
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
function accountIdentity(identity: NativeSourceIdentity): NativeAccountSourceIdentity {
  validate(identity);
  return identity;
}
/** Structural native bind validation only; this grants no Source or original authority. */
export function validateNativeIdentitySource(identity: NativeSourceIdentity): void {
  validate(identity);
}
function parameters(identity: NativeSourceIdentity): Parameters {
  const account = accountIdentity(identity);
  return {
    route: account.route,
    collection_id: account.collectionId,
    account_id: account.accountId,
    account_route: routeOf(account.accountId),
    partition_no: partitionOf(account.route),
    incarnation: account.incarnation,
    generation: account.generation,
    scope: account.scope,
    owner_epoch: account.ownerEpoch,
    receiving_epoch: account.receivingEpoch,
    effect_key: account.effectKey,
    output_generation: account.outputGeneration ?? null,
    publication_transaction_id: account.publicationTransactionId ?? null,
    publication_position: account.publicationPosition ?? null,
  };
}
function executor(
  client: CommandTransaction,
  work: NativeCollectionWork,
  deadline: number,
  strict = false,
  operationUse?: NativeSourceCustodyOperationUse,
) {
  return async <R extends QueryResultRow = QueryResultRow>(query: Query, values: Parameters): Promise<R[]> => {
    revalidateBoundLibraryIdentityWork(work);
    if (Date.now() >= deadline) throw new Refused('allowance');
    if (operationUse && !operationUse.statement(query)) throw new Refused('allowance');
    if (query === partitionQuery()) query = identityPartitionQuery();
    const args = query.params.map((name) => values[name]);
    // Both original composition and dispatch consume the same closed statement plan.
    const declared = nativeSourceCustodyExecutionBound(query, args);
    if (!declared) throw new Refused('allowance');
    const admitted = work.reserve(nativeSourceCustodyWorkDimensions(declared));
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
  const [scope] = await run<{ version: number; outcome: string | null }>(terminalScope(), {
    ...values,
    route: values.account_route,
  });
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
  const [partition] = await run<{ epoch: number; writeState: string; movedTo: string | null }>(
    partitionQuery(),
    values,
  );
  if (
    !partition ||
    partition.writeState !== 'active' ||
    partition.movedTo !== null ||
    partition.epoch !== identity.ownerEpoch
  )
    throw new Refused('binding');
  const [account] = await run<{ state: string; fenced: boolean }>(accountQuery(), values);
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
  }>(sourceQuery(), values);
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
      const [output] = await run<{ members: string }>(outputQuery(), values);
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
  if (ensure) await run(ensureQuery(), values);
  const heads = await run<{ kind: string; generation: string }>(fencesQuery(), values);
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
  const [state] = await run<State>(readQuery(), { ...parameters(identity), capture_id: captureId });
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
    operation: (work: NativeCollectionWork, operationUse?: NativeSourceCustodyOperationUse) => Promise<T>,
    operationKind?: NativeSourceCustodyOperation,
  ): Promise<T | Unavailable> {
    const work = sharedWork ?? new NativeCollectionWork(input.allowance, input.deadline);
    const operationUse = operationKind ? createNativeSourceCustodyOperationUse(operationKind) : undefined;
    try {
      if (sharedWork) assertLibraryIdentityResources(pool, work, input.deadline);
      const invoke = () =>
        sharedWork
          ? withLibraryIdentityWork(pool, work, () => operation(work, operationUse))
          : operation(work, operationUse);
      if (!operationKind) return await invoke();
      const allowance: WorkAllowance = {
        reservationId: work.receipt().reservationId,
        remaining: nativeSourceCustodyWorkDimensions(nativeSourceCustodyOperationBound(operationKind)),
      };
      // This static ceiling scopes the same ledger and is checked against its current original.
      // It transfers no child, creates no credit and does not settle from returned row counts.
      return await work.withinAllowance(allowance, invoke);
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
    operationUse: NativeSourceCustodyOperationUse,
    operation: (run: Execute) => Promise<T>,
  ): Promise<T> {
    // Both terminal slots precede checkout. A rejected COMMIT never consumes rollback's slot.
    const commit = work.reserve(nativeSourceCustodyFootprint('COMMIT', []), true);
    let rollback: ReturnType<NativeCollectionWork['reserve']>;
    try {
      rollback = work.reserve(nativeSourceCustodyFootprint('ROLLBACK', []), true);
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
            if (!operationUse.checkout()) throw new Refused('allowance');
            revalidateBoundLibraryIdentityWork(work);
            const run = executor(client, work, input.deadline, sharedWork !== undefined, operationUse);
            let begun = false;
            try {
              await run({ sql: 'BEGIN', params: [] }, {});
              begun = true;
              const result = await operation(run);
              revalidateBoundLibraryIdentityWork(work);
              if (Date.now() >= input.deadline) throw new Refused('allowance');
              commit.dispatch();
              committed = true;
              try {
                if (!operationUse.statement({ sql: 'COMMIT', params: [] })) throw new Refused('allowance');
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
                  if (!operationUse.statement({ sql: 'ROLLBACK', params: [] })) throw new Refused('allowance');
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
    const identity = accountIdentity(input.identity);
    if (commandTime(input.client) !== input.at) throw new Refused('binding');
    try {
      if (hasLiveOperationalTransaction(input.client)) {
        const resources = currentOperationalResources(input.client);
        if (
          resources.pool !== pool ||
          resources.mode !== 'work-step' ||
          resources.partition !== partitionOf(identity.route) ||
          resources.accounts.length !== 1 ||
          resources.accounts[0] !== identity.accountId
        )
          throw new Refused('binding');
      } else {
        const context = currentCommand(input.client);
        if (context.partition !== partitionOf(identity.route) || context.time !== input.at)
          throw new Refused('binding');
      }
      authoritativeTimeValue(input.at);
    } catch {
      throw new Refused('binding');
    }
  }
  return {
    retireCapture(input) {
      return account(
        input,
        async (work, operationUse): Promise<NativeSourceRetirementResult> => {
          if (hasLiveOperationalTransaction(input.client)) throw new Refused('binding');
          live(input);
          const identity = accountIdentity(input.identity);
          if (!uuid.test(input.captureId) || !/^(0|[1-9][0-9]{0,18})$/.test(input.sourceGeneration))
            throw new Refused('binding');
          const run = executor(
            input.client,
            work,
            Math.min(input.deadline, currentCommandResources(input.client).deadline),
            false,
            operationUse!,
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
            ...parameters(identity),
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
            partitionQuery(),
            values,
          );
          if (
            !partition ||
            partition.epoch !== identity.ownerEpoch ||
            partition.writeState !== 'active' ||
            partition.movedTo !== null
          )
            throw new Refused('binding');
          // Same order as adoption/retained release: account, Collection, controls, capture, receipt, holds.
          const [owner] = await run<{ state: string; fenced: boolean }>(accountQuery(), values);
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
          }>(retireSource(), values);
          if (
            !source ||
            source.accountId !== identity.accountId ||
            source.incarnation !== identity.incarnation ||
            source.generation !== input.sourceGeneration ||
            (identity.scope === 'curated'
              ? source.kind !== 'curated'
              : identity.scope === 'private_builtin'
                ? source.kind !== 'dynamic' || (episode.kind !== 'terminal' && source.visibility !== 'private')
                : source.kind !== 'dynamic' || source.builtin !== null)
          )
            return blocked('source');
          if (
            (source.publicCustody && !(episode.kind === 'terminal' && identity.scope === 'private_builtin')) ||
            identity.scope === 'active_explicit_output'
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
          const controls = await run(fencesQuery(), values);
          if (controls.length !== 2) throw new Refused('binding');
          const [state] = await run<State>(readQuery(), values);
          if (!state) return { status: 'retired', removed: 0, work: work.receipt() };
          if (!sameIdentity(state, input.identity)) throw new Refused('binding');
          const [receipt] = await run<{ transactionId: string }>(retireReceipt(), values);
          if (state.complete) {
            const [proof] = await run<{ transactionId: string }>(proofQuery(), values);
            if (!receipt || !proof || receipt.transactionId !== proof.transactionId) throw new Refused('binding');
          } else if (receipt) throw new Refused('binding');
          // Never partially delete receipts/holds below native plan evidence. The FK is also a
          // concurrent-registration barrier; missing handoff is a retained source, not erased data.
          if ((await run(identityRetention(), values)).length) return blocked('source');
          if ((await run(retireActive(), values)).length) return blocked('live_hold');
          const children = await run<{ id: string; transactionId: string; released: boolean; committed: boolean }>(
            retireHolds(),
            values,
          );
          if (children.some((child) => !child.released)) return blocked('live_hold');
          if (children.some((child) => child.transactionId !== receipt?.transactionId)) throw new Refused('binding');
          if (children.some((child) => !child.committed)) return blocked('release_uncommitted');
          let removed = 0;
          if (children.length) {
            removed = (await run(retireChildren(), { ...values, hold_ids: children.map((child) => child.id) })).length;
            if (removed !== children.length) throw new Refused('binding');
          }
          // Leave the two parent keys for another attempt when this raw page is full.
          if (children.length === 80) return { status: 'progress', removed, work: work.receipt() };
          removed += (await run(retireProof(), values)).length;
          if ((await run(retireCapture(), values)).length !== 1) throw new Refused('binding');
          return { status: 'retired', removed: removed + 1, work: work.receipt() };
        },
        'retireCapture',
      );
    },
    capturePage(input) {
      return account(
        input,
        async (work, operationUse) => {
          if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Refused('binding');
          const result = await transaction(input, work, operationUse!, async (run) => {
            const fences = await bindOwner(run, input.identity, true);
            let state: State;
            if (input.frontier === null) {
              const captureId = crypto.randomUUID();
              await run(startQuery(), {
                ...parameters(input.identity),
                capture_id: captureId,
                collection_fence: fences.collectionFence,
                account_fence: fences.accountFence,
                driver: input.identity.scope === 'active_explicit_output' ? 'output' : 'member',
              });
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
                input.identity.scope === 'active_explicit_output' ? rawExplicitOutput() : rawQueries()[driver],
                {
                  ...parameters(input.identity),
                  after: input.identity.scope === 'active_explicit_output' ? state.after || null : after,
                  tie: state.tie || zeroId,
                  session_id: state.sessionId,
                  limit,
                },
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
              await run(advanceQuery(), {
                ...parameters(input.identity),
                capture_id: state.captureId,
                driver: state.driver,
                after: state.after,
                tie: state.tie,
                session_id: state.sessionId,
                scanned: state.scanned,
              });
              state = { ...state, version: state.version + 1 };
            }
            return { status: 'pending' as const, frontier: frontier(state), rows };
          });
          return { ...result, work: work.receipt() };
        },
        'capturePage',
      );
    },
    finishCapture(input) {
      return account(
        input,
        async (work, operationUse) => {
          const result = await transaction(input, work, operationUse!, async (run) => {
            const fences = await bindOwner(run, input.identity, false);
            const state = await readState(run, input.identity, input.frontier.captureId);
            if (!sameFrontier(state, input.frontier) || state.driver !== 'done') throw new Refused('binding');
            compareFences(state, fences);
            compareOutputCount(state, fences);
            const values = { ...parameters(input.identity), capture_id: state.captureId };
            const [receipt] = state.complete
              ? await run<{ transactionId: string; position: string }>(proofQuery(), values)
              : await run<{ transactionId: string; position: string }>(finishQuery(), {
                  ...values,
                  transaction_id: crypto.randomUUID(),
                });
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
        },
        'finishCapture',
      );
    },
    readAndHold(input) {
      return account(
        input,
        async (work, operationUse) => {
          live(input);
          if (!uuid.test(input.holdId)) throw new Refused('binding');
          const run = executor(input.client, work, input.deadline, false, operationUse!);
          const fences = await bindOwner(run, input.identity, false);
          const state = await readState(run, input.identity, input.captureId);
          compareFences(state, fences);
          compareOutputCount(state, fences);
          const values = { ...parameters(input.identity), capture_id: input.captureId, hold_id: input.holdId };
          const [receipt] = await run<{ transactionId: string }>(proofQuery(), values);
          if (!receipt) throw new Refused('binding');
          const [held] = await run<{ transactionId: string; released: boolean }>(holdQuery(), {
            ...values,
            transaction_id: receipt.transactionId,
          });
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
        },
        'readAndHold',
      );
    },
    revalidateHold(input) {
      return account(
        input,
        async (work, operationUse) => {
          live(input);
          if (!uuid.test(input.holdId)) throw new Refused('binding');
          const run = executor(input.client, work, input.deadline, false, operationUse!);
          // Current lifecycle/ownership fences still apply. Writer generations describe fresh reads,
          // not the lifetime of an exact retained obligation from an earlier committed capture.
          await bindOwner(run, input.identity, false, true);
          await readState(run, input.identity, input.captureId);
          const values = { ...parameters(input.identity), capture_id: input.captureId, hold_id: input.holdId };
          const [receipt] = await run<{ transactionId: string }>(proofQuery(), values);
          if (!receipt) throw new Refused('binding');
          const [held] = await run<{ transactionId: string }>(retainedQuery(), values);
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
        },
        'revalidateHold',
      );
    },
    releaseHold(input) {
      return account(
        input,
        async (work, operationUse) => {
          live(input);
          if (!uuid.test(input.holdId)) throw new Refused('binding');
          const run = executor(input.client, work, input.deadline, false, operationUse!);
          // Release checks exact native binding and current owner/account fences, but never requires unchanged facts.
          // A stale fact generation cannot strand an existing hold or authorize deleting its business source.
          await bindOwner(run, input.identity, false, true);
          await readState(run, input.identity, input.captureId);
          const values = { ...parameters(input.identity), capture_id: input.captureId, hold_id: input.holdId };
          const [receipt] = await run<{ transactionId: string }>(proofQuery(), values);
          const [held] = await run<{ transactionId: string; released: boolean }>(heldQuery(), values);
          if (!receipt || !held || held.transactionId !== receipt.transactionId) throw new Refused('binding');
          if (!held.released) await run(releaseQuery(), values);
          return { status: 'released' as const, work: work.receipt() };
        },
        'releaseHold',
      );
    },
  };
}

/** Exact native lookup plus closed retirement operation; both share one receipt and deadline. */
export async function retireNativeCollectionCapturePage(
  client: CommandTransaction,
  input: { accountId: string; collectionId: string; captureId?: string; episode: NativeSourceRetirement['episode'] },
): Promise<NativeSourceRetirementResult> {
  const { pool, deadline } = currentCommandResources(client);
  const at = currentCommand(client).time;
  const allowance: WorkAllowance = {
    reservationId: crypto.randomUUID(),
    remaining: nativeSourceCustodyWorkDimensions(NATIVE_SOURCE_CUSTODY_RETIREMENT_PAGE_BOUND()),
  };
  const work = new NativeCollectionWork(allowance, deadline);
  const run = executor(client, work, deadline);
  const [capture] = await run<NativeSourceIdentity & { captureId: string; sourceGeneration: string | null }>(
    nextCapture(),
    { route: routeOf(input.collectionId), collection_id: input.collectionId, capture_id: input.captureId ?? null },
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
    >(identityCapture(), {
      ...parameters(identity),
      capture_id: input.captureId ?? null,
      collection_fence: fences.collectionFence,
      account_fence: fences.accountFence,
    });
    if (!capture) throw new Refused('binding');
    if (capture.complete) {
      const [proof] = await run(proofQuery(), {
        ...parameters(identity),
        capture_id: capture.captureId,
      });
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
