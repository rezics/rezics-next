import {
  ACCESS_WORK_AXES,
  EMPTY_ACCESS_WORK,
  EMPTY_ACCESS_WORK_DIMENSIONS,
  ORIGINAL_WORK_AXES,
  type AccessWork,
  type AccessWorkDimensions,
} from '../contract/bounds.ts';

export { ACCESS_WORK_AXES, EMPTY_ACCESS_WORK, EMPTY_ACCESS_WORK_DIMENSIONS, ORIGINAL_WORK_AXES };
export type { AccessWork, AccessWorkDimensions };

function copyAccessWork(work: AccessWork): AccessWork {
  if (!work || ACCESS_WORK_AXES.some((axis) => !Number.isSafeInteger(work[axis]) || work[axis] < 0)) {
    throw new TypeError('Invalid Access work');
  }
  return Object.freeze(Object.fromEntries(ACCESS_WORK_AXES.map((axis) => [axis, work[axis]]))) as AccessWork;
}

export function addAccessWork(...values: readonly AccessWork[]): AccessWork {
  return copyAccessWork(
    Object.fromEntries(
      ACCESS_WORK_AXES.map((axis) => [axis, values.reduce((total, value) => total + value[axis], 0)]),
    ) as AccessWork,
  );
}

export function accessWorkFromDimensions(work: AccessWorkDimensions): AccessWork {
  return copyAccessWork({
    keys: work.candidateKeys,
    points: work.nativePoints,
    witnesses: work.witnessKeys,
    rows: work.nativeRows,
    bytes: work.bytes,
    emptySeeks: work.emptySeeks,
  });
}

export function dimensionsFromAccessWork(work: AccessWork): AccessWorkDimensions {
  return Object.freeze({
    candidateKeys: work.keys,
    nativeRows: work.rows,
    identityMetadataRows: 0,
    nativePoints: work.points,
    witnessKeys: work.witnesses,
    statements: 0,
    bytes: work.bytes,
    emptySeeks: work.emptySeeks,
  });
}
