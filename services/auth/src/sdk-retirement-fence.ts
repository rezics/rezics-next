import {
  DBOS,
  DBOSClient,
  type WorkflowRetirementFailedWork,
  type WorkflowRetirementInvocation,
  type WorkflowRetirementWork,
  type WorkflowWriterFence,
  type WorkflowWriterState,
} from '@dbos-inc/dbos-sdk';

export type {
  WorkflowRetirementFailedWork,
  WorkflowRetirementInvocation,
  WorkflowRetirementWork,
  WorkflowWriterFence,
  WorkflowWriterState,
} from '@dbos-inc/dbos-sdk';
export { WorkflowRetirementBudgetError } from '@dbos-inc/dbos-sdk';

/** Received Work SDK_RETIREMENT_DISPATCH. Envelope identities are reserved
 * before the native call; the SDK then reserves the retire body. Delete
 * identities stay on Work's maintain table and are not used here. */
export const AUTH_SDK_RETIREMENT_DISPATCH = Object.freeze({
  attempt: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
  wait: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
  backoff: { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
  reconcile: { rows: 3, points: 2, statements: 1, bytes: 8192, engineRequests: 0 },
  rollback: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  begin: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  settings: { rows: 1, points: 0, statements: 1, bytes: 128, engineRequests: 0 },
  lock: { rows: 4, points: 2, statements: 4, bytes: 8192, engineRequests: 0 },
  retire: { rows: 8, points: 5, statements: 9, bytes: 32768, engineRequests: 0 },
  commit: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
});

export type AuthSdkRetirementDispatch = keyof typeof AUTH_SDK_RETIREMENT_DISPATCH;
export type AuthSdkFailedWork = WorkflowRetirementFailedWork;

export const AUTH_SDK_RETIREMENT = Object.freeze({
  sdkVersion: '5.5.3-preview',
  closedGeneration: '2',
  liveGeneration: '1',
  deadlineMs: 5_000,
  maxAttempts: 1,
  attemptCeiling: 8,
  gap: 'auth-sdk-permanent-late-writer-fence-unavailable',
  fundedGap: 'auth-sdk-funded-workflow-maintenance-unavailable',
} as const);

type FundedRetireSdk = DBOSClient & {
  retireWorkflow(id: string, invocation: WorkflowRetirementInvocation): Promise<WorkflowRetirementWork>;
  getWorkflowWriterFence(id: string): Promise<unknown>;
  getWorkflowWriterState(id: string): Promise<WorkflowWriterState | null>;
};

let bound: { pool: unknown; client: FundedRetireSdk } | undefined;

function fenceApi(sdk: object): boolean {
  return (
    'retireWorkflow' in sdk &&
    typeof sdk.retireWorkflow === 'function' &&
    'getWorkflowWriterFence' in sdk &&
    typeof sdk.getWorkflowWriterFence === 'function'
  );
}

function fundedApi(sdk: object): sdk is FundedRetireSdk {
  return (
    sdk instanceof DBOSClient &&
    typeof sdk.retireWorkflow === 'function' &&
    typeof sdk.getWorkflowWriterFence === 'function' &&
    typeof sdk.getWorkflowWriterState === 'function'
  );
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? error.code : undefined;
  return code === '57014' || code === 'ETIMEDOUT';
}

export function nativeFence(value: unknown, id: string): WorkflowWriterFence | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'closedAt,closureID,generation,workflowID' ||
    !('workflowID' in value) ||
    value.workflowID !== id ||
    !('generation' in value) ||
    value.generation !== AUTH_SDK_RETIREMENT.closedGeneration ||
    !('closureID' in value) ||
    typeof value.closureID !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.closureID) ||
    !('closedAt' in value) ||
    typeof value.closedAt !== 'number' ||
    !Number.isSafeInteger(value.closedAt) ||
    value.closedAt <= 0
  )
    return null;
  return Object.freeze({
    workflowID: id,
    generation: value.generation,
    closureID: value.closureID,
    closedAt: value.closedAt,
  });
}

