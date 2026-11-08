import type { SearchServiceContract, SearchServiceOptions } from './service-contract.ts';
import { createSearchExecution } from './service-execution.ts';
import { createSearchCursorPlanner } from './service-cursor.ts';
import { createSearchRequestPlanner, requiresAdvancedSearch } from './request.ts';
import { createSearchResultAssembler } from './service-results.ts';

const modules = Object.freeze({
  request: createSearchRequestPlanner(),
  cursor: createSearchCursorPlanner(),
  result: createSearchResultAssembler(),
});

/** Installed Search entry point; one factory binds the admitted request, cursor and result modules. */
export function createSearchService(options: SearchServiceOptions): SearchServiceContract {
  return createSearchExecution(options, modules);
}

export { requiresAdvancedSearch };
export { bindSearchScopeCursorRequest } from './service-cursor.ts';
export { validateSearchLimit } from './hits.ts';
export type {
  GroupedReleaseSearchRequest,
  PublicSearchPage,
  PublicSearchReadContext,
  SearchRequest,
  SearchServiceContract,
  SearchServiceOptions,
} from './service-contract.ts';
