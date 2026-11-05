import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import {
  currentCommand,
  currentCommandResources,
  hasLiveCommandTransaction,
  registerCommandCallback,
  type CommandTransaction,
} from '../command/command.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import * as semanticPublicCapture from '../semantic/identity-scoped-public-source.ts';
import { observeNativePublicCollectionOutput, type CanonicalRangeKey } from './collection-source-native.ts';
import type { CollectionOutputPublication } from './collection-source-output.ts';
import { NativeCollectionWork, instrumentNativeCollectionWork } from '../work-ledger/native-collection-work.ts';
import type { NativePublicOutputIdentity } from './native-source-output-types.ts';
import type {
  LockPublicOutputDisposition,
  LockedPublicOutputDisposition,
  NativePublicOutputBinding,
  PublicOutputBindingSelection,
  PublicOutputCommandContext,
  PublicOutputDispositionSelection,
  PublicOutputPage,
  PublicOutputRefusal,
  PublicOutputTuple,
  PublicOutputWork,
} from './native-public-output-contract.ts';
import {
  nativePublicOutputClient,
  nativePublicOutputFootprint,
  publicOutputXidSQL,
} from './native-public-output-work.ts';
import ownerSQL from './native-public-output-owner.sql';
import lifecycleSQL from './native-public-output-lifecycle.sql';
import publicationSQL from './native-public-output-publication-lock.sql';
import bindingSQL from './native-public-output-binding.sql';
import bindingLockSQL from './native-public-output-binding-lock.sql';
import identitySQL from './native-public-output-identity.sql';
import provenanceSQL from './native-public-output-provenance.sql';
import xminSQL from './native-public-output-binding-xmin.sql';
import bindSQL from './native-public-output-bind.sql';
import receivingSQL from './native-public-output-receiving.sql';
import holdSQL from './native-public-output-hold.sql';
import pageSQL from './collection-source-output-page.sql';
import transitionReadSQL from './native-public-output-transition-read.sql';
import transitionSQL from './native-public-output-transition.sql';
import consumeSQL from './native-public-output-consume.sql';
import fenceSQL from './native-public-output-fence.sql';
import retainedSQL from './native-public-output-retained.sql';

type Client = Pick<PoolClient, 'query'>;
type Owner = { accountId: string; incarnation: string; epoch: number; position: string };
type BindingRow = {
  payload: unknown;
  bindingDigest: string;
  nativeXid: string;
  transactionId: string;
  epoch: number;
  position: string;
  receivingEpoch: string;
  state: 'open' | 'applied' | 'cancelled';
  consumedBy: string | null;
};
type Stored = { binding: NativePublicOutputBinding; row: BindingRow };
const digestPattern = /^[0-9a-f]{64}$/;
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const decimal = /^(?:0|[1-9][0-9]*)$/;
const missingDisposition = 'semantic/identity-scoped-public-source.ts:lockPublicIdentityOutputCaptureDisposition';
const unavailable = () => new ProblemError('dependency_unavailable');
const json = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(json(value))!)
    .digest('hex');