export function sameNativeFence(a: WorkflowWriterFence, b: WorkflowWriterFence): boolean {
  return (
    a.workflowID === b.workflowID &&
    a.generation === b.generation &&
    a.closureID === b.closureID &&
    a.closedAt === b.closedAt
  );
}

function sameClosedState(state: WorkflowWriterState, receipt: WorkflowWriterFence): boolean {
  return (
    state.workflowID === receipt.workflowID &&
    state.generation === receipt.generation &&
    state.closureID === receipt.closureID &&
    state.closedAt === receipt.closedAt
  );
}

function failedEntry(value: unknown): AuthSdkFailedWork | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    !('attempt' in value) ||
    typeof value.attempt !== 'number' ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    !('dispatch' in value) ||
    typeof value.dispatch !== 'string' ||
    !(value.dispatch in AUTH_SDK_RETIREMENT_DISPATCH)
  )
    return null;
  return Object.freeze({ attempt: value.attempt, dispatch: value.dispatch });
}

/** Aggregate counters are not the supported ledger; they contribute nothing. */
function failedWorkOf(value: unknown): readonly AuthSdkFailedWork[] {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('failedWork' in value)) return Object.freeze([]);
  if (!Array.isArray(value.failedWork)) return Object.freeze([]);
  const entries = value.failedWork.map(failedEntry).filter((entry): entry is AuthSdkFailedWork => entry !== null);
  return Object.freeze(entries);
}

/** Outcome only. A bare fence is not funded work. */
export function nativeRetirementWork(value: unknown, id: string): WorkflowRetirementWork | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('fence' in value) || !('attempts' in value))
    return null;
  const fence = nativeFence(value.fence, id);
  if (!fence) return null;
  if (typeof value.attempts !== 'number' || !Number.isSafeInteger(value.attempts) || value.attempts < 0) return null;
  return Object.freeze({ fence, attempts: value.attempts, failedWork: failedWorkOf(value) });
}

export async function reserveAuthSdkRetirement(dispatch: string): Promise<void> {
  if (!(dispatch in AUTH_SDK_RETIREMENT_DISPATCH)) throw new TypeError(`Unpriced SDK retirement dispatch: ${dispatch}`);
}

/** One finite Auth operation: a single funded attempt, original deadline. */
export function createAuthSdkRetirementInvocation(
  now = Date.now(),
  signal?: AbortSignal,
): WorkflowRetirementInvocation {
  return {
    deadline: now + AUTH_SDK_RETIREMENT.deadlineMs,
    maxAttempts: AUTH_SDK_RETIREMENT.maxAttempts,
    ...(signal ? { signal } : {}),
    reserve: reserveAuthSdkRetirement,
  };
}

export async function fundAuthSdkRetirementEnvelope(invocation: WorkflowRetirementInvocation): Promise<void> {
  if (
    !Number.isFinite(invocation.deadline) ||
    invocation.deadline <= Date.now() ||
    !Number.isInteger(invocation.maxAttempts) ||
    invocation.maxAttempts < 1 ||
    invocation.maxAttempts > AUTH_SDK_RETIREMENT.attemptCeiling
  )
    throw new Error('Auth SDK retirement deadline has expired');
  await invocation.reserve('attempt');
  await invocation.reserve('wait');
  await invocation.reserve('backoff');
  await invocation.reserve('reconcile');
}

/** Bind the launched copy client. The pool object must be the client's native pool. */
export function bindAuthSdkMaintenance(pool: unknown, client: DBOSClient): void {
  if (!fundedApi(client)) throw new Error(AUTH_SDK_RETIREMENT.fundedGap);
  bound = { pool, client };
}

export function unbindAuthSdkMaintenance(client?: DBOSClient): void {
  if (!client || bound?.client === client) bound = undefined;
}

/** Method presence is availability only, never native closure or source proof. */
export function authSdkRetirementReadiness(): Readonly<{ ready: boolean; gap: string }> {
  return { ready: fenceApi(DBOS), gap: AUTH_SDK_RETIREMENT.gap };
}

export function authSdkFundedReadiness(): Readonly<{ ready: boolean; gap: string }> {
  return { ready: !!bound && fundedApi(bound.client), gap: AUTH_SDK_RETIREMENT.fundedGap };
}

