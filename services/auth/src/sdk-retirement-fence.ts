import { DBOS, type WorkflowWriterFence } from '@dbos-inc/dbos-sdk';

export type { WorkflowWriterFence } from '@dbos-inc/dbos-sdk';

export const AUTH_SDK_RETIREMENT = Object.freeze({
  sdkVersion: '5.4.6-preview',
  closedGeneration: '2',
  gap: 'auth-sdk-permanent-late-writer-fence-unavailable',
} as const);

function supported(sdk: object): boolean {
  return (
    'retireWorkflow' in sdk &&
    typeof sdk.retireWorkflow === 'function' &&
    'getWorkflowWriterFence' in sdk &&
    typeof sdk.getWorkflowWriterFence === 'function'
  );
}

/** Method presence is availability only, never native closure or source proof. */
export function authSdkRetirementReadiness(): Readonly<{ ready: boolean; gap: string }> {
  return { ready: supported(DBOS), gap: AUTH_SDK_RETIREMENT.gap };
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

/** Only the actual SDK runtime may produce this receipt. Missing migration or
 * malformed/older native coverage stays unavailable; no raw error is retained. */
export async function readAuthSdkFence(id: string): Promise<WorkflowWriterFence | null> {
  if (!supported(DBOS)) return null;
  try {
    return nativeFence(await DBOS.getWorkflowWriterFence(id), id);
  } catch {
    return null;
  }
}

/** Call only after the original Auth producer and consumer have closed. The
 * supported native reread must agree on all four fields before local retirement. */
export async function closeAuthSdkWriters(id: string): Promise<WorkflowWriterFence | null> {
  if (!supported(DBOS)) return null;
  try {
    // Probe the actual native API before invoking retirement. A declaration with
    // no installed native migration must fail here, without any cancellation.
    const previous = await DBOS.getWorkflowWriterFence(id);
    if (previous !== null && !nativeFence(previous, id)) return null;
    const receipt = nativeFence(await DBOS.retireWorkflow(id), id);
    const reread = await readAuthSdkFence(id);
    return receipt &&
      reread &&
      sameNativeFence(receipt, reread) &&
      (previous === null || sameNativeFence(previous, receipt))
      ? receipt
      : null;
  } catch {
    return null;
  }
}