function bindingDigest(binding: Omit<NativePublicOutputBinding, 'bindingDigest'>): string {
  return digest(binding);
}
function validReceipt(receipt: IdentityNativeReceipt) {
  return (
    receipt &&
    Number.isSafeInteger(receipt.partition) &&
    receipt.partition >= 0 &&
    receipt.partition < 4096 &&
    Number.isSafeInteger(receipt.epoch) &&
    receipt.epoch >= 0 &&
    typeof receipt.position === 'bigint' &&
    receipt.position > 0n &&
    uuidPattern.test(receipt.transactionId)
  );
}
function validIdentity(identity: NativePublicOutputIdentity) {
  return (
    identity &&
    identity.scope === 'public_output' &&
    routeOf(identity.collectionId) === identity.route &&
    typeof identity.incarnation === 'string' &&
    Buffer.byteLength(identity.incarnation) <= 128 &&
    decimal.test(identity.generation) &&
    decimal.test(identity.receivingEpoch) &&
    Number.isSafeInteger(identity.ownerEpoch) &&
    identity.ownerEpoch >= 0 &&
    digestPattern.test(identity.effectKey) &&
    uuidPattern.test(identity.outputGeneration) &&
    identity.activation &&
    uuidPattern.test(identity.activation.transactionId) &&
    decimal.test(identity.activation.position) &&
    BigInt(identity.activation.position) > 0n &&
    decimal.test(identity.activation.sourceGeneration)
  );
}
function validateIdentity(identity: NativePublicOutputIdentity) {
  if (!validIdentity(identity)) throw new TypeError('Invalid native public output identity');
}
function decodeBinding(payload: unknown): NativePublicOutputBinding {
  const value = payload as NativePublicOutputBinding;
  if (!value || !value.tuple || !value.accepted) throw unavailable();
  const binding: NativePublicOutputBinding = {
    ...value,
    accepted: { ...value.accepted, position: BigInt(value.accepted.position) },
    tuple: {
      ...value.tuple,
      observation: {
        ...value.tuple.observation,
        position: BigInt(value.tuple.observation.position),
      },
    },
  };
  const { bindingDigest: expected, ...body } = binding;
  if (
    !uuidPattern.test(binding.captureId) ||
    !uuidPattern.test(binding.holdId) ||
    !digestPattern.test(binding.definitionDigest) ||
    !validIdentity(binding.tuple.identity) ||
    !validReceipt(binding.accepted) ||
    expected !== bindingDigest(body) ||
    binding.accepted.partition !== partitionOf(binding.tuple.identity.route) ||
    binding.accepted.epoch !== binding.tuple.identity.ownerEpoch
  )
    throw unavailable();
  return binding;
}
function refusal(
  work: NativeCollectionWork,
  status: PublicOutputRefusal['status'] = 'unavailable',
  dependency?: string,
): PublicOutputRefusal {
  return { status, ...(dependency ? { dependency } : {}), work: work.receipt() };
}
async function frame<T>(options: PublicOutputWork, operation: (work: NativeCollectionWork) => Promise<T>): Promise<T> {
  const work = new NativeCollectionWork(options.allowance, options.deadline);
  try {
    return await operation(work);
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}
function command(tx: CommandTransaction, context: PublicOutputCommandContext, home?: number) {
  if (!hasLiveCommandTransaction(tx)) throw unavailable();
  const current = currentCommand(tx),
    resources = currentCommandResources(tx);
  if (
    resources.pool !== context.pool ||
    current.time !== context.at ||
    context.deadline > resources.deadline ||
    (home !== undefined && current.partition !== home)
  )
    throw unavailable();
  return current;
}
async function owner(client: Client, route: number, collectionId: string): Promise<Owner | null> {
  return (await client.query<Owner>(ownerSQL.sql, [route, collectionId])).rows[0] ?? null;
}
async function load(client: Client, partition: number, captureId: string, lock: boolean): Promise<Stored | null> {
  const row = (await client.query<BindingRow>((lock ? bindingLockSQL : bindingSQL).sql, [partition, captureId]))
    .rows[0];
  if (!row) return null;
  const binding = decodeBinding(row.payload);
  if (
    binding.bindingDigest !== row.bindingDigest ||
    binding.accepted.transactionId !== row.transactionId ||
    binding.accepted.epoch !== row.epoch ||
    binding.accepted.position.toString() !== row.position
  )
    throw unavailable();
  return { binding, row };
}
async function committed(client: Client, stored: Stored): Promise<boolean> {
  const b = stored.binding,
    r = stored.row;
  const xmin = (await client.query<{ xmin: string }>(xminSQL.sql, [b.accepted.partition, b.captureId])).rows[0]?.xmin;
  return (
    xmin !== undefined &&
    (
      await client.query(provenanceSQL.sql, [
        b.accepted.partition,
        b.accepted.transactionId,
        b.accepted.epoch,
        b.accepted.position.toString(),
        'identity-public-output-capture',
        xmin,
        r.nativeXid,
      ])
    ).rows.length === 1
  );
}
function open(stored: Stored) {
  return (
    stored.row.state === 'open' &&
    stored.row.consumedBy === null &&
    stored.row.receivingEpoch === stored.binding.tuple.identity.receivingEpoch
  );
}
async function byIdentity(client: Client, identity: NativePublicOutputIdentity, lock: boolean): Promise<Stored | null> {
  const capture = (
    await client.query<{ captureId: string }>(identitySQL.sql, [
      identity.route,
      identity.collectionId,
      identity.effectKey,
    ])
  ).rows[0];
  if (!capture) return null;
  const stored = await load(client, partitionOf(identity.route), capture.captureId, lock);
  return stored && isDeepStrictEqual(stored.binding.tuple.identity, identity) ? stored : null;
}
async function currentTuple(
  client: Client,
  stored: Stored,
  work: NativeCollectionWork,
  lock: boolean,
): Promise<PublicOutputTuple | null> {
  if (!open(stored)) return null;
  const expected = stored.binding.tuple,
    id = expected.identity;
  const metadata = await observeNativePublicCollectionOutput(client, id, work);
  if (
    !metadata ||
    metadata.incarnation !== id.incarnation ||
    metadata.sourceGeneration !== id.generation ||
    metadata.stamp.epoch !== id.ownerEpoch ||
    metadata.stamp.partition !== stored.binding.accepted.partition ||
    metadata.outputGeneration !== id.outputGeneration ||
    !metadata.outputPublication ||
    !isDeepStrictEqual(metadata.outputPublication, expected.publication) ||
    routeOf(metadata.curatorAccountId!) !== id.route
  )
    return null;
  if (!(await client.query(lifecycleSQL.sql, [id.route, metadata.curatorAccountId])).rows.length) return null;
  if (lock) {
    const publication = (
      await client.query<CollectionOutputPublication>(publicationSQL.sql, [id.route, id.collectionId, id.generation])
    ).rows[0];
    if (!isDeepStrictEqual(publication, expected.publication)) return null;
  }
  return { identity: id, publication: metadata.outputPublication, observation: metadata.stamp };
}

/** One public RR snapshot contains observation, committed native binding and the entire raw page. */
export async function readNativePublicCollectionOutput(
  pool: Pool,
  identity: NativePublicOutputIdentity,
  options: PublicOutputWork & Readonly<{ after: CanonicalRangeKey | null; limit: number }>,
): Promise<PublicOutputPage> {
  return frame(options, (work) => {
    validateIdentity(identity);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)
      throw new RangeError('Native output limit must be 1..100');
    const after = options.after;
    if (
      after &&
      (after.driver !== 'output' || after.factId !== after.storedSubjectId || routeOf(after.storedSubjectId) === null)
    )
      throw new ProblemError('invalid_cursor');
    return instrumentNativeCollectionWork(
      pool,
      work,
      (sql, values) => nativePublicOutputFootprint(sql, values, work),
      () =>
        withConnection(pool, async (client) => {
          const metered = nativePublicOutputClient(client, work, options.deadline);
          await metered.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const stored = await byIdentity(metered, identity, false);
            let result: PublicOutputPage;
            if (!stored || !(await committed(metered, stored))) result = refusal(work);
            else {
              const tuple = await currentTuple(metered, stored, work, false);
              if (!tuple) result = refusal(work, 'changed');
              else {
                const rows = (
                  await metered.query<{ storedSubjectId: string; factId: string }>(pageSQL.sql, [
                    identity.route,
                    identity.collectionId,
                    identity.outputGeneration,
                    after?.storedSubjectId ?? '00000000-0000-0000-0000-000000000000',
                    options.limit,
                  ])
                ).rows.map((row) => ({ driver: 'output' as const, ...row }));
                result = {
                  status: 'ready',
                  tuple,
                  rows,
                  after: rows.at(-1) ?? after,
                  exhausted: rows.length < options.limit,
                  work: work.receipt(),
                };
              }
            }
            await metered.query('COMMIT');
            return { ...result, work: work.receipt() };
          } catch (error) {
            try {
              await metered.query('ROLLBACK');
            } catch (cleanup) {
              discardConnection(
                client,
                cleanup instanceof Error ? cleanup : new Error('Native public output rollback failed'),
              );
            }
            throw error;
          }
        }),
    );
  });
}

