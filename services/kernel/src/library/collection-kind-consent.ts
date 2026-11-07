import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  KindConsentConsumer,
  KindConsentReference,
  KindConsentInvalidationInput,
  KindConsentInvalidationReceiver,
  KindConsentInvalidationResult,
  KindConsentOperation,
  KindConsentWorkDeclaration,
  KindConsentVerificationResult,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { commandTime } from '../command/command.ts';
import {
  currentOperationalResources,
  hasOperationalAdmission,
  hasLiveOperationalTransaction,
  runOperationalTransaction,
  type OperationalTransaction,
} from '../command/operational.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
import { workStepDeadline } from './collection-command-work.ts';
import accountFence from '../access/account-share.sql';
import operationalFence from '../command/operational-fence.sql';
import readTime from '../command/time.sql';
import invalidateConsumer from './collection-kind-consent-invalidate.sql';
import lockConsumer from './collection-kind-consent-lock.sql';
import verifyTransition from './collection-kind-consent-verify.sql';
import enrollConsumer from './collection-kind-consent-enroll.sql';

type Dependencies = Readonly<{ pool: Pool; workClient: WorkClient; clock?: KernelClock }>;
type ConsumerRow = (typeof lockConsumer)['~reylo']['element'];

const opaque = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.isWellFormed() &&
  Buffer.byteLength(value, 'utf8') > 0 &&
  Buffer.byteLength(value, 'utf8') <= 255 &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.isWellFormed() &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(value) &&
  Buffer.byteLength(value, 'utf8') <= maximum;

/** Parse Auth's decimal route transport back to the original native route. */
function consumerRoute(consumer: KindConsentConsumer): number | null {
  if (!consumer || typeof consumer !== 'object' || !/^(0|[1-9][0-9]*)$/.test(consumer.route)) return null;
  const route = Number(consumer.route);
  if (!Number.isSafeInteger(route) || route < 0 || route > 65535 || String(route) !== consumer.route) return null;
  if (
    routeOf(consumer.ownerAccountId) !== route ||
    routeOf(consumer.collectionId) !== route ||
    routeOf(consumer.preparationId) === null ||
    !opaque(consumer.originId)
  )
    return null;
  return route;
}

function request(input: KindConsentInvalidationInput) {
  if (
    !input ||
    input.reference?.kind !== 'auth-kind-consent' ||
    !opaque(input.reference.id) ||
    !opaque(input.transitionId)
  )
    return null;
  const route = consumerRoute(input.consumer);
  return route === null ? null : { route, consumer: input.consumer, referenceId: input.reference.id };
}

function matches(row: ConsumerRow | undefined, value: NonNullable<ReturnType<typeof request>>) {
  return (
    !!row &&
    Number(row.route) === value.route &&
    row.ownerAccountId === value.consumer.ownerAccountId &&
    row.collectionId === value.consumer.collectionId &&
    row.preparationId === value.consumer.preparationId &&
    row.originId === value.consumer.originId &&
    row.sourceGeneration !== null &&
    row.captureGeneration !== null &&
    row.sourceCapture !== null &&
    row.enrollmentGeneration !== null
  );
}

function transaction<T>(
  deps: Dependencies,
  route: number,
  ownerAccountId: string,
  deadline: number,
  admission: object,
  body: (tx: OperationalTransaction) => Promise<T>,
) {
  return runOperationalTransaction(
    deps.pool,
    {
      mode: 'work-step',
      partition: partitionOf(route),
      kind: 'library.collectionKind.consentFence',
      accounts: [ownerAccountId],
      workClient: deps.workClient,
      deadline,
      attemptLimit: 1,
      admission,
      ...(deps.clock ? { clock: deps.clock } : {}),
    },
    body,
  );
}

async function lock(tx: OperationalTransaction, route: number, referenceId: string) {
  return lockConsumer.run(tx, { route, reference_id: referenceId });
}

function consentDeadline(): number {
  return Math.min(workStepDeadline(), Date.now() + WORK_STEP_DEADLINE_MS);
}

