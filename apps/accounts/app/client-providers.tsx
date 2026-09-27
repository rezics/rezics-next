'use client';

import { useRouter } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { AccountClientProvider } from '../features/api/account-client.tsx';
import { browserAccountApi } from '../features/api/client.ts';

export function ClientProviders({ children }: { children: ReactNode }) {
  const router = useRouter();
  const value = useMemo(() => ({ api: browserAccountApi,
    navigate: (url: string) => window.location.assign(url), refresh: () => router.refresh() }), [router]);
  return <AccountClientProvider value={value}>{children}</AccountClientProvider>;
}
