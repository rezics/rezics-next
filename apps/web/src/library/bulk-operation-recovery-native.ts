import type { KernelClient } from '@rezics/client';

type NativeOperation = ReturnType<KernelClient['libraryOperations']>;
export type BulkOperation = NonNullable<Awaited<ReturnType<NativeOperation['get']>>['data']>['operation'];
export type BulkOutcomes = NonNullable<Awaited<ReturnType<NativeOperation['outcomes']['get']>>['data']>;
export type ReadFailure = 'forbidden' | 'expired' | 'unavailable' | 'invalid';
export type BulkRead = { state: 'ready'; operation: BulkOperation; page: BulkOutcomes } | { state: ReadFailure };
export type CancelResult = { state: 'ready'; operation: BulkOperation } | { state: ReadFailure | 'uncertain' };
export type OperationAddress = Readonly<{ id: string; viewer: string; cursor?: string }>;
export type CancelCommand = Readonly<{ id: string; viewer: string; key: string; csrf: string }>;

export function operationAddress(input: OperationAddress): OperationAddress {
  if (
    !input ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
    typeof input.viewer !== 'string' ||
    !input.viewer.trim() ||
    input.viewer.length > 256 ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
  )
    throw new Error('Invalid operation address');
  return { id: input.id, viewer: input.viewer, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
}

function failure(status: number): ReadFailure {
  return status === 401 || status === 403
    ? 'forbidden'
    : status === 410
      ? 'expired'
      : status === 400 || status === 422
        ? 'invalid'
        : 'unavailable';
}

/** Every read remains bounded by the native page size and cursor; no command is created by recovery. */
export async function readNativeOperation(
  client: KernelClient,
  authorization: string,
  address: OperationAddress,
): Promise<BulkRead> {
  try {
    const { id, cursor } = operationAddress(address);
    const native = client.libraryOperations({ operationId: id });
    const options = { headers: { authorization } };
    const result = await native.get(options);
    if (result.error || !result.data) return { state: failure(result.status) };
    if (result.data.operation.id !== id) return { state: 'unavailable' };
    if (Date.parse(result.data.operation.resultsExpireAt) <= Date.now()) return { state: 'expired' };
    const page = await native.outcomes.get({
      ...options,
      query: { limit: 20, ...(cursor === undefined ? {} : { cursor }) },
    });
    if (page.error || !page.data) return { state: failure(page.status) };
    return { state: 'ready', operation: result.data.operation, page: page.data };
  } catch {
    return { state: 'unavailable' };
  }
}

/** The command contains no operands from a refreshed read. Only its original sender may dispatch it. */
export async function cancelNativeOperation(
  client: KernelClient,
  authorization: string,
  command: CancelCommand,
): Promise<CancelResult> {
  try {
    operationAddress(command);
    if (!/^[0-9a-f-]{36}$/i.test(command.key)) return { state: 'invalid' };
    const headers = { authorization, 'idempotency-key': command.key };
    const result = await client.libraryOperations({ operationId: command.id }).$cancel.post({}, { headers });
    if (result.error || !result.data) return { state: result.status >= 500 ? 'uncertain' : failure(result.status) };
    if (result.data.operation.id !== command.id) return { state: 'uncertain' };
    return { state: 'ready', operation: result.data.operation };
  } catch {
    return { state: 'uncertain' };
  }
}


export type CapturedCancelCommand = {
  version: 1;
  operationId: string;
  sender: string;
  method: 'POST';
  path: string;
  locale: string;
  headers: {
    authorization: string;
    'idempotency-key': string;
    'accept-language': string;
    'content-type': 'application/json';
  };
  body: Record<string, never>;
};

export type BulkRecoveryNativeRead =
  | { state: 'available'; operation: BulkOperation; outcomes: BulkOutcomes['outcomes']; next: string | null }
  | { state: 'expired' | 'forbidden' | 'unavailable'; operationId: string };
export type BulkOutcomePageRead =
  | { state: 'available'; page: BulkOutcomes }
  | { state: 'expired' | 'forbidden' | 'unavailable'; operationId: string };

function failureState(status: number, missingMeansExpired = false): 'expired' | 'forbidden' | 'unavailable' {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404 && missingMeansExpired) return 'expired';
  return 'unavailable';
}

/** Read the stored operation and its first bounded native result page. */
export async function readBulkOperationFromNative(
  client: KernelClient,
  operationId: string,
  authorization: string,
): Promise<BulkRecoveryNativeRead> {
  const operationResult = await client.libraryOperations({ operationId }).get({
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (operationResult.status !== 200 || operationResult.error || !operationResult.data?.operation)
    return { state: failureState(operationResult.status), operationId };
  const operation = operationResult.data.operation;
  if (operation.id !== operationId) return { state: 'unavailable', operationId };

  const resultPage = await client.libraryOperations({ operationId }).outcomes.get({
    query: { limit: 20 },
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (resultPage.status !== 200 || resultPage.error || !resultPage.data)
    return { state: failureState(resultPage.status, true), operationId };
  return {
    state: 'available',
    operation,
    outcomes: resultPage.data.outcomes,
    next: resultPage.data.next,
  };
}

/** Keep later result reads on the same operation and native cursor. */
export async function readBulkOperationPageFromNative(
  client: KernelClient,
  operationId: string,
  cursor: string,
  authorization: string,
): Promise<BulkOutcomePageRead> {
  const result = await client.libraryOperations({ operationId }).outcomes.get({
    query: { limit: 20, cursor },
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if (result.status !== 200 || result.error || !result.data)
    return { state: failureState(result.status, true), operationId };
  return { state: 'available', page: result.data };
}

/** Replay the exact captured native cancellation command after an uncertain result. */
export function sendCapturedBulkCancelCommand(client: KernelClient, command: CapturedCancelCommand) {
  return client.libraryOperations({ operationId: command.operationId }).$cancel.post(command.body, {
    headers: command.headers,
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
}
