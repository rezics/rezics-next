import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { NativeAccountsProvider } from '../../src/settings/adapters/accounts-browser';
import { accountProfileHref } from '../../src/accounts/profile-editor/address';

export function AccountsQueryProvider({ client, children }: { client: QueryClient; children?: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <NativeAccountsProvider profileHref={accountProfileHref}>{children}</NativeAccountsProvider>
    </QueryClientProvider>
  );
}
