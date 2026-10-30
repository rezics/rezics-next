import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '../../library/collection-page';
import { DynamicCollectionPage } from '../../library/dynamic-collection-page';
import type { CollectionPageResult } from '../../library/collection-load';
import { collectionPageQuery, readDynamicCollectionMembers } from '../../library/collection-queries';
import { collectionPageHead } from '../../library/collection-page';
import { m } from '../../paraglide/messages.js';
import * as v from 'valibot';

export const Route = createFileRoute('/collections/$id')({
  staticData: { publicCache: true },
  validateSearch: (search: Record<string, unknown>) => {
    const { cursor } = v.parse(
      v.object({ cursor: v.fallback(v.optional(v.pipe(v.string(), v.minLength(1))), undefined) }),
      search,
    );
    const filters: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(search))
      if (
        /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
        (typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))
      )
        filters[key] = value as string | string[];
    const layout: 'grid' | 'list' | undefined =
      search.layout === 'grid' || search.layout === 'list' ? search.layout : undefined;
    return {
      ...(cursor === undefined ? {} : { cursor }),
      ...(layout ? { layout } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor, filters: search.filters }),
  loader: ({ params, deps, context }) =>
    context.queryClient.ensureQueryData(
      collectionPageQuery(params.id, deps.cursor, context.credentialMode, deps.filters),
    ),
  head: ({ loaderData }) =>
    loaderData
      ? collectionPageHead(loaderData, undefined, loaderData.cursor !== undefined)
      : { meta: [{ title: m.not_found_heading() }] },
  component: CollectionRoute,
});

function CollectionRoute() {
  const page = Route.useLoaderData() as CollectionPageResult;
  const search = Route.useSearch();
  return 'preparing' in page ? (
    <DynamicCollectionPage
      page={page}
      readMembers={(id, cursor) =>
        readDynamicCollectionMembers({
          data: { id, ...(cursor ? { cursor } : {}), ...(search.filters ? { search: search.filters } : {}) },
        })
      }
    />
  ) : (
    <CollectionPage
      page={page}
      cursor={search.cursor}
      layout={search.layout ?? 'list'}
      {...(search.filters ? { search: search.filters } : {})}
      personalLoaded={Route.useRouteContext().credentialMode === 'session'}
    />
  );
}
