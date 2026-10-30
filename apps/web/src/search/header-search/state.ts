import type { SearchScope } from './types';
import type { SuggestionResult } from '../suggestions';

export type SuggestionState = 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unavailable';

export type HeaderSearchState = {
  expanded: boolean;
  phoneSheet: boolean;
  scope?: SearchScope;
  suggestions: SuggestionState;
  query: string;
  result?: SuggestionResult;
  activeIndex: number;
};

export type HeaderSearchEvent =
  | { type: 'focus' }
  | { type: 'open-phone' }
  | { type: 'escape' }
  | { type: 'outside' }
  | { type: 'remove-scope' }
  | { type: 'sync-scope'; scope?: SearchScope }
  | { type: 'query'; query: string }
  | { type: 'sync-query'; query: string }
  | { type: 'active'; index: number }
  | { type: 'suggestions'; state: SuggestionState; result?: SuggestionResult };

export function initialHeaderSearchState(scope?: SearchScope, query = ''): HeaderSearchState {
  return { expanded: false, phoneSheet: false, scope, query, suggestions: 'idle', activeIndex: -1 };
}

/** Shared by the React surface and the stack-free transition regression. */
export function reduceHeaderSearchState(state: HeaderSearchState, event: HeaderSearchEvent): HeaderSearchState {
  switch (event.type) {
    case 'focus':
      return { ...state, expanded: true };
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
        ...state,
        scope: undefined,
        result: undefined,
        activeIndex: -1,
        suggestions: state.query.trim() ? 'loading' : 'idle',
      };
    case 'sync-scope':
      return { ...state, scope: event.scope, result: undefined, suggestions: 'idle', activeIndex: -1 };
    case 'query':
      return {
        ...state,
        query: event.query,
        result: undefined,
        activeIndex: -1,
        suggestions: event.query.trim() ? 'loading' : 'idle',
      };
    case 'sync-query':
      return { ...state, query: event.query, result: undefined, activeIndex: -1, suggestions: 'idle' };
    case 'active':
      return { ...state, activeIndex: event.index };
    case 'suggestions':
      return { ...state, suggestions: event.state, result: event.result, activeIndex: -1 };
  }
}
