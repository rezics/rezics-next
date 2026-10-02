import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import type { WorkCover, WorkName } from './types.ts';

/** G-939's additions to Main. Keep this seam here until the manager merges its served contracts. */
export interface ListPage<T> {
  items: T[];
  nextCursor: string | null;
  complete: boolean;
  count: { value: number; kind: 'exact' | 'at-least' };
}
export interface ResourceCard {
  id: string;
  kind: 'work' | 'space' | 'realm' | 'site' | 'agent' | 'collection' | 'concept';
  types: string[];
  name: WorkName;
  icon: WorkCover;
}
export interface ConceptChoice {
  id: string;
  name: WorkName;
  broader: { id: string; name: WorkName }[];
  usageCount: number;
  followed: boolean;
}
export interface RatingPopulation {
  id: string;
  name: WorkName;
  global: boolean;
  readerCommunity: boolean;
  ratingCount: number;
}
export type SectionId = 'popular' | 'communities' | 'sites';
export type SectionReason =
  | 'popular-in-followed-topics'
  | 'popular'
  | 'communities-in-reader-languages'
  | 'communities'
  | 'new-sites';
export interface DiscoverySection {
  id: SectionId;
  reason: { kind: SectionReason };
  page: ListPage<ResourceCard>;
}
export interface SectionsPage extends ListPage<DiscoverySection> {
  personalized: boolean;
}
export interface ListInput {
  q?: string;
  cursor?: string;
  limit?: number;
}
export interface ResourceQuery extends ListInput {
  profile: 'resource-list-v1';
  context: 'global' | { realm: string };
  scope: { kind: 'all' } | { kind: 'realm'; realm: string };
  sort: 'newest' | 'updated' | 'relevance';
  filter?: FilterDocument;
}
type Answer<T> = { data: T | null; error: { status: number; value: unknown } | null };
type Get<T, Q> = {
  get: (options: { query: Q; headers?: Record<string, string> }) => Promise<Answer<T>>;
};
interface PendingContract {
  v1: {
    query: {
      post: (
        query: ResourceQuery,
        options: { headers: Record<string, string> },
      ) => Promise<Answer<{ result: ListPage<ResourceCard> & { profile: string } }>>;
    };
    discovery: {
      concepts: Get<
        ListPage<ConceptChoice>,
        ListInput & {
          scope?: 'realm';
          realm?: string;
          actingSubject?: string;
          personalization?: boolean;
        }
      >;
      sections: Get<
        SectionsPage,
        ListInput & { section?: SectionId; actingSubject?: string; personalization?: boolean }
      >;
    };
    'rating-populations': Get<
      ListPage<RatingPopulation>,
      ListInput & { target: string; actingSubject?: string }
    >;
  };
}
export class BrowseReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super('Browse read failed');
  }
}
async function value<T>(read: Promise<Answer<T>>): Promise<T> {
  const { data, error } = await read;
  if (error || data === null) {
    const code =
      error?.value && typeof error.value === 'object' && 'code' in error.value
        ? String(error.value.code)
        : null;
    throw new BrowseReadError(error?.status ?? 503, code);
  }
  return data;
}
/** A partial page must offer a progressing continuation; never turn it into an exact inventory. */
export function checkedPage<T>(page: ListPage<T>, cursor?: string): ListPage<T> {
  if (
    !page ||
    !Array.isArray(page.items) ||
    typeof page.complete !== 'boolean' ||
    (!page.complete && (!page.nextCursor || page.nextCursor === cursor)) ||
    (page.complete && page.nextCursor !== null)
  )
    throw new BrowseReadError(503);
  return page;
}

export function discoveryApi(main: unknown, locale: string, actingSubject?: string) {
  const contract = main as unknown as PendingContract;
  const headers = { 'accept-language': locale };
  return {
    async resources(query: ResourceQuery) {
      const result = await value(contract.v1.query.post(query, { headers }));
      if (result.result.profile !== 'resource-list-v1') throw new BrowseReadError(503);
      return checkedPage(result.result, query.cursor);
    },
    async concepts(query: ListInput & { realm?: string; personalization?: boolean } = {}) {
      const { realm, ...input } = query;
      return checkedPage(
        await value(
          contract.v1.discovery.concepts.get({
            query: {
              ...input,
              limit: input.limit ?? 20,
              ...(realm ? { scope: 'realm', realm } : {}),
              ...(actingSubject ? { actingSubject } : {}),
            },
            headers,
          }),
        ),
        query.cursor,
      );
    },
    async sections(query: ListInput & { section?: SectionId; personalization?: boolean } = {}) {
      const page = await value(
        contract.v1.discovery.sections.get({
          query: { ...query, ...(actingSubject ? { actingSubject } : {}) },
          headers,
        }),
      );
      checkedPage(page);
      page.items.forEach((section) => checkedPage(section.page, query.cursor));
      return page;
    },
    async populations(target: string, query: ListInput = {}) {
      return checkedPage(
        await value(
          contract.v1['rating-populations'].get({
            query: {
              ...query,
              target,
              limit: query.limit ?? 20,
              ...(actingSubject ? { actingSubject } : {}),
            },
            headers,
          }),
        ),
        query.cursor,
      );
    },
  };
}
export type DiscoveryApi = ReturnType<typeof discoveryApi>;

/** The browse categories are structural Type Facet values, never descriptive Work subtypes. */
export const browseTypes = {
  works: 'https://schema.org/CreativeWork',
  communities: 'https://rezics.com/vocab/Realm',
  sites: 'https://rezics.com/vocab/Zone',
  people: 'https://rezics.com/vocab/Agent',
  lists: 'https://rezics.com/vocab/Collection',
  topics: 'http://www.w3.org/2004/02/skos/core#Concept',
} as const;
