import { readManagedAccountActions, readManagedAccountDetail } from './accounts';
import { useContext, useMemo, type ReactNode } from 'react';
import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { sessionQuery, useSession } from '../../session/query';
import { AccountsProvider } from '../managed-account-capabilities';
import type { AccountsCapability, AccountSession, AccountSessionSource } from '../ports/accounts';

const sources = new WeakMap<QueryClient, AccountSessionSource>();
export function accountSessionSource(client: QueryClient | undefined): AccountSessionSource | undefined {
  if (!client) return undefined;
  let source = sources.get(client);
  if (!source) {
    source = {
      snapshot: () => client.getQueryState<AccountSession>(sessionQuery.queryKey),
      subscribe: (changed) =>
        client.getQueryCache().subscribe((event) => {
          if (event.query.queryKey.length === 1 && event.query.queryKey[0] === sessionQuery.queryKey[0])
            changed(event.type === 'removed');
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
  const session = useSession();
  const refreshSession = useMemo(
    () => async () => {
      if (client) await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
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
