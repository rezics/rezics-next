'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo } from 'react';
import { AccountClientProvider } from '../features/api/account-client.tsx';
import { browserAccountApi } from '../features/api/client.ts';

export function ClientProviders({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Browser tests wait for this before typing into forms.
  useEffect(() => { document.documentElement.dataset.hydrated = ''; }, []);
  const value = useMemo(() => ({ api: browserAccountApi,
    navigate: (url: string) => window.location.assign(url), refresh: () => router.refresh() }), [router]);
  return <AccountClientProvider value={value}>{children}</AccountClientProvider>;
}
