import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '../../library/collection-page';
import { DynamicCollectionPage } from '../../library/dynamic-collection-page';
import type { CollectionPageResult } from '../../library/collection-load';
import { collectionPageQuery } from '../../library/collection';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/collections/$id')({
  staticData: { sessionReread: true },
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ params, deps, context }) =>
    context.queryClient.ensureQueryData(collectionPageQuery(params.id, deps.cursor, context.credentialMode)),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? m.not_found_heading() }] }),
  component: CollectionRoute,
});

function CollectionRoute() {
  const page = Route.useLoaderData() as CollectionPageResult;
  return 'preparing' in page ? <DynamicCollectionPage page={page} /> : <CollectionPage page={page} />;
}
