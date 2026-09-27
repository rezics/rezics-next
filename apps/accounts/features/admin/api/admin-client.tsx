'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { type AdminApi, browserAdminApi } from './client.ts';

/** What operator panel components may do beyond rendering. The app provides
 * the real API and navigation; stories provide fakes, so no component imports
 * next/*. */
export interface AdminClient {
  api: AdminApi;
  /** Full navigation to another panel page. */
  navigate(url: string): void;
  /** Record the current view's state in the address without reloading. */
  replaceUrl(url: string, push?: boolean): void;
  /** Re-read the current page's server data after a change. */
  refresh(): void;
  /** Save a file the operator asked for, such as an audit export. */
  download(blob: Blob, filename: string): void;
}

export const browserAdminClient: AdminClient = {
  api: browserAdminApi,
  navigate: url => window.location.assign(url),
  replaceUrl: (url, push = false) => window.history[push ? 'pushState' : 'replaceState'](window.history.state, '', url),
  refresh: () => window.location.reload(),
  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  },
};

const Context = createContext<AdminClient | null>(null);

export function AdminClientProvider({ value, children }: { value: AdminClient; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAdminClient(): AdminClient {
  return useContext(Context) ?? browserAdminClient;
}
