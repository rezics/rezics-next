import { memoizedValue } from '../memoized.ts';
/** Finite Kind raw-original input. Values describe work only and never grant Type or catalogue admission. */
import { declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import { ProblemError } from '../http/problem.ts';
import type { WorkDimensions } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import admitEpisode from './collection-kind-work-admit.sql';
import readSource from './collection-kind-work-source.sql';
import readState from './collection-kind-input-state.sql';
import readInput from './collection-kind-input-read.sql';
import insertInput from './collection-kind-input-insert.sql';
import retireInput from './collection-kind-input-retire.sql';
import custodyPartition from './native-source-custody-partition.sql';
import custodyAccount from './native-source-custody-account.sql';
import custodySource from './native-source-custody-source.sql';
import custodyFences from './native-source-custody-fences.sql';
import custodyRead from './native-source-custody-read.sql';
import custodyProof from './native-source-custody-proof.sql';
import custodyHold from './native-source-custody-hold.sql';

export const COLLECTION_KIND_INPUT_RAW_LIMIT = 100;
export const COLLECTION_KIND_INPUT_BYTE_LIMIT = 4096;
/** One raw original. An exact-limit page is not EOF; the next charged seek establishes exhaustion. */
export const COLLECTION_KIND_INPUT_QUANTUM = 1;
const ENVELOPE = COLLECTION_KIND_INPUT_BYTE_LIMIT;
const ESCAPED_BODY = 6 * ENVELOPE;

const bytes = (value: number): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: value,
    engineRequests: 0,
  });

const work = (
  candidateKeys: number,
  nativeRows: number,
  nativePoints: number,
  emptySeeks: number,
  statements: number,
): Bound =>
  declareBound({
    candidateKeys,
    nativeRows,
    identityMetadataRows: 0,
    emptySeeks,
    nativePoints,
    witnessKeys: 0,
    statements,
    bytes: 0,
    engineRequests: 0,
  });

/** SQL text, request binds, escaped 4096-byte body and projection are independent byte facts. */
const statement = (
  sql: string,
  candidateKeys: number,
  nativeRows: number,
  nativePoints: number,
  projection: number,
  extras: Readonly<{ emptySeeks?: number; statements?: number; request?: number; escaped?: number }> = {},
): Bound =>
  sumBounds(
    work(candidateKeys, nativeRows, nativePoints, extras.emptySeeks ?? 1, extras.statements ?? 1),
    bytes(Buffer.byteLength(sql)),
    bytes(extras.request ?? ENVELOPE),
    bytes(extras.escaped ?? ESCAPED_BODY),
    bytes(projection),
  );

function custodySql() {
  return memoizedValue(
    custodySql,
    () =>
      [custodyPartition, custodyAccount, custodySource, custodyFences, custodyRead, custodyProof, custodyHold] as const,
  );
}

function admissionEpisode() {
  return memoizedValue(admissionEpisode, () =>
    statement(admitEpisode.sql, 8, 8, 9, 0, { escaped: 2 * (ESCAPED_BODY + 2048) }),
  );
}
function admissionSource() {
  return memoizedValue(admissionSource, () => statement(readSource.sql, 3, 3, 3, 10240, { escaped: 0 }));
}
function custody() {
  return memoizedValue(custody, () =>
    sumBounds(
      work(0, 208, 10, 0, 7),
      ...custodySql().map((query) => bytes(Buffer.byteLength(query.sql) + ENVELOPE + ENVELOPE)),
    ),
  );
}
function state() {
  return memoizedValue(state, () => statement(readState.sql, 3, 3, 3, ESCAPED_BODY));
}
function read() {
  return memoizedValue(read, () => statement(readInput.sql, 2, 2, 1, 2 * (ESCAPED_BODY + 512)));
}
function sourceMetadata() {
  return memoizedValue(sourceMetadata, () =>
    declareBound({
      candidateKeys: 0,
      nativeRows: 16,
      identityMetadataRows: 0,
      emptySeeks: 4,
      nativePoints: 4,
      witnessKeys: 0,
      statements: 4,
      bytes: 32 * 1024,
      engineRequests: 0,
    }),
  );
}
function sourcePage() {
  return memoizedValue(sourcePage, () =>
    declareBound({
      candidateKeys: COLLECTION_KIND_INPUT_QUANTUM,
      nativeRows: 32,
      identityMetadataRows: 0,
      emptySeeks: 5,
      nativePoints: 5,
      witnessKeys: 0,
      statements: 5,
      bytes: 32 * 1024,
      engineRequests: 0,
    }),
  );
}
function source() {
  return memoizedValue(source, () => sumBounds(sourceMetadata(), sourcePage()));
}
function insert() {
  return memoizedValue(insert, () =>
    sumBounds(statement(insertInput.sql, 9, 12, 9, 128), work(0, 0, 0, 1, 1), bytes(ENVELOPE)),
  );
}
function retire() {
  return memoizedValue(retire, () => statement(retireInput.sql, 1, 3, 2, 0));
}
function collisionReads() {
  return memoizedValue(collisionReads, () => repeatBound(read(), 2));
}
function admission() {
  return memoizedValue(admission, () => sumBounds(admissionEpisode(), admissionSource(), custody()));
}
const libraryPoint = (nativeRows: number, nativePoints: number, bytes: number): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints,
    witnessKeys: 0,
    statements: 1,
    bytes,
    engineRequests: 0,
  });
