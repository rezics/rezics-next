import {
  isManagementOperation,
  type ManagementOperationInput,
  type ManagementOperationKind,
} from '@rezics/auth-contract';

export const managementReturnTargets = {
  rename: '/account/rename',
  membership: '/organizations/members',
  transfer: '/operators/transfer',
  'transfer-acceptance': '/operators/transfer',
  opening: '/automated/open',
} as const;
export type PendingManagementOperationStepUp = ManagementOperationInput & {
  kind: ManagementOperationKind;
  returnTo: (typeof managementReturnTargets)[ManagementOperationKind];
  phase: 'awaiting' | 'returned' | 'submitted';
};
export type PendingRenameReviewStepUp = {
  kind: 'rename';
  accountId: string;
  returnTo: '/account/rename';
  phase: 'awaiting' | 'returned';
};
export type ManagementOperationStepUpSelection =
  | { kind: 'ordinary' }
  | { kind: 'invalid' }
  | { kind: 'management'; pending: PendingManagementOperationStepUp }
  | { kind: 'review'; pending: PendingRenameReviewStepUp };
const storageKey = 'rezics.management-operation.step-up';
const reviewStorageKey = 'rezics.management-operation.review-step-up';
const queryKey = 'management_operation';
/** UTF-16 code units (`String.length`): the largest closed management shape has eight 4,096-unit strings. */
export const MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT = 256 * 1024;
/** UTF-16 code units (`String.length`): a fixed UUID review envelope is under this allowance. */
export const RENAME_REVIEW_STEP_UP_STORAGE_LIMIT = 256;
const maxTextCodeUnits = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.length === required.length + optional.filter((key) => Object.hasOwn(value, key)).length &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function validInput(value: unknown): value is ManagementOperationInput {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['accountId', 'operationKey', 'operation']) &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    value.accountId.length <= maxTextCodeUnits &&
    typeof value.operationKey === 'string' &&
    value.operationKey.length > 0 &&
    value.operationKey.length <= maxTextCodeUnits &&
    isManagementOperation(value.operation)
  );
}

function canonicalOperation(value: unknown): ManagementOperationInput['operation'] | null {
  if (!isManagementOperation(value)) return null;
  if (value.kind === 'opening')
    return { kind: 'opening', operatorAccountId: value.operatorAccountId, subjectAccountId: value.subjectAccountId };
  if (value.kind === 'rename')
    return {
      kind: 'rename',
      accountId: value.accountId,
      handle: value.handle,
      expectedHandle: value.expectedHandle,
    };
  if (value.kind === 'membership')
    return {
      kind: 'membership',
      organizationId: value.organizationId,
      memberAccountId: value.memberAccountId,
      role: value.role,
      ...(value.reservationId === undefined ? {} : { reservationId: value.reservationId }),
    };
  const previous = {
    operatorAccountId: value.previous.operatorAccountId,
    subjectAccountId: value.previous.subjectAccountId,
    reservationId: value.previous.reservationId,
  };
  if (value.kind === 'transfer')
    return {
      kind: 'transfer',
      previous,
      expectedVersion: value.expectedVersion,
      operatorAccountId: value.operatorAccountId,
      ...(value.acceptance === undefined ? {} : { acceptance: value.acceptance }),
    };
  return {
    kind: 'transfer-acceptance',
    previous,
    expectedVersion: value.expectedVersion,
    operatorAccountId: value.operatorAccountId,
    sourceOperationKey: value.sourceOperationKey,
  };
}

