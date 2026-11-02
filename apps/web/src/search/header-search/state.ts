import type { SearchScope } from './types';
import type { SuggestionResult } from '../suggestions';
import type { SuggestionFailure } from '../typeahead';

export type SuggestionState = 'idle' | 'loading' | 'ready' | 'empty' | SuggestionFailure;

export type HeaderSearchState = {
  expanded: boolean;
  phoneSheet: boolean;
  scope?: SearchScope | undefined;
  suggestions: SuggestionState;
  query: string;
  result?: SuggestionResult | undefined;
  retryAt?: number | undefined;
  activeIndex: number;
};

export type HeaderSearchEvent =
  | { type: 'focus' }
  | { type: 'open-phone' }
  | { type: 'escape' }
  | { type: 'outside' }
  | { type: 'remove-scope' }
  | { type: 'sync-scope'; scope?: SearchScope | undefined }
  | { type: 'query'; query: string }
  | { type: 'sync-query'; query: string }
  | { type: 'active'; index: number }
  | { type: 'invalidate' }
  | { type: 'suggestions'; state: SuggestionState; result?: SuggestionResult | undefined; retryAt?: number | undefined };

function retireRetryAt(state: HeaderSearchState): HeaderSearchState {
  const current = { ...state };
  delete current.retryAt;
  return current;
}

export function initialHeaderSearchState(scope?: SearchScope, query = ''): HeaderSearchState {
  return { expanded: false, phoneSheet: false, scope, query, suggestions: 'idle', activeIndex: -1 };
}

/** Shared by the React surface and the stack-free transition regression. */
export function reduceHeaderSearchState(state: HeaderSearchState, event: HeaderSearchEvent): HeaderSearchState {
  switch (event.type) {
    case 'focus':
      return { ...state, expanded: true, phoneSheet: false };
    case 'open-phone':
      return { ...state, expanded: true, phoneSheet: true };
    case 'escape':
    case 'outside':
      return {
        ...state,
        expanded: false,
        phoneSheet: false,
        activeIndex: -1,
        suggestions: state.suggestions === 'loading' ? 'idle' : state.suggestions,
      };
    case 'remove-scope':
      return {
        ...retireRetryAt(state),
        scope: undefined,
        result: undefined,
        activeIndex: -1,
        suggestions: state.query.trim() ? 'loading' : 'idle',
      };
    case 'sync-scope':
      return {
        ...retireRetryAt(state),
        scope: event.scope,
        result: undefined,
        suggestions: 'idle',
        activeIndex: -1,
      };
    case 'query':
      return {
        ...retireRetryAt(state),
        query: event.query,
        result: undefined,
        activeIndex: -1,
        suggestions: event.query.trim() ? 'loading' : 'idle',
      };
    case 'sync-query':
      return {
        ...retireRetryAt(state),
        query: event.query,
        result: undefined,
        activeIndex: -1,
        suggestions: 'idle',
      };
    case 'active':
      return { ...state, activeIndex: event.index };
    case 'invalidate':
      return { ...retireRetryAt(state), result: undefined, activeIndex: -1, suggestions: 'idle' };
    case 'suggestions':
      return {
        ...retireRetryAt(state),
        suggestions: event.state,
        result: event.result,
        ...(event.retryAt !== undefined ? { retryAt: event.retryAt } : {}),
        activeIndex: -1,
      };
  }
}
