export const RECOVERY_PREVIOUS_CURSORS = 8;

export type RecoveryReader = 'collections' | 'occurrences' | 'outcomes';
export type RecoveryCursor = string | null;
export type RecoveryReadAdmission = {
  uploadId: string;
  collectionId: string | null;
  phase: 'selection' | 'results';
  statusState: string | null;
  sourceStage: string;
};

export type RecoveryReadTarget = {
  cursor: RecoveryCursor;
  direction: 'first' | 'next' | 'previous';
  admission: RecoveryReadAdmission;
};

export type RecoveryReadWindow = {
  current: RecoveryCursor;
  previous: RecoveryCursor[];
  staged: RecoveryReadTarget | null;
  revision: number;
};

export function emptyRecoveryReadWindow(): RecoveryReadWindow {
  return { current: null, previous: [], staged: null, revision: 0 };
}

export function recoveryReadTarget(
  window: RecoveryReadWindow,
  direction: 'first' | 'next' | 'previous',
  admission: RecoveryReadAdmission,
  cursor?: string,
): RecoveryReadTarget | null {
  if (direction === 'next') {
    if (cursor === undefined) return null;
    return { cursor, direction, admission };
  }
  if (direction === 'previous') {
    if (!window.previous.length) return null;
    return { cursor: window.previous.at(-1)!, direction, admission };
  }
  return { cursor: null, direction, admission };
}

export function sameRecoveryReadAdmission(a: RecoveryReadAdmission, b: RecoveryReadAdmission): boolean {
  return (
    a.uploadId === b.uploadId &&
    a.collectionId === b.collectionId &&
    a.phase === b.phase &&
    a.statusState === b.statusState
  );
}

export function commitRecoveryRead(window: RecoveryReadWindow, target: RecoveryReadTarget): RecoveryReadWindow {
  const previous =
    target.direction === 'next'
      ? [...window.previous, window.current].slice(-RECOVERY_PREVIOUS_CURSORS)
      : target.direction === 'previous'
        ? window.previous.slice(0, -1)
        : [];
  return {
    current: target.cursor,
    previous,
    staged: null,
    revision: window.revision + 1,
  };
}
