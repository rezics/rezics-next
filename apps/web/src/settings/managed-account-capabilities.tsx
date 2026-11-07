import { createContext, useContext, type ReactNode } from 'react';
import type { AccountsCapability } from './ports/accounts';

/** Uncomposed previews are closed; ordinary routes install native capabilities explicitly. */
const unavailable: AccountsCapability = {
  session: { state: 'unknown', csrfToken: null },
  sessionSource: undefined,
  profileHref: () => null,
  readActions: async () => ({ state: 'unavailable', status: null, code: null }),
  readDetail: async () => ({ ok: false, failure: { status: null, transient: true } }),
  loadRename: async () => ({ readAccountRename: async () => ({ context: null }) }),
  refreshSession: async () => {},
};
const AccountsContext = createContext<AccountsCapability>(unavailable);
export function AccountsProvider({ value, children }: { value: AccountsCapability; children: ReactNode }) {
  return <AccountsContext.Provider value={value}>{children}</AccountsContext.Provider>;
}
export function useAccounts(): AccountsCapability {
  return useContext(AccountsContext);
}
