import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query';
import { useContext, useState, type ReactNode } from 'react';

/** Same QueryClient the production router installs for the default reader. */
export function createDefaultReaderQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
}

/**
 * Isolated Subject/Collection markup uses this when the router has not already provided a client.
 * The mounted shell reuses the existing context and does not create a second cache.
 */
export function DefaultReaderProvider({ children }: { children: ReactNode }) {
  const existing = useContext(QueryClientContext);
  const [fallback] = useState(createDefaultReaderQueryClient);
  if (existing) return children;
  return <QueryClientProvider client={fallback}>{children}</QueryClientProvider>;
}
