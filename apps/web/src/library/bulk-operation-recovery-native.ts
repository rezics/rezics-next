import type { KernelClient } from '@rezics/client';

type NativeOperation = ReturnType<KernelClient['libraryOperations']>;
export type BulkOperation = NonNullable<Awaited<ReturnType<NativeOperation['get']>>['data']>['operation'];
export type BulkOutcomes = NonNullable<Awaited<ReturnType<NativeOperation['outcomes']['get']>>['data']>;
export type ReadFailure = 'forbidden' | 'expired' | 'unavailable' | 'invalid';
export type BulkRead =
  | { state: 'ready'; operation: BulkOperation; page: BulkOutcomes }
  | { state: ReadFailure };
export type CancelResult = { state: 'ready'; operation: BulkOperation } | { state: ReadFailure | 'uncertain' };
export type OperationAddress = Readonly<{ id: string; viewer: string; cursor?: string }>;
export type CancelCommand = Readonly<{ id: string; viewer: string; key: string; csrf: string }>;

export function operationAddress(input: OperationAddress): OperationAddress {
  if (
    !input ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
    typeof input.viewer !== 'string' || !input.viewer.trim() || input.viewer.length > 256 ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096))
  ) throw new Error('Invalid operation address');
  return { id: input.id, viewer: input.viewer, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) };
}

function failure(status: number): ReadFailure {
  return status === 401 || status === 403 ? 'forbidden' : status === 410 ? 'expired' :
    status === 400 || status === 422 ? 'invalid' : 'unavailable';
}

/** Every read remains bounded by the native page size and cursor; no command is created by recovery. */
export async function readNativeOperation(
  client: KernelClient, authorization: string, address: OperationAddress,
): Promise<BulkRead> {
  try {
    const { id, cursor } = operationAddress(address);
    const native = client.libraryOperations({ operationId: id });
    const options = { headers: { authorization } };
    const result = await native.get(options);
    if (result.error || !result.data) return { state: failure(result.status) };
    if (result.data.operation.id !== id) return { state: 'unavailable' };
    if (Date.parse(result.data.operation.resultsExpireAt) <= Date.now()) return { state: 'expired' };
    const page = await native.outcomes.get({ ...options, query: { limit: 20, ...(cursor === undefined ? {} : { cursor }) } });
    if (page.error || !page.data) return { state: failure(page.status) };
    return { state: 'ready', operation: result.data.operation, page: page.data };
  } catch {
    return { state: 'unavailable' };
  }
}

/** The command contains no operands from a refreshed read. Only its original sender may dispatch it. */
export async function cancelNativeOperation(
  client: KernelClient, authorization: string, command: CancelCommand,
): Promise<CancelResult> {
  try {
    operationAddress(command);
    if (!/^[0-9a-f-]{36}$/i.test(command.key)) return { state: 'invalid' };
    const result = await client.libraryOperations({ operationId: command.id }).$cancel.post({}, {
      headers: { authorization, 'idempotency-key': command.key },
    });
    if (result.error || !result.data)
      return { state: result.status >= 500 ? 'uncertain' : failure(result.status) };
    if (result.data.operation.id !== command.id) return { state: 'uncertain' };
    return { state: 'ready', operation: result.data.operation };
  } catch {
    return { state: 'uncertain' };
  }
}