// The literal Source-local trigger statement in the additive original-control migration.
const originalCancellation = `UPDATE library.collection_kind_audience_origin SET cancelled=true
    WHERE route=OLD.route AND origin_id=OLD.origin_id
      AND owner_account_id=OLD.owner_account_id AND collection_id=OLD.collection_id
      AND preparation_id=OLD.preparation_id`;

const emptyAccessWork = Object.freeze({ keys: 0, points: 0, witnesses: 0, rows: 0, bytes: 0, emptySeeks: 0 });
const controlStatements = Object.freeze([
  'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
  "SET LOCAL statement_timeout = '9999ms'",
  'ROLLBACK',
  'BEGIN ISOLATION LEVEL SERIALIZABLE',
  "SET LOCAL lock_timeout = '200ms'",
  "SET LOCAL statement_timeout = '9999ms'",
  "SET LOCAL statement_timeout = '9999ms'",
  'ROLLBACK',
]);

function statementBytes(sql: string, values: readonly unknown[]): number {
  return Buffer.byteLength(sql, 'utf8') + Buffer.byteLength(JSON.stringify(values), 'utf8');
}

/** The Source call is one bounded Core attempt: two checkouts, four exact keyed
 * reads, one Source statement, and the runner's fixed control statements. The
 * byte bound includes the longest five-second timeout text and each maximum
 * admitted identifier. Dispatched errors consume this entire declaration.
 */
function receiverBound(
  input: KindConsentInvalidationInput | (KindConsentInvalidationInput & { receiptReference: string }),
  operation: 'invalidate' | 'verify',
): KindConsentWorkDeclaration | undefined {
  const normalized = request(input);
  if (!normalized || (operation === 'verify' && !opaque('receiptReference' in input ? input.receiptReference : null)))
    return undefined;
  const accountRoute = routeOf(normalized.consumer.ownerAccountId);
  if (accountRoute === null) return undefined;
  const query = operation === 'invalidate' ? invalidateConsumer : verifyTransition;
  const sourceValues =
    operation === 'invalidate'
      ? [
          65535,
          'r'.repeat(255),
          normalized.consumer.ownerAccountId,
          normalized.consumer.collectionId,
          normalized.consumer.preparationId,
          normalized.consumer.originId,
          't'.repeat(255),
          '0'.repeat(36),
        ]
      : [
          65535,
          'r'.repeat(255),
          't'.repeat(255),
          '0'.repeat(255),
          normalized.consumer.ownerAccountId,
          normalized.consumer.collectionId,
          normalized.consumer.preparationId,
          normalized.consumer.originId,
        ];
  const statements = [
    [controlStatements[0]!, []],
    [controlStatements[1]!, []],
    [readTime.sql, ['9'.repeat(24)]],
    [controlStatements[2]!, []],
    [controlStatements[3]!, []],
    [controlStatements[4]!, []],
    [controlStatements[5]!, []],
    [operationalFence.sql, [4095]],
    [accountFence.sql, [accountRoute, normalized.consumer.ownerAccountId]],
    [query.sql, sourceValues],
    [controlStatements[6]!, []],
    [controlStatements[7]!, []],
  ] as const;
  return Object.freeze({
    source: Object.freeze({
      candidateKeys: operation === 'invalidate' ? 2 : 1,
      // The immutable-original cancellation trigger adds one indexed lookup and UPDATE.
      nativeRows: operation === 'invalidate' ? 9 : 5,
      identityMetadataRows: 0,
      emptySeeks: 1,
      nativePoints: operation === 'invalidate' ? 7 : 6,
      witnessKeys: 0,
      statements: statements.length + (operation === 'invalidate' ? 1 : 0),
      // Fixed time, account/fence and bounded receipt projections, including JSON escaping.
      bytes:
        statements.reduce((total, [sql, values]) => total + statementBytes(sql, values), 0) +
        4096 +
        (operation === 'invalidate' ? Buffer.byteLength(originalCancellation) : 0),
    }),
    access: emptyAccessWork,
  });
}