async function observeFence(id: string): Promise<unknown> {
  if (bound && fundedApi(bound.client)) return bound.client.getWorkflowWriterFence(id);
  if (!fenceApi(DBOS)) return null;
  return DBOS.getWorkflowWriterFence(id);
}

/** Only the actual SDK runtime may produce this receipt. Missing migration or
 * malformed/older native coverage stays unavailable; funded I/O errors propagate.
 * Timeout never becomes a missing fence. */
export async function readAuthSdkFence(id: string): Promise<WorkflowWriterFence | null> {
  try {
    if (bound && fundedApi(bound.client)) return nativeFence(await bound.client.getWorkflowWriterFence(id), id);
    if (!fenceApi(DBOS)) return null;
    return nativeFence(await DBOS.getWorkflowWriterFence(id), id);
  } catch (error) {
    if (isTimeoutError(error)) throw error;
    if (bound && fundedApi(bound.client)) throw error;
    return null;
  }
}

async function rereadClosedFence(
  id: string,
  expected?: WorkflowWriterFence | null,
): Promise<WorkflowWriterFence | null> {
  const receipt = nativeFence(await observeFence(id), id);
  const reread = nativeFence(await observeFence(id), id);
  if (!receipt || !reread || !sameNativeFence(receipt, reread)) return null;
  if (expected && !sameNativeFence(expected, receipt)) return null;
  return receipt;
}

async function recoverClosedIdentity(
  id: string,
  expected: WorkflowWriterState | null,
): Promise<WorkflowWriterFence | null> {
  const receipt = await rereadClosedFence(id);
  if (!receipt) return null;
  if (!expected) return receipt;
  if (expected.workflowID !== id) return null;
  if (expected.generation === AUTH_SDK_RETIREMENT.closedGeneration) {
    return sameClosedState(expected, receipt) ? receipt : null;
  }
  return expected.generation === AUTH_SDK_RETIREMENT.liveGeneration ? receipt : null;
}

/** Call only after the original Auth producer and consumer have closed.
 * Auth funds one native attempt, wait, backoff and reconciliation from the
 * original finite operation, then passes that invocation to Accounts'
 * retireWorkflow. Timeout never returns null. */
export async function closeAuthSdkWriters(id: string): Promise<WorkflowWriterFence | null> {
  const maintenance = bound;
  if (!maintenance || !fundedApi(maintenance.client)) throw new Error(AUTH_SDK_RETIREMENT.fundedGap);
  const invocation = createAuthSdkRetirementInvocation();
  await fundAuthSdkRetirementEnvelope(invocation);
  const state = await maintenance.client.getWorkflowWriterState(id);
  if (
    state?.generation === AUTH_SDK_RETIREMENT.closedGeneration &&
    state.closureID !== null &&
    state.closedAt !== null
  ) {
    const current = nativeFence(
      {
        workflowID: state.workflowID,
        generation: state.generation,
        closureID: state.closureID,
        closedAt: state.closedAt,
      },
      id,
    );
    return current ? rereadClosedFence(id, current) : null;
  }
  try {
    const work = nativeRetirementWork(await maintenance.client.retireWorkflow(id, invocation), id);
    return rereadClosedFence(id, work?.fence ?? null);
  } catch (error) {
    const recovered = await recoverClosedIdentity(id, state);
    if (recovered) return recovered;
    throw error;
  }
}

/** Supported payload/FK deletion after permanent writer closure. Timeout and
 * failed deletion propagate; a closed fence is not proof of payload absence. */
export async function deleteAuthSdkPayload(id: string, expected: WorkflowWriterFence): Promise<void> {
  const maintenance = bound;
  if (!maintenance || !fundedApi(maintenance.client)) throw new Error(AUTH_SDK_RETIREMENT.fundedGap);
  const state = await maintenance.client.getWorkflowWriterState(id);
  if (!state || !sameClosedState(state, expected)) throw new Error('auth-sdk-native-fence-receipt-mismatch');
  await maintenance.client.deleteWorkflows([id], false);
}
