import type { ExecutedSearchRequest, PublicSearchPage, SearchPageParts } from './service-contract.ts';

export type SearchExecutionResult = Readonly<{
  request: ExecutedSearchRequest;
  page: PublicSearchPage;
}>;

export type SearchResultAssembler = Readonly<{
  assemble: (request: ExecutedSearchRequest, parts: SearchPageParts) => SearchExecutionResult;
}>;

/** Assemble the public DTO while retaining the exact executed request that produced it. */
export function assembleSearchResult(request: ExecutedSearchRequest, parts: SearchPageParts): SearchExecutionResult {
  const page: PublicSearchPage = {
    subjects: parts.subjects,
    ...(parts.kinds === undefined ? {} : { kinds: parts.kinds }),
    next: parts.next,
    as_of: parts.as_of,
    ...(parts.freshness === undefined ? {} : { freshness: parts.freshness }),
  };
  return { request, page };
}

export function createSearchResultAssembler(): SearchResultAssembler {
  return Object.freeze({ assemble: assembleSearchResult });
}