function valid(value: unknown): value is PendingManagementOperationStepUp & { version: 1 } {
  if (!isRecord(value)) return false;
  const pending = value;
  return (
    hasExactKeys(pending, ['accountId', 'kind', 'operation', 'operationKey', 'phase', 'returnTo', 'version']) &&
    pending.version === 1 &&
    isManagementOperation(pending.operation) &&
    pending.kind === pending.operation.kind &&
    pending.returnTo === managementReturnTargets[pending.operation.kind] &&
    typeof pending.accountId === 'string' &&
    !!pending.accountId &&
    pending.accountId.length <= maxTextCodeUnits &&
    typeof pending.operationKey === 'string' &&
    !!pending.operationKey &&
    pending.operationKey.length <= 4096 &&
    (pending.phase === 'awaiting' ||
      pending.phase === 'returned' ||
      (pending.kind === 'opening' && pending.phase === 'submitted'))
  );
}
function validReview(value: unknown): value is PendingRenameReviewStepUp & { version: 1 } {
  if (!isRecord(value)) return false;
  const pending = value;
  return (
    hasExactKeys(pending, ['accountId', 'kind', 'phase', 'returnTo', 'version']) &&
    pending.version === 1 &&
    pending.kind === 'rename' &&
    typeof pending.accountId === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(pending.accountId) &&
    pending.returnTo === managementReturnTargets.rename &&
    (pending.phase === 'awaiting' || pending.phase === 'returned')
  );
}

function canonicalPending(value: unknown): (PendingManagementOperationStepUp & { version: 1 }) | null {
  if (!valid(value)) return null;
  const operation = canonicalOperation(value.operation);
  if (!operation) return null;
  return {
    accountId: value.accountId,
    kind: operation.kind,
    operation,
    operationKey: value.operationKey,
    returnTo: managementReturnTargets[operation.kind],
    phase: value.phase,
    version: 1,
  };
}

function canonicalReview(value: unknown): (PendingRenameReviewStepUp & { version: 1 }) | null {
  if (!validReview(value)) return null;
  return {
    kind: 'rename',
    accountId: value.accountId,
    returnTo: managementReturnTargets.rename,
    phase: value.phase,
    version: 1,
  };
}

function validReviewInput(value: unknown): value is PendingRenameReviewStepUp {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'accountId', 'returnTo', 'phase']) &&
    value.kind === 'rename' &&
    typeof value.accountId === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.accountId) &&
    value.returnTo === managementReturnTargets.rename &&
    value.phase === 'awaiting'
  );
}

