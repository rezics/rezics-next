'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { type AccountApi, browserAccountApi } from './client.ts';
import { saveFile } from './save-file.ts';

/** What client components may do beyond rendering. The app provides the real
 * API and router; stories provide fakes, so components never import next/*. */
export interface AccountClient {
  api: AccountApi;
  /** Full navigation, used when the server decides where to go next. */
  navigate(url: string): void;
  /** Re-read the current page's server data after a change. */
  refresh(): void;
  /** Save a file the person asked for, such as their data. */
  download(file: Blob, name: string): void;
}

const Context = createContext<AccountClient | null>(null);

export function AccountClientProvider({ value, children }: { value: AccountClient; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAccountClient(): AccountClient {
  return useContext(Context) ?? { api: browserAccountApi,
    navigate: url => window.location.assign(url), refresh: () => window.location.reload(), download: saveFile };
}
