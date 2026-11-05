import { declareBound, type Bound } from '@rezics/bounds';
import type { WorkDimensions } from './collection-source.ts';

/** Named 9-axis to legacy native 8-axis translation; engine work cannot disappear at this boundary. */
export function nativeWorkDimensions(value: Bound): WorkDimensions {
  const bound = declareBound(value);
  if (bound.engineRequests !== 0) throw new RangeError('Native Collection work cannot fund engine requests');
  return Object.freeze({
    candidateKeys: bound.candidateKeys,
    identityMetadataRows: bound.identityMetadataRows,
    nativeRows: bound.nativeRows,
    nativePoints: bound.nativePoints,
    witnessKeys: bound.witnessKeys,
    statements: bound.statements,
    bytes: bound.bytes,
    emptySeeks: bound.emptySeeks,
  });
}
