import { memoizedValue } from '../memoized.ts';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  authoritativeTimeValue,
  commandTime,
  currentCommand,
  currentCommandResources,
  type CommandTransaction,
} from '../command/command.ts';
import {
  currentOperationalResources,
  hasLiveOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { classifyUnavailability } from '../access/unavailable.ts';
import { instrumentNativeCollectionWork, type NativeCollectionWork } from '../library/collection-native-work.ts';
import {
  currentCollectionKindInputAdmission,
  type CollectionKindPreparationLocator,
} from '../library/collection-kind-work-admission.ts';
import type { WorkDimensions, WorkReceipt } from '../library/contract/work-dimensions.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { identityScopeAddress } from './identity-scoped-observations.ts';
import type { IdentityNativeReceipt } from './identity-epoch-contract.ts';
import type { IdentityPrearmTicketLocator } from './identity-epoch-prearm-contract.ts';
import type { IdentityScopeObservation } from './identity-scope-types.ts';
import {
  identitySourceConsumerLibraryWork,
  type IdentitySourceConsumerMaintenanceContext,
} from './identity-source-consumer-maintenance.ts';
import { serializeIdentityValue as json } from './identity-core/index.ts';
import { withReadTransaction } from './read.ts';
import current from './identity-scope-committed-receipt-current.sql';
import repair from './identity-scope-committed-receipt-repair.sql';
import association from './identity-scope-committed-receipt-association.sql';

/** Locators only. Even the pre-arm native tuple must resolve its retained rows. */
export type IdentityScopeCommittedLocator = Readonly<{
  expected: IdentityScopeObservation;
  registration: string;
  completion:
    | Readonly<{ kind: 'initial' }>
    | Readonly<{
        kind: 'repair';
        receiving: Pick<IdentityPrearmTicketLocator, 'job' | 'pageId' | 'ordinal'> &
          Readonly<{ directoryTransactionId: string }>;
        attempt: IdentityNativeReceipt;
      }>;
}>;

export type IdentityScopeCommittedEvidence = Readonly<{
  locator: IdentityScopeCommittedLocator;
  native: IdentityNativeReceipt;
  completionRevision: bigint;
  completionVersion: bigint;
  sealDigest: string;
  sourceGeneration: string;
}>;

/** The existing Library original, already bound and admitted in this exact home.
 * Resolution borrows tx; its caller releases that home before any foreign work.
 * A later hold needs a new live admission of the SAME work and original deadline.
 */
export type IdentityScopeCommittedKindContext = Readonly<{
  kind: 'collection-kind';
  tx: OperationalTransaction;
  preparation: CollectionKindPreparationLocator;
  work: NativeCollectionWork;
  deadline: number;
}>;
export type IdentityScopeCommittedContext =
  | IdentitySourceConsumerMaintenanceContext
  | IdentityScopeCommittedKindContext;

type Refusal = Readonly<{
  status: 'unavailable';
  reason: 'work_binding' | 'source_binding' | 'not_current' | 'native_unavailable';
  /** Cumulative receipt of the SAME supplied original ledger, never a fresh allowance. */
  work: WorkReceipt | null;
}>;
export type IdentityScopeCommittedResolution =
  | Refusal
  | Readonly<{ status: 'observed'; evidence: IdentityScopeCommittedEvidence; work: WorkReceipt }>;
declare const held: unique symbol;
export type HeldIdentityScopeCommittedReceipt = Readonly<{
  status: 'held';
  evidence: IdentityScopeCommittedEvidence;
  transactionId: string | null;
  work: WorkReceipt;
  /** Runtime association is private and dies with the real source transaction. */
  [held]: true;
}>;
export type IdentityScopeCommittedVerification = Refusal | HeldIdentityScopeCommittedReceipt;

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const unsigned = /^(0|[1-9][0-9]{0,18})$/;
const maxBigint = 9223372036854775807n;
function currentLocked() {
  return memoizedValue(currentLocked, () => current.sql + '\nFOR UPDATE OF s FOR SHARE OF p,l,a,c,r,h,fc,fa');
}
function associationLocked() {
  return memoizedValue(
    associationLocked,
    () => association.sql.replace('/* capture-lock */', 'FOR SHARE OF captured,cn') + '\nFOR SHARE OF s,a,n,p',
  );
}
function repairLocked() {
  return memoizedValue(repairLocked, () => repair.sql + '\nFOR SHARE OF s,a,c,r,n,prepared');
}
const zero = (): WorkDimensions => ({
  candidateKeys: 0,
  identityMetadataRows: 0,
  nativeRows: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
  emptySeeks: 0,
});

/** Literal operation bounds, charged identically for hit, absence, repeat and failure.
 * The instrumenter pre-reserves COMMIT and ROLLBACK before BEGIN and charges checkout.
 * An unknown statement has no admission. No result row count reduces these point bounds.
 */
export function identityScopeCommittedReceiptFootprint(
  sql: string,
  values: readonly unknown[],
): WorkDimensions | undefined {
  let rows: number;
  let output: number;
  if (sql === current.sql || sql === currentLocked()) {
    rows = 12; // nine keyed rows, consumer fence, unresolved forward, active attempt
    output = 512;
  } else if (sql === association.sql || sql === associationLocked()) {
    rows = 7; // association/component, summary/partition, capture association/component, attempt probe
    output = 512;
  } else if (sql === repair.sql || sql === repairLocked()) {
    rows = 7; // six keyed native/completion rows and one partition existence point
    output = 5120; // schema-bounded 4096-byte seal plus scalar envelope
  } else if (
    sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' ||
    sql === 'COMMIT' ||
    sql === 'ROLLBACK' ||
    /^SET LOCAL statement_timeout = '[1-9][0-9]{0,15}ms'$/.test(sql)
  ) {
    rows = 0;
    output = 0;
  } else return undefined;
  return {
    ...zero(),
    nativeRows: rows,
    nativePoints: rows,
    statements: 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(json(values)) + output,
  };
}

/** Locators cross a released boundary. Validate the native/schema scalar
 * domains before either routing or reserving an SQL operation. In particular,
 * partitionOf throws for an invalid route; that is a refused locator here,
 * rather than a producer exception or an extra database probe.
 */
function boundedText(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= bytes;
}
function nativeUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
function nativeDecimal(value: unknown, minimum: bigint): value is string {
  return typeof value === 'string' && unsigned.test(value) && BigInt(value) >= minimum && BigInt(value) <= maxBigint;
}
function nativeEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}
function validNative(native: IdentityNativeReceipt): boolean {
  return (
    !!native &&
    Number.isInteger(native.partition) &&
    native.partition >= 0 &&
    native.partition <= 4095 &&
    nativeEpoch(native.epoch) &&
    typeof native.position === 'bigint' &&
    native.position > 0n &&
    native.position <= maxBigint &&
    nativeUuid(native.transactionId)
  );
}

