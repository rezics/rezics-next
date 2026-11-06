import {
  EMPTY_ACCESS_WORK_DIMENSIONS,
  ORIGINAL_WORK_AXES,
  type AccessWorkDeclaration,
  type AccessWorkDimensions,
} from '../contract/bounds.ts';

export { ORIGINAL_WORK_AXES };

/** A local SQL declaration. An absent child declaration is represented separately, never by zero. */
export function originalControlWork(
  rows: number,
  points: number,
  statements: number,
  bytes: number,
  emptySeeks = 0,
): AccessWorkDimensions {
  const work = {
    candidateKeys: 0,
    nativeRows: rows,
    identityMetadataRows: 0,
    nativePoints: points,
    witnessKeys: 0,
    statements,
    bytes,
    emptySeeks,
  };
  originalWorkVector(work);
  return Object.freeze(work);
}

export function originalWorkVector(work: AccessWorkDimensions): readonly number[] {
  if (
    !work ||
    typeof work !== 'object' ||
    Reflect.ownKeys(work).length !== ORIGINAL_WORK_AXES.length ||
    ORIGINAL_WORK_AXES.some((axis) => !Object.hasOwn(work, axis))
  )
    throw new RangeError('Invalid identity original work dimensions');
  const values = ORIGINAL_WORK_AXES.map((axis) => work[axis]);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new RangeError('Invalid identity original work dimensions');
  return Object.freeze(values);
}

export function sumOriginalControl(...parts: readonly AccessWorkDimensions[]): AccessWorkDimensions {
  const values = ORIGINAL_WORK_AXES.map(() => 0);
  for (const part of parts)
    originalWorkVector(part).forEach((value, index) => {
      values[index]! += value;
      if (!Number.isSafeInteger(values[index])) throw new RangeError('Identity original work overflow');
    });
  return Object.freeze(
    Object.fromEntries(
      ORIGINAL_WORK_AXES.map((axis, index) => [axis, values[index]!]),
    ) as unknown as AccessWorkDimensions,
  );
}

export function admitOriginalWorkDeclaration(declaration: AccessWorkDeclaration | null): AccessWorkDimensions | null {
  if (declaration === null) return null;
  if (
    declaration.engineRequests !== 0 ||
    Reflect.ownKeys(declaration).length !== 2 ||
    !Object.hasOwn(declaration, 'work') ||
    !Object.hasOwn(declaration, 'engineRequests')
  )
    throw new RangeError('identity-history-original-child-declaration-invalid');
  return Object.freeze(
    Object.fromEntries(
      ORIGINAL_WORK_AXES.map((axis, index) => [axis, originalWorkVector(declaration.work)[index]!]),
    ) as unknown as AccessWorkDimensions,
  );
}

export const ORIGINAL_NATIVE_CONTROL = originalControlWork(3, 1, 8, 256);
export const HISTORY_ORIGINAL_CONTROL = Object.freeze({
  discovery: originalControlWork(1, 1, 1, 64, 1),
  native: ORIGINAL_NATIVE_CONTROL,
  registry: originalControlWork(1, 1, 1, 128, 1),
  select: originalControlWork(1, 1, 1, 2048, 1),
  barrier: originalControlWork(1, 1, 1, 128, 1),
  previous: originalControlWork(1, 1, 1, 4096, 1),
  insert: originalControlWork(1, 1, 1, 4096),
  lease: originalControlWork(1, 1, 1, 0),
});
export const HISTORY_ORIGINAL_SELECTION = sumOriginalControl(...Object.values(HISTORY_ORIGINAL_CONTROL));
export const HISTORY_ORIGINAL_VALIDATION = sumOriginalControl(
  ORIGINAL_NATIVE_CONTROL,
  originalControlWork(1, 1, 1, 4096, 1),
  originalControlWork(1, 1, 1, 2048, 1),
  originalControlWork(1, 1, 1, 128, 1),
  originalControlWork(1, 1, 1, 128, 1),
);
export const HISTORY_ORIGINAL_SETTLEMENT = sumOriginalControl(
  ORIGINAL_NATIVE_CONTROL,
  originalControlWork(1, 1, 1, 2048, 1),
  originalControlWork(1, 1, 1, 0),
  originalControlWork(1, 1, 1, 0),
);

