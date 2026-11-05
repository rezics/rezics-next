import type { ReadCredentialMode } from './credential';

/** Public reads can be reused across navigations for one minute. */
export const publicRead = { staleTime: 60_000 } as const;

/** Personal reads must start in the browser and are immediately stale. */
export const personalRead = { staleTime: 0, enabled: typeof window !== 'undefined' } as const;

/** Cache keys include the mode so anonymous page data cannot hide signed-in state after hydration. */
export function readQueryKey(key: readonly unknown[], mode: ReadCredentialMode) {
  return [...key, mode] as const;
}