function validPendingInput(value: unknown): value is PendingManagementOperationStepUp {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['accountId', 'kind', 'operation', 'operationKey', 'returnTo', 'phase']) &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0 &&
    value.accountId.length <= maxTextCodeUnits &&
    isManagementOperation(value.operation) &&
    value.kind === value.operation.kind &&
    value.returnTo === managementReturnTargets[value.operation.kind] &&
    typeof value.operationKey === 'string' &&
    value.operationKey.length > 0 &&
    value.operationKey.length <= maxTextCodeUnits &&
    (value.phase === 'awaiting' || value.phase === 'returned' || (value.kind === 'opening' && value.phase === 'submitted'))
  );
}
export function storePendingManagementOperationStepUp(input: ManagementOperationInput): boolean {
  if (!validInput(input)) return false;
  const operation = canonicalOperation(input.operation);
  if (!operation) return false;
  const pending = canonicalPending({
    accountId: input.accountId,
    kind: operation.kind,
    operation,
    operationKey: input.operationKey,
    returnTo: managementReturnTargets[operation.kind],
    phase: 'awaiting',
    version: 1,
  });
  if (!pending) return false;
  const serialized = JSON.stringify(pending);
  if (serialized.length > MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT) return false;
  try {
    window.sessionStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}
export function pendingManagementOperationStepUpState():
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'pending'; value: PendingManagementOperationStepUp } {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(storageKey);
  } catch {
    return { kind: 'invalid' };
  }
  if (raw === null) return { kind: 'absent' };
  if (raw.length > MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT) return { kind: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  const pending = canonicalPending(value);
  if (!pending) return { kind: 'invalid' };
  return {
    kind: 'pending',
    value: {
      accountId: pending.accountId,
      kind: pending.kind,
      operation: pending.operation,
      operationKey: pending.operationKey,
      returnTo: pending.returnTo,
      phase: pending.phase,
    },
  };
}
export function readPendingManagementOperationStepUp(): PendingManagementOperationStepUp | null {
  const state = pendingManagementOperationStepUpState();
  return state.kind === 'pending' ? state.value : null;
}
export function clearPendingManagementOperationStepUp(): void {
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    /* No authority is stored here. */
  }
}
/** Profile review has no operation descriptor, key, approval or command to resume. */
export function storePendingRenameReviewStepUp(accountId: string): boolean {
  if (typeof accountId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(accountId)) return false;
  const pending = {
    accountId,
    kind: 'rename',
    returnTo: managementReturnTargets.rename,
    phase: 'awaiting',
    version: 1,
  };
  if (!validReview(pending)) return false;
  const serialized = JSON.stringify(pending);
  if (serialized.length > RENAME_REVIEW_STEP_UP_STORAGE_LIMIT) return false;
  try {
    window.sessionStorage.setItem(reviewStorageKey, serialized);
    return true;
  } catch {
    return false;
  }
}
export function pendingRenameReviewStepUpState():
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'pending'; value: PendingRenameReviewStepUp } {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(reviewStorageKey);
  } catch {
    return { kind: 'invalid' };
  }
  if (raw === null) return { kind: 'absent' };
  if (raw.length > RENAME_REVIEW_STEP_UP_STORAGE_LIMIT) return { kind: 'invalid' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'invalid' };
  }
  const pending = canonicalReview(value);
  if (!pending) return { kind: 'invalid' };
  return {
    kind: 'pending',
    value: {
      accountId: pending.accountId,
      kind: 'rename',
      returnTo: managementReturnTargets.rename,
      phase: pending.phase,
    },
  };
}
export function clearPendingRenameReviewStepUp(): void {
  try {
    window.sessionStorage.removeItem(reviewStorageKey);
  } catch {
    /* No authority is stored here. */
  }
}
export function markRenameReviewReturned(pending: PendingRenameReviewStepUp): boolean {
  if (!validReviewInput(pending)) return false;
  const state = pendingRenameReviewStepUpState();
  if (
    state.kind !== 'pending' ||
    state.value.phase !== 'awaiting' ||
    state.value.accountId !== pending.accountId ||
    pending.kind !== 'rename' ||
    pending.returnTo !== managementReturnTargets.rename ||
    pending.phase !== 'awaiting'
  )
    return false;
  const serialized = JSON.stringify({
    accountId: state.value.accountId,
    kind: 'rename',
    returnTo: managementReturnTargets.rename,
    phase: 'returned',
    version: 1,
  });
  if (serialized.length > RENAME_REVIEW_STEP_UP_STORAGE_LIMIT) return false;
  try {
    window.sessionStorage.setItem(reviewStorageKey, serialized);
    return true;
  } catch {
    return false;
  }
}
/** Consume the return marker only after a successful native profile review. */
export function consumeRenameReviewReturn(accountId: string): boolean {
  const state = pendingRenameReviewStepUpState();
  if (state.kind !== 'pending' || state.value.phase !== 'returned' || state.value.accountId !== accountId) return false;
  clearPendingRenameReviewStepUp();
  return true;
}
/** Fixed routes only; query parameters never choose a client or supply authority. */
export function managementOperationStepUpUrl(kind: ManagementOperationKind): string {
  return `/step-up?${new URLSearchParams({ [queryKey]: kind, return_to: managementReturnTargets[kind] })}`;
}
export function selectManagementOperationStepUp(query: string): ManagementOperationStepUpSelection {
  const parameters = new URLSearchParams(query);
  const marker = parameters.get(queryKey);
  const returnTo = parameters.get('return_to');
  if (marker === null && !Object.values(managementReturnTargets).some((target) => target === returnTo))
    return { kind: 'ordinary' };
  if (parameters.size !== 2 || parameters.getAll(queryKey).length !== 1 || parameters.getAll('return_to').length !== 1)
    return { kind: 'invalid' };
  const state = pendingManagementOperationStepUpState();
  if (
    state.kind === 'pending' &&
    state.value.kind === marker &&
    state.value.returnTo === returnTo &&
    state.value.phase === 'awaiting'
  )
    return { kind: 'management', pending: state.value };
  if (marker === 'rename') {
    const review = pendingRenameReviewStepUpState();
    if (review.kind === 'pending' && review.value.returnTo === returnTo && review.value.phase === 'awaiting')
      return { kind: 'review', pending: review.value };
  }
  return { kind: 'invalid' };
}
function signature(operation: ManagementOperationInput['operation']): string {
  if (operation.kind === 'opening')
    return JSON.stringify([operation.kind, operation.operatorAccountId, operation.subjectAccountId]);
  // Canonical field order: callers need not construct object properties in storage order.
  if (operation.kind === 'rename')
    return JSON.stringify([operation.kind, operation.accountId, operation.handle, operation.expectedHandle]);
  if (operation.kind === 'membership')
    return JSON.stringify([
      operation.kind,
      operation.organizationId,
      operation.memberAccountId,
      operation.role,
      operation.reservationId ?? null,
    ]);
  return JSON.stringify([
    operation.kind,
    operation.previous.operatorAccountId,
    operation.previous.subjectAccountId,
    operation.previous.reservationId,
    operation.expectedVersion,
    operation.operatorAccountId,
    operation.kind === 'transfer' ? (operation.acceptance ?? null) : operation.sourceOperationKey,
  ]);
}
/** Persist only the non-authority descriptor/key before the one issuance attempt.
 * A lost response must never turn a returned continuation into another issuance. */