export async function lockNativePublicCollectionOutput(
  tx: CommandTransaction,
  identity: NativePublicOutputIdentity,
  context: PublicOutputCommandContext,
): Promise<
  | PublicOutputRefusal
  | Readonly<{ status: 'locked'; tuple: PublicOutputTuple; work: import('./collection-source.ts').WorkReceipt }>
> {
  return frame(context, async (work) => {
    validateIdentity(identity);
    command(tx, context, partitionOf(identity.route));
    const client = nativePublicOutputClient(tx, work, context.deadline);
    const current = await owner(client, identity.route, identity.collectionId);
    if (!current || current.epoch !== identity.ownerEpoch || current.incarnation !== identity.incarnation)
      return refusal(work, 'changed');
    const stored = await byIdentity(client, identity, true);
    if (!stored || !(await committed(client, stored))) return refusal(work);
    const tuple = await currentTuple(client, stored, work, true);
    return tuple ? { status: 'locked', tuple, work: work.receipt() } : refusal(work, 'changed');
  });
}

export async function bindAndHoldNativePublicCollectionOutput(
  tx: CommandTransaction,
  selection: PublicOutputBindingSelection,
  context: PublicOutputCommandContext,
): Promise<
  | PublicOutputRefusal
  | Readonly<{
      status: 'bound';
      binding: NativePublicOutputBinding;
      work: import('./collection-source.ts').WorkReceipt;
    }>
