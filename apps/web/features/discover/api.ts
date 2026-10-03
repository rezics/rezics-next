import type {
  FilterCondition,
  FilterDocument,
} from '../../../../model/definitions/filter-document-v1.ts';
import { browseCategories } from '../catalogue/registry.ts';
import type { DiscoveryPage, WorkCover, WorkName } from './types.ts';

/** Main's shared list envelope for resource browsing and remote pickers. */
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
export interface ServedPage<T, Profile extends string> extends ListPage<T> {
  profile: Profile;
  sourcePosition: DiscoveryPage['sourcePosition'];
  stale: boolean;
}
export interface SectionsPage extends ServedPage<DiscoverySection, 'discovery-sections-v1'> {
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
// The manager must merge Main's route types before this seam can use Eden directly.
interface BrowseContract {
  v1: {
    query: {
      post: (
        query: ResourceQuery,
        options: { headers: Record<string, string> },
      ) => Promise<Answer<{ result: ServedPage<ResourceCard, 'resource-list-v1'> }>>;
    };
    discovery: {
      concepts: Get<
        ServedPage<ConceptChoice, 'concept-search-v1'>,
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
      ServedPage<RatingPopulation, 'rating-populations-v1'> & { target: string },
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

/** A selected category must resolve to served types; missing metadata never widens to All. */
export function browseTypeCondition(category: string): FilterCondition {
  const entry = browseCategories().find((entry) => entry.id === category);
  if (!entry) throw new BrowseReadError(503, 'types_unavailable');
  return { facet: 'type', any: entry.types };
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

function servedPage<T, Profile extends string>(
  page: ServedPage<T, Profile>,
  profile: Profile,
  cursor?: string,
): ServedPage<T, Profile> {
  checkedPage(page, cursor);
  if (page.profile !== profile) throw new BrowseReadError(503);
  return page;
}

export function discoveryApi(main: unknown, locale: string, actingSubject?: string) {
  const contract = main as BrowseContract;
  const headers = { 'accept-language': locale };
  return {
    async resources(query: ResourceQuery) {
      const result = await value(contract.v1.query.post(query, { headers }));
      return servedPage(result.result, 'resource-list-v1', query.cursor);
    },
    async concepts(query: ListInput & { realm?: string; personalization?: boolean } = {}) {
      const { realm, ...input } = query;
      return servedPage(
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
        'concept-search-v1',
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
      servedPage(page, 'discovery-sections-v1');
      page.items.forEach((section) => checkedPage(section.page, query.cursor));
      return page;
    },
    async populations(target: string, query: ListInput = {}) {
      return servedPage(
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
        'rating-populations-v1',
        query.cursor,
      );
    },
  };
}
export type DiscoveryApi = ReturnType<typeof discoveryApi>;