function operation<I extends object, R extends object>(
  boundFor: (input: I) => KindConsentWorkDeclaration | undefined,
  unfunded: R,
  dispatch: (input: I, admission: KindConsentWorkDeclaration) => Promise<R>,
): KindConsentOperation<I, R> {
  const issued = new WeakMap<I, KindConsentWorkDeclaration[]>();
  const receipts = new WeakMap<R, Readonly<{ input: I; bound: KindConsentWorkDeclaration }>>();
  const settled = new WeakSet<R>();
  const call = Object.assign(
    async (input: I): Promise<R> => {
      const reservations = issued.get(input);
      const reserved = reservations?.shift();
      if (!reservations?.length) issued.delete(input);
      if (!reserved) return unfunded;
      const declaration = boundFor(input);
      if (!declaration || !isDeepStrictEqual(reserved, declaration)) return unfunded;
      const result = await dispatch(input, reserved);
      receipts.set(result, Object.freeze({ input, bound: reserved }));
      return result;
    },
    {
      bound(input: I) {
        const declaration = boundFor(input);
        if (declaration) issued.set(input, [...(issued.get(input) ?? []), declaration]);
        return declaration;
      },
      actual(input: I, result: R) {
        const receipt = receipts.get(result);
        if (!receipt || receipt.input !== input || settled.has(result)) return undefined;
        settled.add(result);
        receipts.delete(result);
        const emptySeeks = 'status' in result && result.status === 'pending' ? 1 : 0;
        return Object.freeze({
          ...receipt.bound,
          source: Object.freeze({ ...receipt.bound.source, emptySeeks }),
        });
      },
    },
  );
  return Object.freeze(call);
}

/** Source-local invalidation shares the row lock used by adoption and restore. Auth I/O never occurs here. */
export function createCollectionKindConsentReceiver(deps: Dependencies): KindConsentInvalidationReceiver {
  return Object.freeze({
    invalidate: operation<KindConsentInvalidationInput, KindConsentInvalidationResult>(
      (input) => receiverBound(input, 'invalidate'),
      { status: 'pending' },
      async (input, admission) => {
        const normalized = request(input);
        if (!normalized) return { status: 'pending' };
        const deadline = consentDeadline();
        return transaction(
          deps,
          normalized.route,
          normalized.consumer.ownerAccountId,
          deadline,
          admission,
          async (tx) => {
            if (!hasOperationalAdmission(tx, admission) || !commandTime(tx))
              throw new TypeError('Collection Kind Source transaction has no admitted live time');
            const inserted = await invalidateConsumer.run(tx, {
              route: normalized.route,
              reference_id: normalized.referenceId,
              owner_account_id: normalized.consumer.ownerAccountId,
              collection_id: normalized.consumer.collectionId,
              preparation_id: normalized.consumer.preparationId,
              origin_id: normalized.consumer.originId,
              transition_id: input.transitionId,
              receipt_reference: randomUUID(),
            });
            return inserted
              ? { status: 'committed' as const, receiptReference: inserted.receiptReference }
              : { status: 'pending' as const };
          },
        );
      },
    ),
    verify: operation<
      KindConsentInvalidationInput & Readonly<{ receiptReference: string }>,
      KindConsentVerificationResult
    >(
      (input) => receiverBound(input, 'verify'),
      { status: 'pending' },
      async (input, admission) => {
        const normalized = request(input);
        if (!normalized || !opaque(input.receiptReference)) return { status: 'pending' };
        const deadline = consentDeadline();
        return transaction(
          deps,
          normalized.route,
          normalized.consumer.ownerAccountId,
          deadline,
          admission,
          async (tx) => {
            if (!hasOperationalAdmission(tx, admission) || !commandTime(tx))
              throw new TypeError('Collection Kind Source transaction has no admitted live time');
            const verified = await verifyTransition.run(tx, {
              route: normalized.route,
              reference_id: normalized.referenceId,
              transition_id: input.transitionId,
              receipt_reference: input.receiptReference,
              owner_account_id: normalized.consumer.ownerAccountId,
              collection_id: normalized.consumer.collectionId,
              preparation_id: normalized.consumer.preparationId,
              origin_id: normalized.consumer.originId,
            });
            return verified
              ? { status: 'verified', receiptReference: verified.receiptReference }
              : { status: 'pending' };
          },
        );
      },
    ),
  });
}