/** Account native custody only. Explicit/public output has another owner and no inherited admission. */
function parameters(locator: IdentityScopeCommittedLocator): unknown[] | null {
  if (
    !locator?.expected?.key?.source ||
    !locator.completion ||
    (locator.completion.kind !== 'initial' && locator.completion.kind !== 'repair')
  )
    return null;
  const { expected, registration } = locator;
  const key = expected.key;
  if (
    !nativeUuid(registration) ||
    !nativeUuid(expected.captureId) ||
    !boundedText(key.scopeId, 256) ||
    typeof expected.committedRevision !== 'bigint' ||
    expected.committedRevision <= 0n ||
    expected.committedRevision > maxBigint ||
    key.source.kind !== 'library'
  )
    return null;
  const i = key.source.identity;
  if (!i || (i.scope !== 'curated' && i.scope !== 'private_builtin')) return null;
  // UUID route equality also validates the integer route domain before partitionOf.
  const collectionRoute = routeOf(i.collectionId);
  const accountRoute = routeOf(i.accountId);
  if (
    collectionRoute === null ||
    collectionRoute !== i.route ||
    accountRoute === null ||
    partitionOf(accountRoute) !== partitionOf(collectionRoute) ||
    !nativeEpoch(i.ownerEpoch) ||
    !boundedText(i.incarnation, 128) ||
    !nativeDecimal(i.generation, 0n) ||
    !nativeDecimal(i.receivingEpoch, 1n) ||
    !boundedText(i.effectKey, 256)
  )
    return null;
  const source = json(key.source);
  if (Buffer.byteLength(source) > 4096) return null;
  const address = identityScopeAddress(key);
  if (locator.completion.kind === 'repair') {
    const { receiving, attempt } = locator.completion;
    if (
      !validNative(attempt) ||
      !receiving?.job ||
      !nativeUuid(receiving.directoryTransactionId) ||
      !nativeUuid(receiving.job.jobId) ||
      typeof receiving.job.epoch !== 'bigint' ||
      receiving.job.epoch <= 0n ||
      receiving.job.epoch > maxBigint ||
      !boundedText(receiving.pageId, 256) ||
      !Number.isSafeInteger(receiving.ordinal) ||
      receiving.ordinal < 0 ||
      receiving.ordinal > 2147483647
    )
      return null;
  }
  return [
    address.partition,
    address.source,
    address.scope,
    registration,
    expected.captureId,
    expected.committedRevision.toString(),
    source,
    i.ownerEpoch,
    i.route,
    i.collectionId,
    accountRoute,
    i.accountId,
    i.incarnation,
    i.generation,
    i.scope,
    i.receivingEpoch,
    i.effectKey,
  ];
}

