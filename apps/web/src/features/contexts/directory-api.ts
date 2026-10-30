import type { ContextDirectoryEntry, DirectoryInput, DirectoryPage, Result } from './model';

/** Provisional bindings for the agreed GET /v1/contexts and GET /v1/contexts/{id}/lifecycle.
 * Neither native route is present in the generated client on this base. No catalogue scan or synthetic rows.
 * Replace only these unavailable methods with their generated equivalents when the producer lands.
 */
export interface ContextDirectoryApi {
  list(input: DirectoryInput, headers: Record<string, string>): Promise<Result<DirectoryPage>>;
  lifecycle(id: string, headers: Record<string, string>): Promise<Result<ContextDirectoryEntry>>;
}
export const unavailableContextDirectory: ContextDirectoryApi = {
  list: async () => ({ kind: 'unavailable' }),
  lifecycle: async () => ({ kind: 'unavailable' }),
};
