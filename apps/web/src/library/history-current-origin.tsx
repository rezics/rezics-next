import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { useLibraryApplication } from './application';
import { CancelledError } from '@tanstack/react-query';
import type { GatedOperation } from './application';

export type HistoryOrigin = { lifetime: object; isCurrent: () => boolean };

export function useHistoryCurrentOrigin(
  address: string,
  operations: readonly GatedOperation[],
  serverSubject: string | null = null,
  parent?: HistoryOrigin,
  previewAllowed?: readonly boolean[],
) {
  return useLibraryApplication().useReaderCurrentOrigin(address, operations, serverSubject, parent, previewAllowed);
}
export function useHistoryAddress(path: string | null, cursor: string | undefined, locale: string) {
  return useLibraryApplication().useReaderAddress(path, cursor, locale);
}
export function useHistoryReadOrigin(client: QueryClient, key: QueryKey, matches: (value: unknown) => boolean) {
  return useLibraryApplication().useReaderResponseOrigin(client, key, matches);
}
export function assertHistoryCurrent(current: () => boolean, signal?: AbortSignal) {
  if (signal?.aborted || !current()) throw new CancelledError({ silent: true });
}
