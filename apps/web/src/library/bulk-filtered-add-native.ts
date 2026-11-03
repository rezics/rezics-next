import type { Kernel, KernelClient } from '@rezics/client';
import type { FilteredAddCapture } from './bulk-filtered-add';

type Routes = Kernel['~Routes']['v1']['libraryOperations'];
type AddRequest = Extract<Routes['post']['body'], { action: 'add_to_collection' }>;
export type FilteredAddRequest = AddRequest & { selection: Extract<AddRequest['selection'], { kind: 'query' }> };
export type FilteredAddOperation = Routes[':operationId']['get']['response'][200]['operation'];
export type FilteredAddPage = Routes[':operationId']['outcomes']['get']['response'][200];
export type FilteredAddCommand = Readonly<{
  capture: FilteredAddCapture;
  sender: string;
  /** Session-bound encryption of the original native credential, never refreshed by read recovery. */
  credential: string;
  headers: Readonly<Record<string, string>>;
  previewKey: string;
  confirmKey: string;
}>;
export type FilteredAddFailure =
  | 'preparing'
  | 'unsupported'
  | 'limit'
  | 'changed'
  | 'forbidden'
  | 'unavailable'
  | 'uncertain';
export type FilteredAddResult = { state: 'ready'; operation: FilteredAddOperation } | { state: FilteredAddFailure };
export type FilteredAddRead =
  | { state: 'ready'; operation: FilteredAddOperation; page: FilteredAddPage }
  | { state: 'unavailable' | 'forbidden' | 'expired' };

/** Dispatch one installed native command. In particular, a preparing 202 has no operation to confirm. */
export async function sendFilteredAdd(
  client: KernelClient,
  authorization: string,
  command: FilteredAddCommand,
  operationId?: string,
): Promise<FilteredAddResult> {
  try {
    const options = {
      headers: {
        ...command.headers,
        authorization,
        'idempotency-key': operationId === undefined ? command.previewKey : command.confirmKey,
      },
      fetch: { cache: 'no-store', redirect: 'manual' } as const,
    };
    const result =
      operationId === undefined
        ? await client.libraryOperations.post(command.capture.request, options)
        : await client.libraryOperations({ operationId }).$confirm.post({}, options);
    if (result.data && 'operation' in result.data && !result.error)
      return { state: 'ready', operation: result.data.operation };
    if (result.status === 202 && result.data && 'preparing' in result.data && result.data.preparing === true)
      return { state: 'preparing' };
    if (result.status === 401 || result.status === 403 || result.status === 404) return { state: 'forbidden' };
    if (result.status === 409 || result.status === 410) return { state: 'changed' };
    if (result.status === 413) return { state: 'limit' };
    if (result.status === 400 || result.status === 422) return { state: 'unsupported' };
    // Native dependency_unavailable explicitly declines preparation; it is not an empty capture.
    const problem = result.error?.value;
    if (
      result.status === 503 &&
      problem &&
      typeof problem === 'object' &&
      'code' in problem &&
      problem.code === 'dependency_unavailable'
    )
      return { state: 'unavailable' };
    return { state: 'uncertain' };
  } catch {
    return { state: 'uncertain' };
  }
}