type CompletionRow = {
  epoch: number;
  position: string;
  transaction_id: string;
  version: string;
  seal: object;
  source_generation: string;
  completion_revision: string;
};
type HeadRow = { registration: string; capture_id: string; revision: string; state: string };
const digestSeal = (seal: object): string => createHash('sha256').update(canonicalize(seal)!).digest('hex');
function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

async function read(
  tx: CommandTransaction,
  locator: IdentityScopeCommittedLocator,
  values: unknown[],
  lock: boolean,
  admission?: Readonly<{ work: NativeCollectionWork; current(): boolean }>,
): Promise<IdentityScopeCommittedEvidence | null> {
  const query = async <Row extends QueryResultRow>(sql: string, args: unknown[]) => {
    if (!admission) return tx.query<Row>(sql, args);
    let reservation: ReturnType<NativeCollectionWork['reserve']>;
    try {
      reservation = admission.work.reserve(
        admission.current() ? identityScopeCommittedReceiptFootprint(sql, args) : undefined,
      );
      reservation.dispatch();
    } catch (error) {
      admission.work.failure = error instanceof Error ? error : new Error('Identity receipt admission ended');
      throw error;
    }
    try {
      return await reservation.query(() => tx.query<Row>(sql, args));
    } finally {
      reservation.settle();
    }
  };
  const row = (await query<HeadRow>(lock ? currentLocked() : current.sql, values)).rows[0];
  if (!row) return null;
  // Ready is its own real native command, including after a completed repair.
  // Read-only replay never mints or repairs a historical missing association.
  const ready =
    row.state === 'ready'
      ? (
          await query<Pick<CompletionRow, 'epoch' | 'position' | 'transaction_id' | 'completion_revision'>>(
            lock ? associationLocked() : association.sql,
            [...values.slice(0, 7), locator.completion.kind === 'initial'],
          )
        ).rows[0]
      : undefined;
  if (row.state === 'ready' && !ready) return null;
  if (locator.completion.kind === 'initial') {
    if (!ready) return null;
    return freezeTree({
      locator,
      native: {
        partition: Number(values[0]),
        epoch: ready.epoch,
        position: BigInt(ready.position),
        transactionId: ready.transaction_id,
      },
      completionRevision: BigInt(ready.completion_revision),
      completionVersion: 0n,
      sealDigest: digestSeal({ phase: 'ready', ...ready }),
      sourceGeneration: String(values[13]),
    });
  }
  const { receiving, attempt } = locator.completion;
  const completed = (
    await query<CompletionRow>(lock ? repairLocked() : repair.sql, [
      ...values.slice(0, 7),
      receiving.job.jobId,
      receiving.job.epoch.toString(),
      json(attempt),
      receiving.directoryTransactionId,
      receiving.pageId,
      receiving.ordinal,
      values[13],
      values[7],
    ])
  ).rows[0];
  if (!completed) return null;
  return freezeTree({
    locator,
    native: Object.freeze({
      partition: Number(values[0]),
      epoch: (ready ?? completed).epoch,
      position: BigInt((ready ?? completed).position),
      transactionId: (ready ?? completed).transaction_id,
    }),
    completionRevision: BigInt(completed.completion_revision),
    completionVersion: BigInt(completed.version),
    sealDigest: digestSeal(completed.seal),
    sourceGeneration: completed.source_generation,
  });
}

