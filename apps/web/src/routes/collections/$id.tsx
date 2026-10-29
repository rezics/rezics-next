import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '../../library/collection-page';
import { DynamicCollectionPage } from '../../library/dynamic-collection-page';
import type { CollectionPageResult } from '../../library/collection-load';
import { collectionPageQuery, readDynamicCollectionMembers } from '../../library/collection';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/collections/$id')({
  staticData: { sessionReread: true },
  validateSearch: (search: Record<string, unknown>) => {
    const filters: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(search))
      if (
        /^[frl]\.[a-zA-Z0-9:_.-]{1,128}$/.test(key) &&
        (typeof value === 'string' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string')))
      )
        filters[key] = value as string | string[];
    return {
      ...(typeof search.cursor === 'string' ? { cursor: search.cursor } : {}),
      ...(Object.keys(filters).length ? { filters } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor, filters: search.filters }),
  loader: ({ params, deps, context }) =>
    context.queryClient.ensureQueryData(
      collectionPageQuery(params.id, deps.cursor, context.credentialMode, deps.filters),
    ),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? m.not_found_heading() }] }),
  component: CollectionRoute,
});

function CollectionRoute() {
  const page = Route.useLoaderData() as CollectionPageResult;
  return 'preparing' in page ? (
    <DynamicCollectionPage
      page={page}
      readMembers={(id, cursor) => readDynamicCollectionMembers({ data: { id, ...(cursor ? { cursor } : {}) } })}
    />
  ) : (
    <CollectionPage page={page} />
  );
}
