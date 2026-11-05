import type { Kernel, KernelClient } from '@rezics/client';
import type { FilteredStatusResult } from './bulk-filtered-status';
type Admission = Extract<Kernel['~Routes']['v1']['libraryOperations']['post']['body'], { action: 'set_status' }>;
const failure = (status: number): FilteredStatusResult => ({
  kind:
    status === 202
      ? 'preparing'
      : status === 413
        ? 'limit'
        : status === 400 || status === 422
          ? 'unsupported'
          : status === 401 || status === 403 || status === 404
            ? 'denied'
            : 'unavailable',
});

export async function previewFilteredStatusNative(
  client: KernelClient,
  body: string,
  headers: Record<string, string>,
): Promise<FilteredStatusResult> {
  const result = await client.libraryOperations.post(JSON.parse(body) as Admission, {
    headers: { ...headers, 'idempotency-key': headers['idempotency-key']! },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  if ((result.status === 200 || result.status === 201) && !result.error && result.data && 'operation' in result.data)
    return { kind: 'ready', operation: result.data.operation };
  return failure(result.status);
}
export async function confirmFilteredStatusNative(
  client: KernelClient,
  id: string,
  headers: Record<string, string>,
): Promise<FilteredStatusResult> {
  const result = await client.libraryOperations({ operationId: id }).$confirm.post(
    {},
    {
      headers: { ...headers, 'idempotency-key': headers['idempotency-key']! },
      fetch: { cache: 'no-store', redirect: 'manual' },
    },
  );
  if (!result.error && result.data) return { kind: 'ready', operation: result.data.operation };
  return failure(result.status);
}