> {
  const ref = selection.publication;
  return frame(context, async (work) => {
    if (
      !uuidPattern.test(selection.captureId) ||
      !digestPattern.test(selection.definitionDigest) ||
      routeOf(ref.collectionId) !== ref.route ||
      !uuidPattern.test(ref.generation) ||
      !ref.activation ||
      !uuidPattern.test(ref.activation.transactionId) ||
      !decimal.test(ref.activation.position) ||
      !decimal.test(ref.activation.sourceGeneration)
    )
      throw new TypeError('Invalid public output binding selection');
    const current = command(tx, context, partitionOf(ref.route));
    const client = nativePublicOutputClient(tx, work, context.deadline);
    const original = await owner(client, ref.route, ref.collectionId);
    if (!original) return refusal(work);
    const existing = await load(client, current.partition, selection.captureId, true);
    if (existing) {
      const b = existing.binding,
        id = b.tuple.identity;
      if (
        b.definitionDigest !== selection.definitionDigest ||
        id.route !== ref.route ||
        id.collectionId !== ref.collectionId ||
        id.outputGeneration !== ref.generation ||
        !isDeepStrictEqual(id.activation, ref.activation)
      )
        return refusal(work, 'changed');
      const xid = (await client.query<{ xid: string }>(publicOutputXidSQL)).rows[0]!.xid;
      const stagedHere = b.accepted.transactionId === current.transactionId && existing.row.nativeXid === xid;
      if (!stagedHere && !(await committed(client, existing))) return refusal(work);
      if (!(await currentTuple(client, existing, work, true))) return refusal(work, 'changed');
      return { status: 'bound', binding: b, work: work.receipt() };
    }
    if (!(await client.query(lifecycleSQL.sql, [ref.route, original.accountId])).rows.length)
      return refusal(work, 'changed');
    const metadata = await observeNativePublicCollectionOutput(client, ref, work);
    if (
      !metadata ||
      metadata.incarnation !== original.incarnation ||
      metadata.stamp.epoch !== original.epoch ||
      routeOf(metadata.curatorAccountId!) !== ref.route ||
      metadata.outputGeneration !== ref.generation
    )
      return refusal(work, 'changed');
    const publication = (
      await client.query<CollectionOutputPublication>(publicationSQL.sql, [
        ref.route,
        ref.collectionId,
        metadata.sourceGeneration,
      ])
    ).rows[0];
    if (
      !publication ||
      !isDeepStrictEqual(publication, metadata.outputPublication) ||
      publication.transactionId !== ref.activation.transactionId ||
      publication.position !== ref.activation.position ||
      publication.sourceGeneration !== ref.activation.sourceGeneration
    )
      return refusal(work, 'changed');
    const accepted: IdentityNativeReceipt = {
      partition: current.partition,
      epoch: original.epoch,
      position: BigInt(original.position) + 1n,
      transactionId: current.transactionId,
    };
    const holdId = randomUUID();
    const effectKey = digest({ captureId: selection.captureId, holdId, accepted, publication, receivingEpoch: '1' });
    const identity: NativePublicOutputIdentity = {
      scope: 'public_output',
      route: ref.route,
      collectionId: ref.collectionId,
      incarnation: metadata.incarnation,
      generation: metadata.sourceGeneration,
      ownerEpoch: original.epoch,
      receivingEpoch: '1',
      effectKey,
      outputGeneration: publication.generation,
      activation: { ...ref.activation },
    };
    const body = {
      captureId: selection.captureId,
      holdId,
      definitionDigest: selection.definitionDigest,
      tuple: { identity, publication, observation: metadata.stamp },
      accepted,
    };
    const binding: NativePublicOutputBinding = { ...body, bindingDigest: bindingDigest(body) };
    await client.query(bindSQL.sql, [
      ref.route,
      ref.collectionId,
      binding.captureId,
      holdId,
      identity.incarnation,
      identity.outputGeneration,
      identity.activation.transactionId,
      identity.activation.position,
      identity.activation.sourceGeneration,
      accepted.epoch,
      accepted.position.toString(),
      accepted.transactionId,
      effectKey,
      binding.definitionDigest,
      binding.bindingDigest,
      json(binding),
    ]);
    await client.query(receivingSQL.sql, [accepted.partition, binding.captureId]);
    await client.query(holdSQL.sql, [
      accepted.partition,
      binding.captureId,
      holdId,
      accepted.transactionId,
      'predecessor',
    ]);
    // No SQL or receipt manufacture here. Deferred constraints, charged above, require the actual
    // Semantic capture component/outbox in this very transaction, which its producer must register.
    registerCommandCallback(tx, (transactionId) => {
      if (transactionId !== binding.accepted.transactionId) throw unavailable();
    });
    return { status: 'bound', binding, work: work.receipt() };
  });
}