export function markManagementOpeningSubmitted(input: ManagementOperationInput): boolean {
  if (!validInput(input) || input.operation.kind !== 'opening') return false;
  const state = pendingManagementOperationStepUpState();
  if (
    state.kind === 'invalid' ||
    (state.kind === 'pending' &&
      (state.value.phase !== 'returned' || !pendingManagementOperationMatches(state.value, input)))
  )
    return false;
  const operation = canonicalOperation(input.operation);
  if (!operation) return false;
  const pending = canonicalPending({
    accountId: input.accountId,
    kind: 'opening',
    operation,
    operationKey: input.operationKey,
    returnTo: managementReturnTargets.opening,
    phase: 'submitted',
    version: 1,
  });
  if (!pending) return false;
  const serialized = JSON.stringify(pending);
  if (serialized.length > MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT) return false;
  try {
    window.sessionStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}
export function pendingManagementOperationMatches(
  pending: PendingManagementOperationStepUp,
  input: ManagementOperationInput,
): boolean {
  if (!validPendingInput(pending) || !validInput(input)) return false;
  return (
    pending.accountId === input.accountId &&
    pending.operationKey === input.operationKey &&
    pending.kind === input.operation.kind &&
    signature(pending.operation) === signature(input.operation)
  );
}
/** Called only after native reauthentication and current session comparison. No mutation is dispatched. */
export function markManagementOperationReturned(pending: PendingManagementOperationStepUp): boolean {
  if (!validPendingInput(pending) || pending.phase !== 'awaiting') return false;
  const state = pendingManagementOperationStepUpState();
  if (
    state.kind !== 'pending' ||
    state.value.phase !== 'awaiting' ||
    !pendingManagementOperationMatches(state.value, pending)
  )
    return false;
  const next = canonicalPending({
    accountId: state.value.accountId,
    kind: state.value.kind,
    operation: state.value.operation,
    operationKey: state.value.operationKey,
    returnTo: state.value.returnTo,
    phase: 'returned',
    version: 1,
  });
  if (!next) return false;
  const serialized = JSON.stringify(next);
  if (serialized.length > MANAGEMENT_OPERATION_STEP_UP_STORAGE_LIMIT) return false;
  try {
    window.sessionStorage.setItem(storageKey, serialized);
    return true;
  } catch {
    return false;
  }
}
