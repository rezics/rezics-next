import { createContext, useContext, type ReactNode } from 'react';
import type { InboxAmbient } from '../ports/ambient';

const InboxAmbientContext = createContext<InboxAmbient | null>(null);

/** Route and page composition bind the real adapter. Page and badge recovery read it here. */
export function InboxAmbientProvider({ ambient, children }: { ambient: InboxAmbient; children: ReactNode }) {
  return <InboxAmbientContext.Provider value={ambient}>{children}</InboxAmbientContext.Provider>;
}

export function useInboxAmbient(): InboxAmbient {
  const ambient = useContext(InboxAmbientContext);
  if (ambient) return ambient;
  throw new Error('InboxAmbientProvider is required');
}

export { createBrowserInboxAmbient, createServerInboxAmbient } from './ambient.ts';