export async function revalidateNativePublicCollectionOutputHold(
  tx: CommandTransaction,
  binding: NativePublicOutputBinding,
  context: PublicOutputCommandContext,
): Promise<
  | PublicOutputRefusal
  | Readonly<{
      status: 'locked';
      binding: NativePublicOutputBinding;
      work: import('./collection-source.ts').WorkReceipt;
    }>
> {
  return frame(context, async (work) => {
    const selected = decodeBinding(json(binding));
    const id = selected.tuple.identity;
    command(tx, context, partitionOf(id.route));
    const client = nativePublicOutputClient(tx, work, context.deadline);
    const original = await owner(client, id.route, id.collectionId);
    if (!original || original.epoch !== id.ownerEpoch || original.incarnation !== id.incarnation)
      return refusal(work, 'changed');
    const stored = await load(client, selected.accepted.partition, selected.captureId, true);
    if (!stored || !isDeepStrictEqual(stored.binding, selected) || !(await committed(client, stored)))
      return refusal(work);
    return (await currentTuple(client, stored, work, true))
      ? { status: 'locked', binding: stored.binding, work: work.receipt() }
      : refusal(work, 'changed');
  });
}

/** Resolve the ACTUAL Semantic owner export. There is no stand-in implementation or proof callback. */
async function disposition(
  tx: CommandTransaction,
  selection: PublicOutputDispositionSelection,
  context: PublicOutputCommandContext,
  work: NativeCollectionWork,
): Promise<PublicOutputRefusal | LockedPublicOutputDisposition> {
  const native: unknown = Reflect.get(semanticPublicCapture, 'lockPublicIdentityOutputCaptureDisposition');
  if (typeof native !== 'function') return refusal(work, 'unavailable', missingDisposition);
  return work.compose((allowance) => (native as LockPublicOutputDisposition)(tx, selection, { ...context, allowance }));
}
function selectedDisposition(
  selection: PublicOutputDispositionSelection,
  resolved: LockedPublicOutputDisposition,
  binding: NativePublicOutputBinding,
) {
  return (
    resolved.status === 'locked' &&
    isDeepStrictEqual(resolved.binding, binding) &&
    selection.captureId === binding.captureId &&
    selection.holdId === binding.holdId &&
    selection.bindingDigest === binding.bindingDigest &&
    validReceipt(resolved.disposition) &&
    isDeepStrictEqual(selection.disposition, resolved.disposition) &&
    ((resolved.kind === 'applied' &&
      resolved.purpose === 'identity-public-output-applied' &&
      digestPattern.test(resolved.manifestDigest) &&
      validReceipt(resolved.seal) &&
      uuidPattern.test(resolved.successorHoldId) &&
      resolved.successorHoldId !== binding.holdId &&
      isDeepStrictEqual(resolved.transfer, resolved.disposition)) ||
      (resolved.kind === 'cancelled' &&
        resolved.purpose === 'identity-public-output-cancelled' &&
        resolved.cancellationEpoch === (BigInt(binding.tuple.identity.receivingEpoch) + 1n).toString() &&
        isDeepStrictEqual(resolved.cancellation, resolved.disposition)))
  );
}
type TransitionRow = {
  payload: unknown;
  transactionId: string;
  nativeXid: string;
  xmin: string;
  epoch: number;
  position: string;
};