export type CollectionKindConsentEnrollment = Readonly<{
  tx: OperationalTransaction;
  consumer: KindConsentConsumer;
  reference: KindConsentReference;
  sourceGeneration: string;
  captureGeneration: string;
  sourceCapture: string;
  catalogueRoot: string;
}>;

export type CollectionKindConsentBinding = Readonly<{
  reference: KindConsentReference;
  consumer: KindConsentConsumer;
  captureGeneration: string;
  catalogueRoot: string;
}>;

/** Final admission takes the same local row lock as invalidation and does no foreign I/O. */
export async function collectionKindConsentAdoptionCurrent(
  pool: Pool,
  tx: OperationalTransaction,
  binding: CollectionKindConsentBinding,
): Promise<boolean> {
  if (
    !binding ||
    binding.reference?.kind !== 'auth-kind-consent' ||
    !opaque(binding.reference.id) ||
    !/^sha256:[0-9a-f]{64}$/.test(binding.catalogueRoot) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(binding.captureGeneration) ||
    !hasLiveOperationalTransaction(tx)
  )
    return false;
  const route = consumerRoute(binding.consumer);
  if (route === null) return false;
  const resources = currentOperationalResources(tx);
  if (
    !commandTime(tx) ||
    resources.pool !== pool ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== binding.consumer.ownerAccountId
  )
    return false;
  const row = await lock(tx, route, binding.reference.id);
  return (
    !!row &&
    matches(row, { route, consumer: binding.consumer, referenceId: binding.reference.id }) &&
    row.invalidated === false &&
    row.captureGeneration === binding.captureGeneration &&
    row.catalogueRoot === binding.catalogueRoot
  );
}

/** INSERT-only enrollment on the original live Source transaction, before any Type vote is adopted. */
export async function enrollCollectionKindConsentConsumer(
  pool: Pool,
  input: CollectionKindConsentEnrollment,
): Promise<boolean> {
  const value = request({
    reference: input.reference,
    consumer: input.consumer,
    transitionId: 'enrollment',
  });
  if (
    !value ||
    !hasLiveOperationalTransaction(input.tx) ||
    input.reference?.kind !== 'auth-kind-consent' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(input.sourceGeneration) ||
    BigInt(input.sourceGeneration) > 9_223_372_036_854_775_807n ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.captureGeneration) ||
    !boundedText(input.sourceCapture, 4096) ||
    !/^sha256:[0-9a-f]{64}$/.test(input.catalogueRoot)
  )
    return false;
  const resources = currentOperationalResources(input.tx);
  const time = commandTime(input.tx);
  if (
    !time ||
    resources.pool !== pool ||
    resources.mode !== 'work-step' ||
    resources.partition !== partitionOf(value.route) ||
    resources.accounts.length !== 1 ||
    resources.accounts[0] !== input.consumer.ownerAccountId
  )
    return false;
  const generation = randomUUID();
  const inserted = await enrollConsumer.run(input.tx, {
    route: value.route,
    reference_id: input.reference.id,
    owner_account_id: input.consumer.ownerAccountId,
    collection_id: input.consumer.collectionId,
    preparation_id: input.consumer.preparationId,
    origin_id: input.consumer.originId,
    source_generation: input.sourceGeneration,
    capture_generation: input.captureGeneration,
    source_capture: input.sourceCapture,
    enrollment_generation: generation,
    catalogue_root: input.catalogueRoot,
  });
  if (inserted) return true;
  const existing = await lock(input.tx, value.route, input.reference.id);
  return (
    !!existing &&
    matches(existing, value) &&
    existing.invalidated === false &&
    existing.sourceGeneration === input.sourceGeneration &&
    existing.captureGeneration === input.captureGeneration &&
    existing.sourceCapture === input.sourceCapture &&
    existing.catalogueRoot === input.catalogueRoot
  );
}
