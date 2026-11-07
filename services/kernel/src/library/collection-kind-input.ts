import { memoizedValue } from '../memoized.ts';
/** Committed pre-Type inputs. Raw originals are never votes or disclosure evidence. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { commandTime } from '../command/command.ts';
import type { OperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem-error.ts';
import { nativeSourceFence } from './native-source-fence.ts';
import { type CanonicalRawKey } from './canonical-source-store.ts';
import { readNativeCollectionMetadata, readNativeCollectionRawPage } from './collection-source-native.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import type { NativeSourceIdentity, NativeSourceCustody } from './native-source-custody.ts';
import {
  COLLECTION_KIND_INPUT_BYTE_LIMIT,
  COLLECTION_KIND_INPUT_QUANTUM,
  COLLECTION_KIND_INPUT_TERMS,
  collectionKindInputAdmitted,
  collectionKindInputWorkDimensions,
  invokeCollectionKindInput,
} from './collection-kind-input-bounds.ts';
import {
  admitCollectionKindPreparationStep,
  currentCollectionKindInputAdmission,
  type CollectionKindPreparationLocator,
} from './collection-kind-work-admission.ts';
import readState from './collection-kind-input-state.sql';
import readInput from './collection-kind-input-read.sql';
import insertInput from './collection-kind-input-insert.sql';
import retireInput from './collection-kind-input-retire.sql';

export {
  COLLECTION_KIND_INPUT_BYTE_LIMIT,
  COLLECTION_KIND_INPUT_DECLARATION,
  COLLECTION_KIND_INPUT_QUANTUM,
  COLLECTION_KIND_INPUT_RAW_LIMIT,
  collectionKindInputWork,
} from './collection-kind-input-bounds.ts';
function quantum() {
  return memoizedValue(quantum, () => COLLECTION_KIND_INPUT_QUANTUM);
}
type Progress = Readonly<{ driver: CanonicalRawKey['driver'] | 'done'; after: CanonicalRawKey | null }>;
export type CollectionKindRawInputBody = Readonly<{
  format: 1;
  original: Readonly<{ id: string; digest: string; formula: string; audience: string }>;
  enrollment: Readonly<{ reference: string; generation: string; restore: string; catalogue: string }>;
  preparation: Readonly<{ id: string; version: string; predecessor: string | null }>;
  source: Readonly<{
    identity: NativeSourceIdentity;
    fence: string;
    capture: string;
    transaction: string;
    hold: string;
  }>;
  before: Progress;
  after: Progress;
  rows: readonly Readonly<{ key: CanonicalRawKey }>[];
  exhausted: boolean;
}>;
export type CollectionKindInputBinding = Readonly<{
  locator: CollectionKindPreparationLocator;
  inputId: string;
  body: CollectionKindRawInputBody;
  custody: NativeSourceCustody;
}>;
type State = NonNullable<(typeof readState)['~reylo']['element']>;
type Row = (typeof readInput)['~reylo']['element'];
function terms() {
  return memoizedValue(terms, () => COLLECTION_KIND_INPUT_TERMS());
}
function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const digest = (body: string) => `sha256:${createHash('sha256').update(body).digest('hex')}`;
// Count the complete immutable record, including its continuation and input id,
// rather than only the row array or a detached progress string.
function encodedBytes(inputId: string, body: CollectionKindRawInputBody): number {
  return Buffer.byteLength(JSON.stringify({ inputId, body }));
}
function parse(row: Row): CollectionKindRawInputBody {
  // Only the immutable native writer can create these bytes. Parsing does not
  // establish custody/currentness; every consumer still admits the native home.
  const value: CollectionKindRawInputBody = JSON.parse(row.body);
  if (
    encodedBytes(row.inputId, value) > COLLECTION_KIND_INPUT_BYTE_LIMIT ||
    digest(row.body) !== row.inputId ||
    value.format !== 1 ||
    value.preparation.version !== row.version ||
    value.preparation.predecessor !== row.predecessor ||
    value.rows.length > quantum() ||
    value.exhausted !== (value.after.driver === 'done')
  )
    throw new ProblemError('dependency_unavailable');
  return immutable(value);
}
function equalOriginal(
  body: CollectionKindRawInputBody,
  state: State,
  originId: string,
  locator: CollectionKindPreparationLocator,
  identity: NativeSourceIdentity,
  custody: NativeSourceCustody,
) {
  return (
    body.original.id === originId &&
    body.original.digest === state.originalDigest &&
    body.original.formula === state.formulaDigest &&
    body.original.audience === state.audience &&
    body.enrollment.reference === state.referenceId &&
    body.enrollment.generation === state.enrollmentGeneration &&
    body.enrollment.restore === state.restoreGeneration &&
    body.enrollment.catalogue === state.catalogueRoot &&
    body.preparation.id === locator.preparationId &&
    body.source.capture === state.capture &&
    body.source.hold === custody.holdId &&
    body.source.transaction === custody.transactionId &&
    isDeepStrictEqual(body.source.identity, identity)
  );
}
function drivers(
  authority: NativeSourceIdentity['scope'],
  builtin: string | null,
): readonly CanonicalRawKey['driver'][] {
  if (authority === 'curated') return ['member'];
  if (authority === 'private_builtin') return builtin === 'state' ? ['entry'] : ['entry', 'label', 'session', 'copy'];
  throw new ProblemError('semantic_not_ready');
}
export type CollectionKindInputResult =
  | Readonly<{ status: 'committed'; binding: CollectionKindInputBinding }>
  | Readonly<{ status: 'awaiting_commit'; inputId: string }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

/** Called by the original audience resolver on its SAME live native home. The
 * first call produces an interval; only a subsequent committed native lookup
 * returns it. No foreign Type/Access call occurs before the caller releases T.
 */
