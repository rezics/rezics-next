import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { getLocale } from '../../paraglide/runtime.js';
import { m } from '../../paraglide/messages.js';
import { PublicCollectionDiscoveryPage } from '../../library/public-collection-discovery/page';
import { publicCollectionDiscoveryQueryOptions } from '../../library/public-collection-discovery/query';
import type { PublicCollectionDiscoveryState } from '../../library/public-collection-discovery/read';

function validateCollectionSearch(search: Record<string, unknown>) {
  const cursor = search.cursor;
  if (cursor === undefined) return {};
  if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 4864) return { cursor };
  return { invalidCursor: true };
}

export const Route = createFileRoute('/collections/')({
  staticData: { publicCache: true },
  validateSearch: validateCollectionSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps, context }) => {
    if (deps.invalidCursor) return undefined;
    const locale = getLocale();
    return context.queryClient.ensureQueryData(publicCollectionDiscoveryQueryOptions(locale, deps.cursor));
  },
  head: ({ match }) =>
    pageHead(
      {
        title: m.collection_discovery_heading(),
        description: m.collection_discovery_intro(),
      },
      pageHeadContext(match.pathname),
    ),
  component: () => {
    const address = Route.useSearch();
    const locale = getLocale();
    const invalidCursor = address.invalidCursor === true;
    const query = useQuery({
      ...publicCollectionDiscoveryQueryOptions(locale, address.cursor),
      enabled: !invalidCursor,
    });
    const state: PublicCollectionDiscoveryState = invalidCursor
      ? { status: 'restart' }
      : (query.data ?? { status: 'loading' });
    return (
      <PublicCollectionDiscoveryPage
        state={state}
        locale={locale}
        {...(address.cursor ? { cursor: address.cursor } : {})}
        continuation={invalidCursor || address.cursor !== undefined}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  },
});
