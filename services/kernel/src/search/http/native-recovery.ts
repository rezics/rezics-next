import type { SearchPageRecoveryTransition } from '../page-recovery.ts';

/** Typed producer families installed readers consume. Totals and empty-success chains are not members. */
export type SearchNativeRecoveryFamily =
  | 'invalid'
  | 'invalid-cursor'
  | 'session'
  | 'closed'
  | 'denied'
  | 'restart'
  | 'index-not-ready'
  | 'source-not-ready'
  | 'unavailable'
  | 'ready';

export type SearchNativeRecoveryInput = Readonly<{
  status: number;
  code?: string;
  cursorPointer?: boolean;
}>;

/** Classify a native Search, suggest or facet HTTP problem before a reader publishes ready. */
export function searchNativeRecoveryFamily(input: SearchNativeRecoveryInput): SearchNativeRecoveryFamily {
  if (input.status === 200) return 'ready';
  if (input.status === 401) return 'session';
  if (input.status === 403 && input.code === 'platform_closed') return 'closed';
  if (input.status === 403 || input.status === 404) return 'denied';
  if (input.status === 409) return 'restart';
  if (input.status === 422) return 'invalid';
  if (input.status === 400) return input.cursorPointer ? 'invalid-cursor' : 'invalid';
  if (input.status === 503 && input.code === 'index_not_ready') return 'index-not-ready';
  if (input.status === 503 && input.code === 'semantic_not_ready') return 'source-not-ready';
  return 'unavailable';
}

/** Generation or identity change restarts; preparation is never a successful empty page. */
export function searchNativePageTransition(input: {
  family: SearchNativeRecoveryFamily;
  generationChanged?: boolean;
  identityChanged?: boolean;
}): SearchPageRecoveryTransition {
  if (input.generationChanged || input.identityChanged || input.family === 'restart') return 'restart';
  if (input.family === 'index-not-ready' || input.family === 'source-not-ready') return 'preparing';
  if (input.family === 'ready') return 'ready';
  return 'retry';
}
