import {
  DBOS,
  DBOSClient,
  WORKFLOW_RETIREMENT_DISPATCH,
  WORKFLOW_RETIREMENT_MAX_ATTEMPTS,
  type WorkflowRetirementFailedWork,
  type WorkflowRetirementInvocation,
  type WorkflowRetirementOutcome as WorkflowRetirementWork,
  type WorkflowWriterFence,
  type WorkflowWriterState,
} from '@dbos-inc/dbos-sdk';

export type {
  WorkflowRetirementDispatch,
  WorkflowRetirementOutcome,
  WorkflowRetirementFailedWork,
  WorkflowRetirementInvocation,
  WorkflowRetirementOutcome as WorkflowRetirementWork,
  WorkflowWriterFence,
  WorkflowWriterState,
} from '@dbos-inc/dbos-sdk';
export {
  WORKFLOW_RETIREMENT_DISPATCH,
  WORKFLOW_RETIREMENT_MAX_ATTEMPTS,
  WorkflowRetirementBudgetError,
} from '@dbos-inc/dbos-sdk';

import type { Pool } from 'pg';
import { createAuthRetentionInvocation } from './core/index.ts';
import {
  AUTH_SDK_RETIREMENT_DISPATCH,
  type AuthRetentionInvocation,
  type AuthSdkRetirementDispatch,
} from './contract/index.ts';
export { AUTH_SDK_RETIREMENT_DISPATCH, type AuthSdkRetirementDispatch } from './contract/index.ts';

export type AuthSdkFailedWork = WorkflowRetirementFailedWork;

export const AUTH_SDK_RETIREMENT = Object.freeze({
  sdkVersion: '5.5.3-preview',
  closedGeneration: '2',
  liveGeneration: '1',
  deadlineMs: 5_000,
  maxAttempts: 1,
  attemptCeiling: WORKFLOW_RETIREMENT_MAX_ATTEMPTS,
  gap: 'auth-sdk-permanent-late-writer-fence-unavailable',
  fundedGap: 'auth-sdk-funded-workflow-maintenance-unavailable',
} as const);

type FundedRetireSdk = DBOSClient & {
  retireWorkflow(id: string, invocation: WorkflowRetirementInvocation): Promise<WorkflowRetirementWork>;
  getWorkflowWriterFence(id: string): Promise<unknown>;
  getWorkflowWriterState(id: string): Promise<WorkflowWriterState | null>;
};

let bound: { pool: Pool; client: FundedRetireSdk } | undefined;

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
    typeof sdk.getWorkflowWriterState === 'function' &&
    typeof sdk.maintainWorkflowOnce === 'function'
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
    typeof value.dispatch !== 'string'
  )
    return null;
  const dispatch = WORKFLOW_RETIREMENT_DISPATCH.find((dispatch) => dispatch === value.dispatch);
  return dispatch ? Object.freeze({ attempt: value.attempt, dispatch }) : null;
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

/** Public dispatch receiver: a name alone supplies no funding. */
export async function reserveAuthSdkRetirement(dispatch: string, invocation: AuthRetentionInvocation): Promise<void> {
  if (!Object.hasOwn(AUTH_SDK_RETIREMENT_DISPATCH, dispatch))
    throw new TypeError(`Unpriced SDK retirement dispatch: ${dispatch}`);
  await invocation.reserve(dispatch as AuthSdkRetirementDispatch);
}

export function createAuthSdkRetirementInvocation(now = Date.now(), signal?: AbortSignal): AuthRetentionInvocation {
  return createAuthRetentionInvocation({ deadline: now + AUTH_SDK_RETIREMENT.deadlineMs, signal });
}

export async function fundAuthSdkRetirementEnvelope(
  invocation: Omit<WorkflowRetirementInvocation, 'reserve'> & {
    reserve(dispatch: AuthSdkRetirementDispatch): Promise<void>;
  },
): Promise<void> {
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
export function bindAuthSdkMaintenance(pool: Pool, client: DBOSClient): void {
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

/** Only the actual SDK runtime may produce this receipt. Missing migration or
 * malformed/older native coverage stays unavailable; funded I/O errors propagate.
 * Timeout never becomes a missing fence. */
export async function readAuthSdkFence(
  id: string,
  invocation?: AuthRetentionInvocation,
): Promise<WorkflowWriterFence | null> {
  if (invocation) await invocation.charge('fence-read');
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

/** Call only after the original Auth producer and consumer have closed.
 * The SDK reserves every dispatch against the same finite invocation and returns
 * its canonical native receipt after COMMIT. Unresolved failures propagate to
 * maintenance; Auth must not recover through reads outside that budget. */
export async function closeAuthSdkWriters(
  id: string,
  invocation: AuthRetentionInvocation = createAuthSdkRetirementInvocation(),
  personal = true,
): Promise<WorkflowWriterFence | null> {
  const maintenance = bound;
  if (!maintenance || !fundedApi(maintenance.client)) throw new Error(AUTH_SDK_RETIREMENT.fundedGap);
  invocation.check();
  // The recorder can run on every admitted native attempt, including a retry
  // whose earlier transaction rolled back. Reserve that complete expansion.
  if (personal)
    for (let attempt = 0; attempt < invocation.maxAttempts; attempt++) await invocation.charge('closure-recorder');
  let value: WorkflowRetirementWork;
  try {
    value = await maintenance.client.retireWorkflow(id, invocation);
  } catch (error) {
    const attempts =
      error && typeof error === 'object' && 'attempts' in error && typeof error.attempts === 'number'
        ? error.attempts
        : 0;
    invocation.record({ workflowID: id, attempts, failedWork: failedWorkOf(error), failed: true });
    throw error;
  }
  const work = nativeRetirementWork(value, id);
  if (!work) throw new Error('auth-sdk-funded-retirement-outcome-invalid');
  invocation.record({ workflowID: id, attempts: work.attempts, failedWork: work.failedWork, failed: false });
  return work.fence;
}

/** Deletion uses the installed native one-shot producer, the same native pool
 * and restore/fence observation. No retry loop or cancellation write is added. */
export async function deleteAuthSdkPayload(
  id: string,
  expected: WorkflowWriterFence,
  invocation: AuthRetentionInvocation = createAuthSdkRetirementInvocation(),
): Promise<void> {
  const maintenance = bound;
  if (!maintenance || !fundedApi(maintenance.client)) throw new Error(AUTH_SDK_RETIREMENT.fundedGap);
  await invocation.charge('state-read');
  const state = await maintenance.client.getWorkflowWriterState(id);
  if (!state || !sameClosedState(state, expected)) throw new Error('auth-sdk-native-fence-receipt-mismatch');
  invocation.check();
  await maintenance.client.maintainWorkflowOnce(
    maintenance.pool,
    state,
    'delete',
    invocation.deadline,
    invocation.reserveDelete,
  );
}

/** Technical names have no personal custody expansion, but native writer/fence,
 * restore and payload deletion work still belongs to this caller. */
export async function deleteAuthSdkTechnical(
  ids: readonly string[],
  invocation: AuthRetentionInvocation,
): Promise<void> {
  for (const id of ids) {
    const receipt = await closeAuthSdkWriters(id, invocation, false);
    if (!receipt) throw new Error('auth-sdk-native-fence-receipt-missing');
    await deleteAuthSdkPayload(id, receipt, invocation);
  }
}
