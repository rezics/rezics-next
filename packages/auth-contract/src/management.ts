import type { AccountOperation, WorkflowResponsibility } from './index';

/** Registration ceiling only. A live page requests exactly one operation profile. */
export const AUTH_MANAGEMENT_CLIENT_ID = 'rezics-auth-account-management';
export const AUTH_MANAGEMENT_SCOPES = Object.freeze({
  rename: Object.freeze(['account:update'] as const),
  membership: Object.freeze(['organization:membership'] as const),
  transfer: Object.freeze(['account:manage'] as const),
  'transfer-acceptance': Object.freeze(['account:manage'] as const),
  opening: Object.freeze(['account:manage'] as const),
});

export type ManagementOperation =
  | Omit<Extract<AccountOperation, { kind: 'opening' }>, 'authorization'>
  | Omit<Extract<AccountOperation, { kind: 'rename' }>, 'authorization'>
  | Omit<Extract<AccountOperation, { kind: 'membership' }>, 'authorization'>
  | (Omit<Extract<AccountOperation, { kind: 'transfer' }>, 'authorization'> & { acceptance?: string })
  | {
      kind: 'transfer-acceptance';
      previous: WorkflowResponsibility;
      expectedVersion: string;
      operatorAccountId: string;
      sourceOperationKey: string;
    };
export type ManagementOperationKind = ManagementOperation['kind'];
export type ManagementSession = {
  accountId: string;
  clientId: string;
  scopes: string[];
  authTime: number;
  authnEpoch: number;
  amr: ('pwd' | 'pop')[];
};
export type ManagementSessionResult =
  | ({ kind: 'ready' } & ManagementSession)
  | { kind: 'signed-out' }
  | { kind: 'unavailable' };
export type ManagementOperationResult =
  | {
      kind: 'complete';
      operationKind: Exclude<ManagementOperationKind, 'transfer-acceptance' | 'opening'>;
      accountId: string;
    }
  | { kind: 'complete'; operationKind: 'transfer-acceptance'; reference: string; expiresAt: string }
  | { kind: 'refused' }
  | { kind: 'step-up' }
  | { kind: 'unknown' }
  | { kind: 'unavailable' };
export type ManagementOperationInput = {
  operationKey: string;
  operation: ManagementOperation;
  /** The initiating human, which may differ from the operation's managed subject. */
  accountId: string;
};

export function managementOperationProfile(kind: ManagementOperationKind) {
  return { client_id: AUTH_MANAGEMENT_CLIENT_ID, scope: [...AUTH_MANAGEMENT_SCOPES[kind]] };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
/** Closed native descriptors only; no authorization, Actor, proof or callback input. */
export function isManagementOperation(value: unknown): value is ManagementOperation {
  if (!record(value)) return false;
  if (value.kind === 'opening')
    return (
      fields(value, ['kind', 'operatorAccountId', 'subjectAccountId']) &&
      text(value.operatorAccountId) &&
      text(value.subjectAccountId) &&
      value.operatorAccountId !== value.subjectAccountId
    );
  if (value.kind === 'rename')
    return (
      fields(value, ['kind', 'accountId', 'handle', 'expectedHandle']) &&
      text(value.accountId) &&
      typeof value.handle === 'string' &&
      /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/.test(value.handle) &&
      (value.expectedHandle === null || text(value.expectedHandle))
    );
  if (value.kind === 'membership')
    return (
      fields(value, ['kind', 'organizationId', 'memberAccountId', 'role'], ['reservationId']) &&
      text(value.organizationId) &&
      text(value.memberAccountId) &&
      (value.role === 'owner' || value.role === 'member' || value.role === null) &&
      (value.reservationId === undefined || text(value.reservationId)) &&
      (value.role !== null || text(value.reservationId))
    );
  if (value.kind !== 'transfer' && value.kind !== 'transfer-acceptance') return false;
  const previous = value.previous;
  return (
    fields(
      value,
      [
        'kind',
        'previous',
        'expectedVersion',
        'operatorAccountId',
        ...(value.kind === 'transfer-acceptance' ? ['sourceOperationKey'] : []),
      ],
      value.kind === 'transfer' ? ['acceptance'] : [],
    ) &&
    record(previous) &&
    fields(previous, ['operatorAccountId', 'subjectAccountId', 'reservationId']) &&
    text(previous.operatorAccountId) &&
    text(previous.subjectAccountId) &&
    text(previous.reservationId) &&
    text(value.expectedVersion) &&
    text(value.operatorAccountId) &&
    (value.kind === 'transfer-acceptance'
      ? text(value.sourceOperationKey)
      : value.acceptance === undefined || text(value.acceptance))
  );
}