async function transition(
  tx: CommandTransaction,
  selection: PublicOutputDispositionSelection,
  context: PublicOutputCommandContext,
  kind: 'applied' | 'cancelled',
) {
  return frame(context, async (work) => {
    if (
      !uuidPattern.test(selection.captureId) ||
      !uuidPattern.test(selection.holdId) ||
      !digestPattern.test(selection.bindingDigest) ||
      !validReceipt(selection.disposition)
    )
      throw new TypeError('Invalid public output disposition selection');
    const current = command(tx, context, selection.disposition.partition);
    if (typeof Reflect.get(semanticPublicCapture, 'lockPublicIdentityOutputCaptureDisposition') !== 'function')
      return refusal(work, 'unavailable', missingDisposition);
    const client = nativePublicOutputClient(tx, work, context.deadline);
    // Locate first, then lock the original owner BEFORE locking or consuming custody.
    const located = await load(client, current.partition, selection.captureId, false);
    if (!located) return refusal(work);
    const id = located.binding.tuple.identity;
    const original = await owner(client, id.route, id.collectionId);
    if (!original || original.epoch !== id.ownerEpoch || original.incarnation !== id.incarnation)
      return refusal(work, 'changed');
    const stored = await load(client, current.partition, selection.captureId, true);
    if (
      !stored ||
      stored.binding.holdId !== selection.holdId ||
      stored.binding.bindingDigest !== selection.bindingDigest ||
      !(await committed(client, stored))
    )
      return refusal(work);
    const resolved = await disposition(tx, selection, context, work);
    if (resolved.status !== 'locked') return { ...resolved, work: work.receipt() };
    if (!selectedDisposition(selection, resolved, stored.binding) || resolved.kind !== kind) return refusal(work);
    const previous = (await client.query<TransitionRow>(transitionReadSQL.sql, [current.partition, selection.holdId]))
      .rows[0];
    if (previous) {
      if (resolved.provenance !== 'committed') return refusal(work);
      const expected = json({ ...resolved, work: undefined, provenance: undefined });
      if (!isDeepStrictEqual(previous.payload, expected)) return refusal(work, 'changed');
      const receipt = {
        partition: current.partition,
        epoch: previous.epoch,
        position: BigInt(previous.position),
        transactionId: previous.transactionId,
      };
      if (
        !isDeepStrictEqual(receipt, selection.disposition) ||
        !(
          await client.query(provenanceSQL.sql, [
            receipt.partition,
            receipt.transactionId,
            receipt.epoch,
            receipt.position.toString(),
            resolved.purpose,
            previous.xmin,
            previous.nativeXid,
          ])
        ).rows.length
      )
        return refusal(work);
      return resolved.kind === 'applied'
        ? {
            status: 'transferred' as const,
            successorHoldId: resolved.successorHoldId,
            transfer: receipt,
            work: work.receipt(),
          }
        : { status: 'released' as const, release: receipt, work: work.receipt() };
    }
    if (!(await client.query(retainedSQL.sql, [current.partition, selection.captureId])).rows.length)
      return refusal(work);
    // A different uncommitted command, a released pre-transfer disposition, or merely a seal cannot consume custody.
    const receipt: IdentityNativeReceipt = {
      partition: current.partition,
      epoch: original.epoch,
      position: BigInt(original.position) + 1n,
      transactionId: current.transactionId,
    };
    if (!open(stored) || resolved.provenance !== 'staged' || !isDeepStrictEqual(resolved.disposition, receipt))
      return refusal(work);
    const successor = resolved.kind === 'applied' ? resolved.successorHoldId : null;
    const cancellationEpoch = resolved.kind === 'cancelled' ? resolved.cancellationEpoch : null;
    await client.query(transitionSQL.sql, [
      current.partition,
      selection.captureId,
      selection.holdId,
      selection.bindingDigest,
      kind,
      successor,
      cancellationEpoch,
      receipt.epoch,
      receipt.position.toString(),
      receipt.transactionId,
      resolved.purpose,
      json({ ...resolved, work: undefined, provenance: undefined }),
    ]);
    // Install successor BEFORE consuming predecessor. No receiver/copy obligation is deleted or reinterpreted;
    // all remain anchored to the immutable binding, which the successor retains.
    if (successor)
      await client.query(holdSQL.sql, [
        current.partition,
        selection.captureId,
        successor,
        receipt.transactionId,
        'successor',
      ]);
    const consumed = await client.query(consumeSQL.sql, [current.partition, selection.holdId, receipt.transactionId]);
    const fenced = await client.query(fenceSQL.sql, [
      current.partition,
      selection.captureId,
      kind,
      receipt.transactionId,
      stored.binding.tuple.identity.receivingEpoch,
    ]);
    if (consumed.rowCount !== 1 || fenced.rowCount !== 1) throw unavailable();
    return resolved.kind === 'applied'
      ? {
          status: 'transferred' as const,
          successorHoldId: resolved.successorHoldId,
          transfer: receipt,
          work: work.receipt(),
        }
      : { status: 'released' as const, release: receipt, work: work.receipt() };
  });
}
export async function transferNativePublicCollectionOutputHold(
  tx: CommandTransaction,
  selection: PublicOutputDispositionSelection,
  context: PublicOutputCommandContext,
) {
  const result = await transition(tx, selection, context, 'applied');
  if (result.status === 'released') throw unavailable();
  return result;
}
export async function releaseNativePublicCollectionOutputHold(
  tx: CommandTransaction,
  selection: PublicOutputDispositionSelection,
  context: PublicOutputCommandContext,
) {
  const result = await transition(tx, selection, context, 'cancelled');
  if (result.status === 'transferred') throw unavailable();
  return result;
}
