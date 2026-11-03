import type { ContextDirectoryEntry, DirectoryInput, DirectoryPage, Result } from './model';

/** Explicit fallback when a caller withholds the generated directory producer. */
export interface ContextDirectoryApi {
  list(input: DirectoryInput, headers: Record<string, string>): Promise<Result<DirectoryPage>>;
  lifecycle(id: string, headers: Record<string, string>): Promise<Result<ContextDirectoryEntry>>;
}
export const unavailableContextDirectory: ContextDirectoryApi = {
  list: async () => ({ kind: 'unavailable' }),
  lifecycle: async () => ({ kind: 'unavailable' }),
};