export async function resolveCollectionKindRawInput(
  tx: OperationalTransaction,
  locator: CollectionKindPreparationLocator,
  originId: string,
  work: NativeCollectionWork,
): Promise<CollectionKindInputResult> {
  if (!(work instanceof NativeCollectionWork)) throw new ProblemError('semantic_not_ready');
  work.assertReady();
  if (!collectionKindInputAdmitted(work)) throw new ProblemError('semantic_not_ready');
  if (!(await admitCollectionKindPreparationStep(tx, locator, work)))
    return { status: 'unavailable', reason: 'Collection Kind exact enrolled Source episode is not current' };
  const held = currentCollectionKindInputAdmission(tx, locator, work);
  if (!held || held.originId !== originId) throw new ProblemError('semantic_not_ready');
  const time = commandTime(tx);
  function current() {
    if (
      !currentCollectionKindInputAdmission(tx, locator, work) ||
      commandTime(tx) !== time ||
      Date.now() >= held!.deadline
    )
      throw new ProblemError('semantic_not_ready');
  }
  const state = await invokeCollectionKindInput(work, terms().state, () =>
    readState.run(tx, {
      route: locator.route,
      origin_id: originId,
      preparation_id: locator.preparationId,
      reference_id: held.referenceId,
      now_ms: String(Date.now()),
    }),
  );
  current();
  if (!state) return { status: 'unavailable', reason: 'Collection Kind original, consent or preparation changed' };
  const key = { route: locator.route, origin_id: originId, preparation_id: locator.preparationId };
  const rows = await invokeCollectionKindInput(work, terms().read, () => readInput.run(tx, key));
  current();
  if (rows.length > 1) throw new ProblemError('dependency_unavailable');
  const previous = rows[0];
  const previousBody = previous && parse(previous);
  if (previousBody && !equalOriginal(previousBody, state, originId, locator, held.sourceIdentity, held.custody))
    return { status: 'unavailable', reason: 'Collection Kind raw predecessor original/source/enrollment changed' };
  // Structural reads only: actual Source producer owns all population decisions.
  const read = await work.compose(
    (allowance) => readNativeCollectionMetadata(held.pool, locator, { tx, allowance, deadline: held.deadline }),
    collectionKindInputWorkDimensions(terms().sourceMetadata),
  );
  current();
  const metadata = read.metadata;
  if (
    !metadata ||
    metadata.curatorAccountId !== locator.ownerAccountId ||
    metadata.incarnation !== held.sourceIdentity.incarnation ||
    metadata.sourceGeneration !== held.sourceIdentity.generation ||
    metadata.authority !== held.sourceIdentity.scope
  )
    return { status: 'unavailable', reason: 'Collection Kind native raw Source identity changed' };
  const fence = nativeSourceFence(metadata);
  // The capture token was parsed and locked by admission. Match the actual Source
  // fence, not a caller's reconstructed key list or a post-Type checkpoint.
  const token: unknown = JSON.parse(state.capture);
  if (!Array.isArray(token) || token[1] !== fence || (previousBody && previousBody.source.fence !== fence))
    return { status: 'unavailable', reason: 'Collection Kind raw Source basis changed' };
  if (previous && previousBody && previous.version === state.version) {
    if (!previous.committed) return { status: 'awaiting_commit', inputId: previous.inputId };
    return {
      status: 'committed',
      binding: Object.freeze({
        locator: Object.freeze({ ...locator }),
        inputId: previous.inputId,
        body: previousBody,
        custody: held.custody,
      }),
    };
  }
  if (
    (previous && (BigInt(previous.version) + 1n !== BigInt(state.version) || !previous.committed)) ||
    (!previous && state.version !== '0') ||
    previousBody?.exhausted
  )
    return { status: 'unavailable', reason: 'Collection Kind raw predecessor/version is not adoptable' };
  const sequence = drivers(held.sourceIdentity.scope, metadata.builtinKind);
  const before: Progress = previousBody?.after ?? { driver: sequence[0]!, after: null };
  const driver = before.driver;
  if (driver === 'done') throw new ProblemError('dependency_unavailable');
  const page = await work.compose(
    (allowance) =>
      readNativeCollectionRawPage(held.pool, metadata, {
        tx,
        allowance,
        deadline: held.deadline,
        driver,
        after: before.after,
        limit: quantum(),
      }),
    collectionKindInputWorkDimensions(terms().sourcePage),
  );
  current();
  const index = sequence.indexOf(driver);
  if (index < 0 || page.rows.length > quantum() || (!page.exhausted && isDeepStrictEqual(before.after, page.after)))
    throw new ProblemError('dependency_unavailable');
  const next = sequence[index + 1];
  const after: Progress = page.exhausted
    ? { driver: next ?? 'done', after: null }
    : { driver: before.driver, after: page.after };
  const body: CollectionKindRawInputBody = {
    format: 1,
    original: { id: originId, digest: state.originalDigest, formula: state.formulaDigest, audience: state.audience },
    enrollment: {
      reference: state.referenceId,
      generation: state.enrollmentGeneration,
      restore: state.restoreGeneration,
      catalogue: state.catalogueRoot,
    },
    preparation: { id: locator.preparationId, version: state.version, predecessor: previous?.inputId ?? null },
    source: {
      identity: held.sourceIdentity,
      fence,
      capture: state.capture,
      transaction: held.custody.transactionId,
      hold: held.custody.holdId,
    },
    before,
    after,
    rows: page.rows,
    exhausted: after.driver === 'done',
  };
  const encoded = JSON.stringify(body);
  const inputId = digest(encoded);
  if (encodedBytes(inputId, body) > COLLECTION_KIND_INPUT_BYTE_LIMIT)
    return { status: 'unavailable', reason: 'Collection Kind complete raw input/progress envelope exceeds 4096 bytes' };
  await invokeCollectionKindInput(work, terms().insert, () =>
    insertInput.run(tx, {
      ...key,
      version: state.version,
      input_id: inputId,
      predecessor: previous?.inputId ?? null,
      body: encoded,
    }),
  );
  current();
  const adopted = await invokeCollectionKindInput(work, terms().read, () => readInput.run(tx, key));
  current();
  const exact = adopted.find((row) => row.version === state.version);
  if (
    !exact ||
    exact.inputId !== inputId ||
    exact.body !== encoded ||
    exact.predecessor !== body.preparation.predecessor
  )
    throw new ProblemError('dependency_unavailable');
  if (previous)
    await invokeCollectionKindInput(work, terms().retire, () =>
      retireInput.run(tx, { route: locator.route, origin_id: originId, input_id: previous.inputId }),
    );
  current();
  // COMMIT belongs to the admitted Core caller. Never advertise an uncommitted
  // insertion as input or keep a permission/Actor/transaction in the reference.
  return { status: 'awaiting_commit', inputId };
}
