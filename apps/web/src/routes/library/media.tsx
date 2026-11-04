import { createFileRoute } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { CurrentViewerOwnMediaPage } from '../../media/own-inventory/page';
import { ownMediaCursor } from '../../media/own-inventory/inventory';
import { readOwnMediaInventoryForViewer } from '../../media/own-inventory/actions';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/library/media')({
  validateSearch: (search: Record<string, unknown>) => {
    const address = ownMediaCursor(search.cursor);
    return {
      ...(address.valid && address.cursor !== null ? { cursor: address.cursor } : {}),
      ...(search.cursor !== undefined && !address.valid ? { invalidCursor: true } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ cursor: search.cursor, invalidCursor: search.invalidCursor === true }),
  loader: ({ deps }) =>
    readOwnMediaInventoryForViewer({
      data: { cursor: deps.invalidCursor ? null : (deps.cursor ?? null), invalid: deps.invalidCursor },
    }),
  staleTime: 0,
  gcTime: 0,
  head: ({ match }) =>
    pageHead({ title: m.own_media_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: OwnMediaRoute,
});

function OwnMediaRoute() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const address = ownMediaCursor(search.cursor);
  const invalid = search.invalidCursor === true || !address.valid;
  return <CurrentViewerOwnMediaPage initial={initial} cursor={invalid ? null : address.cursor} invalidAddress={invalid} />;
}