function preparationScope() {
  return memoizedValue(preparationScope, () => libraryPoint(16, 3, 12_288));
}
function preparationObservation() {
  return memoizedValue(preparationObservation, () => libraryPoint(1, 1, 8192));
}
function preparationRetired() {
  return memoizedValue(preparationRetired, () => libraryPoint(1, 1, 256));
}
function preparationClock() {
  return memoizedValue(preparationClock, () => libraryPoint(1, 1, 256));
}

export function COLLECTION_KIND_INPUT_TERMS() {
  return memoizedValue(COLLECTION_KIND_INPUT_TERMS, () =>
    Object.freeze({
      admissionEpisode: admissionEpisode(),
      admissionSource: admissionSource(),
      custody: custody(),
      state: state(),
      read: read(),
      collisionReads: collisionReads(),
      sourceMetadata: sourceMetadata(),
      sourcePage: sourcePage(),
      source: source(),
      insert: insert(),
      retire: retire(),
      admission: admission(),
    }),
  );
}

export function COLLECTION_KIND_PREPARATION_TERMS() {
  return memoizedValue(COLLECTION_KIND_PREPARATION_TERMS, () =>
    Object.freeze({
      scope: preparationScope(),
      observation: preparationObservation(),
      retired: preparationRetired(),
      clock: preparationClock(),
      custody: custody(),
    }),
  );
}

/** Complete one-attempt sequence: admission, state, two reads, source observations, insert fence, retirement. */
export function COLLECTION_KIND_INPUT_COST() {
  return memoizedValue(COLLECTION_KIND_INPUT_COST, () =>
    sumBounds(admission(), state(), collisionReads(), source(), insert(), retire()),
  );
}

export function COLLECTION_KIND_PREPARATION_OBSERVATION() {
  return memoizedValue(COLLECTION_KIND_PREPARATION_OBSERVATION, () => sumBounds(preparationScope(), custody()));
}
export function COLLECTION_KIND_PREPARATION_RETIREMENT() {
  return memoizedValue(COLLECTION_KIND_PREPARATION_RETIREMENT, () =>
    sumBounds(preparationRetired(), preparationScope(), custody()),
  );
}

export const COLLECTION_KIND_INPUT_PATHS = Object.freeze({
  quantum: COLLECTION_KIND_INPUT_QUANTUM,
  rawCeiling: COLLECTION_KIND_INPUT_RAW_LIMIT,
  envelopeBytes: COLLECTION_KIND_INPUT_BYTE_LIMIT,
  escapedBodyMultiplier: 6,
  collisionReads: 2,
  predecessorRetirements: 1,
  custodyStatements: 7,
  nativeAttempts: 3,
});

export function COLLECTION_KIND_INPUT_DECLARATION() {
  return memoizedValue(COLLECTION_KIND_INPUT_DECLARATION, () =>
    Object.freeze({
      status: 'complete' as const,
      axes: [
        'candidateKeys',
        'nativeRows',
        'identityMetadataRows',
        'emptySeeks',
        'nativePoints',
        'witnessKeys',
        'statements',
        'bytes',
        'engineRequests',
      ] as const,
      cost: COLLECTION_KIND_INPUT_COST(),
      terms: COLLECTION_KIND_INPUT_TERMS(),
      paths: COLLECTION_KIND_INPUT_PATHS,
    }),
  );
}

/** Adapter edge for the existing eight-axis native observer. Kind input declares zero engine requests. */
export function collectionKindInputWorkDimensions(bound: Bound): WorkDimensions {
  const declared = declareBound(bound);
  if (declared.engineRequests !== 0)
    throw new TypeError('Collection Kind input cannot map engine requests to the native SQL observer');
  return Object.freeze({
    candidateKeys: declared.candidateKeys,
    nativeRows: declared.nativeRows,
    identityMetadataRows: declared.identityMetadataRows,
    emptySeeks: declared.emptySeeks,
    nativePoints: declared.nativePoints,
    witnessKeys: declared.witnessKeys,
    statements: declared.statements,
    bytes: declared.bytes,
  });
}

export function collectionKindInputWork(): WorkDimensions {
  return collectionKindInputWorkDimensions(COLLECTION_KIND_INPUT_COST());
}

export function collectionKindInputAdmissionWork(): WorkDimensions {
  return collectionKindInputWorkDimensions(admission());
}

export function collectionKindInputRemaining(work: NativeCollectionWork): Bound {
  return declareBound({
    candidateKeys: work.available('candidateKeys'),
    nativeRows: work.available('nativeRows'),
    identityMetadataRows: work.available('identityMetadataRows'),
    emptySeeks: work.available('emptySeeks'),
    nativePoints: work.available('nativePoints'),
    witnessKeys: work.available('witnessKeys'),
    statements: work.available('statements'),
    bytes: work.available('bytes'),
    engineRequests: 0,
  });
}

export function collectionKindInputAdmitted(
  work: NativeCollectionWork,
  bound: Bound = COLLECTION_KIND_INPUT_COST(),
): boolean {
  return withinCeiling(bound, collectionKindInputRemaining(work));
}

/** One named Bound, one reserve. SQL identity is not looked up again at the receipt boundary. */
export async function invokeCollectionKindInput<T>(
  work: NativeCollectionWork,
  bound: Bound,
  run: () => Promise<T>,
): Promise<T> {
  if (!(work instanceof NativeCollectionWork)) throw new ProblemError('semantic_not_ready');
  const reservation = work.reserve(collectionKindInputWorkDimensions(bound));
  reservation.dispatch();
  try {
    return await reservation.query(run);
  } finally {
    reservation.settle();
  }
}