function refuse(reason: Refusal['reason'], work: NativeCollectionWork | null): Refusal {
  return { status: 'unavailable', reason, work: work?.receipt() ?? null };
}

function isKindContext(context: IdentityScopeCommittedContext): context is IdentityScopeCommittedKindContext {
  return 'kind' in context && context.kind === 'collection-kind';
}

function snapshotContext(context: IdentityScopeCommittedContext): IdentityScopeCommittedContext {
  return isKindContext(context)
    ? Object.freeze({ ...context, preparation: Object.freeze({ ...context.preparation }) })
    : Object.freeze({ ...context });
}

function kindAdmission(pool: Pool, context: IdentityScopeCommittedKindContext) {
  const admission = currentCollectionKindInputAdmission(context.tx, context.preparation, context.work);
  if (admission?.pool !== pool || admission.deadline !== context.deadline) return undefined;
  try {
    context.work.assertReady();
    return admission;
  } catch {
    return undefined;
  }
}

function originalWork(pool: Pool, context: IdentityScopeCommittedContext): NativeCollectionWork | null {
  if (isKindContext(context)) return kindAdmission(pool, context) ? context.work : null;
  return identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline);
}

/** Compare owner-admitted operands, without creating a second admission or allowance. */
function kindSourceBound(
  pool: Pool,
  context: IdentityScopeCommittedKindContext,
  locator: IdentityScopeCommittedLocator,
): boolean {
  const admission = kindAdmission(pool, context);
  const source = locator.expected.key.source;
  return (
    !!admission &&
    source.kind === 'library' &&
    isDeepStrictEqual(source.identity, admission.sourceIdentity) &&
    locator.expected.captureId === admission.custody.captureId
  );
}

/** Maintenance owns a released snapshot. Kind borrows its admitted home, which
 * the caller must release before foreign work. Neither result is a held verification.
 */
export async function resolveCommittedIdentityScopeReceipt(
  pool: Pool,
  input: Readonly<{ locator: IdentityScopeCommittedLocator; context: IdentityScopeCommittedContext }>,
): Promise<IdentityScopeCommittedResolution> {
  const context = snapshotContext(input.context);
  const work = originalWork(pool, context);
  if (!work) return refuse('work_binding', null);
  const locator = structuredClone(input.locator);
  const values = parameters(locator);
  if (!values) return refuse('source_binding', work);
  try {
    if (isKindContext(context)) {
      const current = () =>
        kindSourceBound(pool, context, locator) && liveHome(context.tx, pool, locator, context.deadline);
      if (!current()) return refuse('source_binding', work);
      const evidence = await read(context.tx, locator, values, false, { work, current });
      work.assertReady();
      return evidence && current()
        ? { status: 'observed', evidence, work: work.receipt() }
        : refuse('not_current', work);
    }
    const evidence = await instrumentNativeCollectionWork(
      pool,
      work,
      (sql, args) =>
        identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, context.deadline) === work
          ? identityScopeCommittedReceiptFootprint(sql, args)
          : undefined,
      () => withReadTransaction(pool, (tx) => read(tx, locator, values, false), context.deadline),
    );
    return evidence ? { status: 'observed', evidence, work: work.receipt() } : refuse('not_current', work);
  } catch (error) {
    if (work.failure || classifyUnavailability(error)) return refuse('native_unavailable', work);
    throw error;
  }
}

