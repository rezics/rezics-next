import { MediaProblem } from '../media/kernel';
import type { SuggestionResult } from './suggestions';
import { readHeaderSuggestions, type HeaderSuggestionLoader } from './header-search/suggestions';
import type { SearchScope } from './header-search/types';
import { searchRecoveryFromResponse, suggestionFailureFromSearchRecovery } from './search-recovery';
import { searchRetryAt } from './search-recovery-retry';

/** The native prefix bound counts code points, while HTML maxlength counts UTF-16 units. */
export function validSuggestionText(q: string): boolean {
  return q.length <= 128 && [...q].length >= 1 && [...q].length <= 64;
}

export type SuggestionFailure =
  | 'error'
  | 'unavailable'
  | 'preparing'
  | 'closed'
  | 'restart'
  | 'invalid'
  | 'credentials';

export function suggestionFailure(status: number, code?: unknown): SuggestionFailure {
  const error = typeof code === 'string' ? { code } : code;
  return suggestionFailureFromSearchRecovery(
    searchRecoveryFromResponse({ status, ...(error !== undefined ? { error } : {}) }),
    status,
  );
}

export function suggestionErrorState(error: unknown): SuggestionFailure {
  if (error instanceof MediaProblem) return suggestionFailure(error.problem.status, error.problem.code);
  return 'error';
}

/** One cancellable request per settled input. Cleanup also fences producers that ignore abort. */
export function startTypeahead(
  load: HeaderSuggestionLoader,
  query: string,
  locale: string,
  scope: SearchScope | undefined,
  ready: (result: SuggestionResult) => void,
  failed: (state: SuggestionFailure, retryAt?: number) => void,
  delay = 200,
): () => void {
  const controller = new AbortController();
  const timer = setTimeout(async () => {
    try {
      const result = await readHeaderSuggestions(load, query, locale, controller.signal, scope);
      if (!controller.signal.aborted) ready(result);
    } catch (error) {
      if (!controller.signal.aborted) {
        const retryAt =
          error instanceof MediaProblem
            ? searchRetryAt(new Headers(error.headers).get('retry-after'), Date.now())
            : undefined;
        failed(suggestionErrorState(error), retryAt);
      }
    }
  }, delay);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

export function nextSuggestion(key: string, active: number, count: number): number | undefined {
  if (count === 0 || (key !== 'ArrowDown' && key !== 'ArrowUp')) return;
  return key === 'ArrowDown' ? (active + 1) % count : active < 0 ? count - 1 : (active - 1 + count) % count;
}
