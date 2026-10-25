import { createFileRoute } from '@tanstack/react-router';
import { CollectionPage } from '../../library/collection-page';
import { readCollectionPage } from '../../library/collection';
import { m } from '../../paraglide/messages.js';

export const Route = createFileRoute('/collections/$id')({
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.cursor === 'string' ? { cursor: search.cursor } : {},
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ params, deps }) => readCollectionPage({ data: { id: params.id, cursor: deps.cursor } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title ?? m.not_found_heading() }] }),
  component: CollectionRoute,
});

function CollectionRoute() {
  return <CollectionPage page={Route.useLoaderData()} />;
}
