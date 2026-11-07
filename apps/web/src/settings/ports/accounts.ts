import type { ManagedAccountActionsIO } from '../managed-account-vocabulary';
import type { DetailRead } from '../managed-account-contract';
import type { AccountRenameResult } from '../account-rename-actions';

export type AccountNavigationPath =
  | '/account/rename'
  | '/organizations/members'
  | '/operators/transfer'
  | '/organizations/delete';
export type AccountNavigationHref = (path: AccountNavigationPath, targetId?: string) => string | null;
export type AccountSession = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
  csrfToken: string | null;
};
export type AccountSessionObservation = { status: string; data?: AccountSession | undefined };
/** Stable snapshots and removal notifications are supplied by the browser session adapter. */
export interface AccountSessionSource {
  snapshot(): AccountSessionObservation | undefined;
  subscribe(changed: (removed: boolean) => void): () => void;
}
export interface AccountsCapability {
  readonly session: AccountSession;
  readonly sessionSource: AccountSessionSource | undefined;
  readonly profileHref: (accountId: string) => string | null;
  readonly readActions: ManagedAccountActionsIO;
  readonly readDetail: DetailRead;
  readonly loadRename: () => Promise<{
    readAccountRename: (options: { headers: HeadersInit; signal?: AbortSignal }) => Promise<AccountRenameResult>;
  }>;
  readonly refreshSession: () => Promise<unknown>;
}
