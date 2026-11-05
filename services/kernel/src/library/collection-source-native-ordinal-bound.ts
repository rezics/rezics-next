import type { WorkDimensions } from './collection-source.ts';
import ordinalPage from './collection-source-native-ordinal.sql';

export type NativeCollectionOrdinalPageBound = Readonly<{
  limit: number;
  requestBytes: number;
  resultBytes: number;
  /** Complete legacy Source footprint, including request bindings and the result projection ceiling. */
  work: WorkDimensions;
  /** Projection-only dimensions used by the shared native SQL dispatcher. */
  projection: Readonly<Partial<WorkDimensions>>;
}>;

/** The single native ordinal statement's literal and schema-width bounds. */
export function nativeCollectionOrdinalPageBound(limit: number): NativeCollectionOrdinalPageBound {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Native source limit must be 1..100');
  const maxUuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const requestValues = [65535, maxUuid, '~'.repeat(48), maxUuid, limit];
  const requestBytes = Buffer.byteLength(ordinalPage.sql) + Buffer.byteLength(JSON.stringify(requestValues));
  const resultBytes = 512 * limit;
  const projection = Object.freeze({
    candidateKeys: limit,
    nativeRows: 4 * limit + 4,
    nativePoints: 1,
    bytes: resultBytes,
  });
  const work: WorkDimensions = Object.freeze({
    candidateKeys: limit,
    nativeRows: 4 * limit + 4,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: requestBytes + resultBytes,
  });
  return Object.freeze({ limit, requestBytes, resultBytes, work, projection });
}