function liveHome(
  tx: CommandTransaction,
  pool: Pool,
  locator: IdentityScopeCommittedLocator,
  deadline: number,
): boolean {
  try {
    const time = commandTime(tx);
    if (!time) return false;
    authoritativeTimeValue(time);
    const { partition } = identityScopeAddress(locator.expected.key);
    if (hasLiveOperationalTransaction(tx)) {
      const resources = currentOperationalResources(tx);
      const source = locator.expected.key.source;
      return (
        source.kind === 'library' &&
        source.identity.scope !== 'public_output' &&
        resources.pool === pool &&
        resources.partition === partition &&
        resources.mode === 'work-step' &&
        resources.accounts.length === 1 &&
        resources.accounts[0] === source.identity.accountId &&
        deadline <= resources.deadline &&
        Date.now() < deadline
      );
    }
    const command = currentCommand(tx);
    const resources = currentCommandResources(tx);
    return (
      resources.pool === pool &&
      command.partition === partition &&
      deadline <= resources.deadline &&
      Date.now() < deadline
    );
  } catch {
    return false;
  }
}

const holds = new WeakMap<
  object,
  {
    tx: CommandTransaction;
    pool: Pool;
    context: IdentityScopeCommittedContext;
    work: NativeCollectionWork;
    locator: IdentityScopeCommittedLocator;
  }
>();

/** Repeats resolution under actual local row locks. Locks belong to the caller's
 * genuine source-home transaction through COMMIT/ROLLBACK. No checkout or foreign IO.
 */
export async function holdCommittedIdentityScopeReceipt(
  tx: CommandTransaction,
  pool: Pool,
  input: Readonly<{ evidence: IdentityScopeCommittedEvidence; context: IdentityScopeCommittedContext }>,
): Promise<IdentityScopeCommittedVerification> {
  const context = snapshotContext(input.context);
  const work = originalWork(pool, context);
  if (!work) return refuse('work_binding', null);
  const expected = structuredClone(input.evidence);
  const values = parameters(expected.locator);
  if (!values || !liveHome(tx, pool, expected.locator, context.deadline)) return refuse('source_binding', work);
  if (isKindContext(context) && (context.tx !== tx || !kindSourceBound(pool, context, expected.locator)))
    return refuse('source_binding', work);
  try {
    const current = () =>
      originalWork(pool, context) === work &&
      liveHome(tx, pool, expected.locator, context.deadline) &&
      (!isKindContext(context) || kindSourceBound(pool, context, expected.locator));
    const evidence = isKindContext(context)
      ? await read(tx, expected.locator, values, true, { work, current })
      : await instrumentNativeCollectionWork(
          pool,
          work,
          (sql, args) => (current() ? identityScopeCommittedReceiptFootprint(sql, args) : undefined),
          () => read(tx, expected.locator, values, true),
          tx as PoolClient,
        );
    work.assertReady();
    if (!evidence || !isDeepStrictEqual(evidence, expected) || !current()) return refuse('not_current', work);
    const result = Object.freeze({
      status: 'held' as const,
      evidence,
      transactionId: hasLiveOperationalTransaction(tx) ? null : currentCommand(tx).transactionId,
      work: work.receipt(),
    }) as HeldIdentityScopeCommittedReceipt;
    holds.set(result, {
      tx,
      pool,
      context: Object.freeze({ ...context }),
      work,
      locator: structuredClone(evidence.locator),
    });
    return result;
  } catch (error) {
    if (work.failure || classifyUnavailability(error)) return refuse('native_unavailable', work);
    throw error;
  }
}

/** Tests transaction lifetime, not permission. Observed/copy/foreign/released values refuse. */
export function isHeldCommittedIdentityScopeReceipt(tx: CommandTransaction, value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const binding = holds.get(value);
  return (
    !!binding &&
    binding.tx === tx &&
    !binding.work.failure &&
    liveHome(tx, binding.pool, binding.locator, binding.context.deadline) &&
    originalWork(binding.pool, binding.context) === binding.work &&
    (!isKindContext(binding.context) || kindSourceBound(binding.pool, binding.context, binding.locator))
  );
}