export const HISTORY_SELECTED_LOCAL_CONTROL = Object.freeze({
  transaction: originalControlWork(0, 0, 5, 0),
  job: originalControlWork(1, 1, 1, 4096, 1),
  dispatchPosition: originalControlWork(2, 2, 1, 4224, 2),
  barrier: originalControlWork(1, 1, 1, 128, 1),
  partition: originalControlWork(1, 1, 1, 128, 1),
  seal: sumOriginalControl(originalControlWork(4, 4, 3, 0), originalControlWork(12, 12, 4, 0)),
  progressInsert: originalControlWork(3, 3, 3, 0),
  progressLock: originalControlWork(1, 1, 1, 128, 1),
  epochReset: originalControlWork(2, 2, 2, 0),
  gapReset: originalControlWork(1, 1, 1, 0),
  page: originalControlWork(8, 1, 1, 4096, 1),
  applicable: originalControlWork(2, 2, 2, 0),
  classify: originalControlWork(1, 1, 1, 128, 1),
  unavailableHome: originalControlWork(2, 2, 2, 0),
  emptyProgress: originalControlWork(1, 1, 1, 0),
  emptySeal: sumOriginalControl(originalControlWork(2, 2, 1, 0), originalControlWork(12, 12, 4, 0)),
  nextHome: originalControlWork(1, 1, 1, 0),
  phaseChange: originalControlWork(1, 1, 1, 0),
  verifyHome: originalControlWork(2, 2, 1, 4096, 1),
  verifyTransition: originalControlWork(1, 1, 1, 0),
  authProof: originalControlWork(1, 1, 1, 128, 1),
  pending: originalControlWork(1, 1, 1, 0),
});

export const HISTORY_ORIGINAL_LOCAL_ALLOWANCE = sumOriginalControl(
  HISTORY_ORIGINAL_SELECTION,
  HISTORY_ORIGINAL_VALIDATION,
  HISTORY_ORIGINAL_SETTLEMENT,
  ...Object.values(HISTORY_SELECTED_LOCAL_CONTROL),
);

export const HISTORY_ORIGINAL_TRANSFER_CONTROL = Object.freeze({
  discoveryControls: originalControlWork(0, 0, 5, 0),
  allocationInsert: originalControlWork(3, 3, 3, 4096),
  entryBarrier: originalControlWork(1, 1, 1, 128, 1),
  progress: sumOriginalControl(originalControlWork(1, 1, 1, 2048, 1), originalControlWork(1, 1, 1, 64)),
  settlementAllocation: originalControlWork(1, 1, 1, 2048, 1),
  grant: sumOriginalControl(
    ORIGINAL_NATIVE_CONTROL,
    originalControlWork(2, 2, 1, 8192, 2),
    originalControlWork(1, 1, 1, 2048, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 0),
  ),
  finish: sumOriginalControl(
    ORIGINAL_NATIVE_CONTROL,
    originalControlWork(2, 2, 1, 8192, 2),
    originalControlWork(1, 1, 1, 2048, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 128, 1),
    originalControlWork(1, 1, 1, 0),
  ),
});
export const ADDITIONAL_ORIGINAL_TRANSFER_CONTROL = sumOriginalControl(
  ...Object.values(HISTORY_ORIGINAL_TRANSFER_CONTROL),
);

export function composeOriginalWorkAdmission(
  local: AccessWorkDimensions,
  source: AccessWorkDimensions | null,
  library: AccessWorkDimensions | null,
  transfer: AccessWorkDimensions = EMPTY_ACCESS_WORK_DIMENSIONS,
): AccessWorkDimensions {
  originalWorkVector(local);
  originalWorkVector(transfer);
  return sumOriginalControl(
    local,
    transfer,
    ...(source === null ? [] : [source]),
    ...(library === null ? [] : [library]),
  );
}
