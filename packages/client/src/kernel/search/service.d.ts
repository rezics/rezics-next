import type { SearchServiceContract, SearchServiceOptions } from './service-contract.ts';
import { requiresAdvancedSearch } from './request.ts';
/** Installed Search entry point; one factory binds the admitted request, cursor and result modules. */
export declare function createSearchService(options: SearchServiceOptions): SearchServiceContract;
export { requiresAdvancedSearch };
export { bindSearchScopeCursorRequest } from './service-cursor.ts';
export { validateSearchLimit } from './hits.ts';
export type { GroupedReleaseSearchRequest, PublicSearchPage, PublicSearchReadContext, SearchRequest, SearchServiceContract, SearchServiceOptions, } from './service-contract.ts';
