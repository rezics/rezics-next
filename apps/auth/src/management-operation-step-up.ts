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
} as const;
export type PendingManagementOperationStepUp = ManagementOperationInput & {
  kind: ManagementOperationKind;
  returnTo: (typeof managementReturnTargets)[ManagementOperationKind];
  phase: 'awaiting' | 'returned';
};
export type ManagementOperationStepUpSelection =
  | { kind: 'ordinary' }
  | { kind: 'invalid' }
  | { kind: 'management'; pending: PendingManagementOperationStepUp };
const storageKey = 'rezics.management-operation.step-up';
const queryKey = 'management_operation';

function valid(value: unknown): value is PendingManagementOperationStepUp & { version: 1 } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pending = value as Record<string, unknown>;
  return (
    Object.keys(pending).sort().join(',') === 'accountId,kind,operation,operationKey,phase,returnTo,version' &&
    pending.version === 1 &&
    isManagementOperation(pending.operation) &&
    pending.kind === pending.operation.kind &&
    pending.returnTo === managementReturnTargets[pending.operation.kind] &&
    typeof pending.accountId === 'string' &&
    !!pending.accountId &&
    typeof pending.operationKey === 'string' &&
    !!pending.operationKey &&
    pending.operationKey.length <= 4096 &&
    (pending.phase === 'awaiting' || pending.phase === 'returned')
  );
}
export function storePendingManagementOperationStepUp(input: ManagementOperationInput): boolean {
  const pending = {
    ...input,
    kind: input.operation.kind,
    returnTo: managementReturnTargets[input.operation.kind],
    phase: 'awaiting',
    version: 1,
  };
  if (!valid(pending)) return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}
export function pendingManagementOperationStepUpState():
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'pending'; value: PendingManagementOperationStepUp } {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return { kind: 'absent' };
    const value: unknown = JSON.parse(raw);
    if (!valid(value)) return { kind: 'invalid' };
    const { version: _version, ...pending } = value;
    return { kind: 'pending', value: pending };
  } catch {
    return { kind: 'invalid' };
  }
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
    state.kind !== 'pending' ||
    state.value.kind !== marker ||
    state.value.returnTo !== returnTo ||
    state.value.phase !== 'awaiting'
  )
    return { kind: 'invalid' };
  return { kind: 'management', pending: state.value };
}
function signature(operation: ManagementOperationInput['operation']): string {
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
export function pendingManagementOperationMatches(
  pending: PendingManagementOperationStepUp,
  input: ManagementOperationInput,
): boolean {
  return (
    pending.accountId === input.accountId &&
    pending.operationKey === input.operationKey &&
    pending.kind === input.operation.kind &&
    signature(pending.operation) === signature(input.operation)
  );
}
/** Called only after native reauthentication and current session comparison. No mutation is dispatched. */
export function markManagementOperationReturned(pending: PendingManagementOperationStepUp): boolean {
  const state = pendingManagementOperationStepUpState();
  if (
    state.kind !== 'pending' ||
    state.value.phase !== 'awaiting' ||
    !pendingManagementOperationMatches(state.value, pending)
  )
    return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify({ ...state.value, phase: 'returned', version: 1 }));
    return true;
  } catch {
    return false;
  }
}
