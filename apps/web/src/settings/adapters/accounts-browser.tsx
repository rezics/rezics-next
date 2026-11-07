import { readManagedAccountActions, readManagedAccountDetail } from './accounts';
import { productionSettingsShellPort, useSettingsSession } from './shell';
import { useContext, useMemo, type ReactNode } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { AccountsProvider } from '../managed-account-capabilities';
import type { AccountsCapability, AccountSessionSource } from '../ports/accounts';

const sources = new WeakMap<QueryClient, AccountSessionSource>();
export function accountSessionSource(client: QueryClient | undefined): AccountSessionSource | undefined {
  if (!client) return undefined;
  let source = sources.get(client);
  if (!source) {
    const port = productionSettingsShellPort;
    source = {
      snapshot: () => port.sessionQueryState(client),
      subscribe: (changed) =>
        client.getQueryCache().subscribe((event) => {
          if (port.isSessionQuery(event.query.queryKey)) changed(event.type === 'removed');
        }),
    };
    sources.set(client, source);
  }
  return source;
}
const readActions: AccountsCapability['readActions'] = (data, signal) =>
  readManagedAccountActions({ data, ...(signal ? { signal } : {}) });
const readDetail: AccountsCapability['readDetail'] = (data, signal) =>
  readManagedAccountDetail({ data, ...(signal ? { signal } : {}) });
const loadRename: AccountsCapability['loadRename'] = () => import('./accounts');
export function NativeAccountsProvider({
  profileHref,
  children,
}: {
  profileHref: AccountsCapability['profileHref'];
  children: ReactNode;
}) {
  const client = useContext(QueryClientContext);
  const session = useSettingsSession();
  const refreshSession = useMemo(
    () => async () => {
      if (client) await productionSettingsShellPort.refreshSession(client);
    },
    [client],
  );
  const value = useMemo<AccountsCapability>(
    () => ({
      session,
      sessionSource: accountSessionSource(client),
      profileHref,
      readActions,
      readDetail,
      loadRename,
      refreshSession,
    }),
    [client, session, profileHref, refreshSession],
  );
  return <AccountsProvider value={value}>{children}</AccountsProvider>;
}
