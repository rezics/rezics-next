/** Stable identity of the Library account erasure obligation. */
import { requireRoute } from './collection-command-work.ts';
export const libraryErasureWorkflowId = (accountId: string) => {
  requireRoute(accountId);
  // Access creates exactly one immutable terminal obligation per never-reused account.
  return `library:erasure:${accountId}`;
};
