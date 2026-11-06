import { DBOS, DBOSClient, type WorkflowWriterFence, type WorkflowWriterState } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';

export type { WorkflowWriterFence, WorkflowWriterState } from '@dbos-inc/dbos-sdk';

/** Received Accounts SDK dispatch costs for one funded maintainWorkflowOnce attempt. */
export const AUTH_SDK_MAINTENANCE_DISPATCH = Object.freeze({
  rollback: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  begin: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  settings: { rows: 1, points: 0, statements: 1, bytes: 128, engineRequests: 0 },
  lock: { rows: 4, points: 2, statements: 4, bytes: 8192, engineRequests: 0 },
  retire: { rows: 8, points: 5, statements: 9, bytes: 32768, engineRequests: 0 },
  commit: { rows: 0, points: 0, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-workflow_input': { rows: 1, points: 1, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-workflow_output': { rows: 1, points: 1, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-operation_outputs': { rows: 64, points: 1, statements: 1, bytes: 0, engineRequests: 0 },
  'delete-workflow_status': { rows: 73, points: 5, statements: 5, bytes: 0, engineRequests: 0 },
});

export type AuthSdkMaintenanceDispatch = keyof typeof AUTH_SDK_MAINTENANCE_DISPATCH;

export const AUTH_SDK_RETIREMENT = Object.freeze({
  sdkVersion: '5.4.6-preview',
  closedGeneration: '2',
  liveGeneration: '1',
  deadlineMs: 5_000,
  gap: 'auth-sdk-permanent-late-writer-fence-unavailable',
  fundedGap: 'auth-sdk-funded-workflow-maintenance-unavailable',
} as const);

type BoundedSdk = DBOSClient & {
  maintainWorkflowOnce(
    pool: Pool,
    expected: WorkflowWriterState,
    action: 'retire' | 'delete',
    deadline: number,
    reserve: (dispatch: string) => Promise<void>,
  ): Promise<WorkflowWriterFence | null>;
  getWorkflowWriterState(id: string): Promise<WorkflowWriterState | null>;
};

let bound: { pool: Pool; client: BoundedSdk } | undefined;

function fenceApi(sdk: object): boolean {
  return (
    'retireWorkflow' in sdk &&
    typeof sdk.retireWorkflow === 'function' &&
    'getWorkflowWriterFence' in sdk &&
    typeof sdk.getWorkflowWriterFence === 'function'
  );
}

function fundedApi(sdk: object): sdk is BoundedSdk {
  return (
    sdk instanceof DBOSClient &&
    'maintainWorkflowOnce' in sdk &&
    typeof sdk.maintainWorkflowOnce === 'function' &&
    'getWorkflowWriterState' in sdk &&
    typeof sdk.getWorkflowWriterState === 'function' &&
    'getWorkflowWriterFence' in sdk &&
    typeof sdk.getWorkflowWriterFence === 'function'
  );
}

export async function reserveAuthSdkMaintenance(dispatch: string): Promise<void> {
  if (!(dispatch in AUTH_SDK_MAINTENANCE_DISPATCH))
    throw new TypeError(`Unpriced SDK maintenance dispatch: ${dispatch}`);
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

async function observeFence(id: string): Promise<unknown> {
  if (bound && fundedApi(bound.client)) return bound.client.getWorkflowWriterFence(id);
  if (!fenceApi(DBOS)) return null;
  return DBOS.getWorkflowWriterFence(id);
}

/** Only the actual SDK runtime may produce this receipt. Missing migration or
 * malformed/older native coverage stays unavailable; funded I/O errors propagate.
 * Timeout never becomes a missing fence. */
export async function readAuthSdkFence(id: string): Promise<WorkflowWriterFence | null> {
  if (bound && fundedApi(bound.client)) return nativeFence(await bound.client.getWorkflowWriterFence(id), id);
  if (!fenceApi(DBOS)) return null;
  try {
    return nativeFence(await DBOS.getWorkflowWriterFence(id), id);
  } catch {
    return null;
  }
}

async function maintainOnce(
  expected: WorkflowWriterState,
  action: 'retire' | 'delete',
): Promise<WorkflowWriterFence | null> {
  const maintenance = bound;
  if (!maintenance || !fundedApi(maintenance.client)) throw new Error(AUTH_SDK_RETIREMENT.fundedGap);
  return maintenance.client.maintainWorkflowOnce(
    maintenance.pool,
    expected,
    action,
    Date.now() + AUTH_SDK_RETIREMENT.deadlineMs,
    reserveAuthSdkMaintenance,
  );
}

/** Call only after the original Auth producer and consumer have closed. One funded
 * attempt; a lost reply rereads the same writer identity. Timeout never returns null. */
export async function closeAuthSdkWriters(id: string): Promise<WorkflowWriterFence | null> {
  const maintenance = bound;
  if (!maintenance || !fundedApi(maintenance.client)) return null;
  const state = await maintenance.client.getWorkflowWriterState(id);
  if (!state) return null;
  if (state.generation === AUTH_SDK_RETIREMENT.liveGeneration) await maintainOnce(state, 'retire');
  else if (state.generation !== AUTH_SDK_RETIREMENT.closedGeneration) return null;
  const receipt = nativeFence(await observeFence(id), id);
  const reread = nativeFence(await observeFence(id), id);
  return receipt && reread && sameNativeFence(receipt, reread) ? receipt : null;
}

/** One funded payload/FK deletion after permanent writer closure. Replay uses the
 * original closed identity; timeout and uncertain COMMIT propagate. */
export async function deleteAuthSdkPayload(id: string, expected: WorkflowWriterFence): Promise<void> {
  const maintenance = bound;
  if (!maintenance || !fundedApi(maintenance.client)) throw new Error(AUTH_SDK_RETIREMENT.fundedGap);
  const state = await maintenance.client.getWorkflowWriterState(id);
  if (!state || !sameClosedState(state, expected)) throw new Error('auth-sdk-native-fence-receipt-mismatch');
  await maintainOnce(state, 'delete');
}
