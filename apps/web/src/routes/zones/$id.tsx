import { createFileRoute, useRouter } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ZoneComposedPage, ZoneReadBoundary, zonePageTitle } from '../../zones/zone-shell';
import { readZonePageRequest, zoneLocationSearch, zonePageSearch } from '../../zones/zone-read';

export const Route = createFileRoute('/zones/$id')({
  staticData: { sessionReread: true },
  validateSearch: (search: Record<string, unknown>) => zonePageSearch(search),
  loader: ({ params, context, location }) =>
    readZonePageRequest({
      data: {
        id: params.id,
        locale: getLocale(),
        target: { route: '' },
        credentialMode: context.credentialMode,
        ...zoneLocationSearch(location.search),
      },
    }),
  head: ({ loaderData }) => ({
    meta: [
      {
        title:
          loaderData?.kind === 'page' ? zonePageTitle(loaderData.page.zone, '', getLocale()) : m.not_found_heading(),
      },
    ],
  }),
  component: ZoneHomeRoute,
});

function ZoneHomeRoute() {
  const { id } = Route.useParams();
  const search = zoneLocationSearch(Route.useSearch());
  const initial = Route.useLoaderData();
  const { credentialMode } = Route.useRouteContext();
  const locale = getLocale();
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <ZoneReadBoundary
      initial={initial}
      request={{
        id,
        locale,
        target: { route: '' },
        credentialMode,
        ...search,
      }}
    >
      {(outcome) => (
        <ZoneComposedPage
          page={outcome.page}
          visit={{
            locale,
            zoneId: id,
            target: { kind: 'route', route: '' },
            ...search,
          }}
          {...(nonce !== undefined ? { nonce } : {})}
        />
      )}
    </ZoneReadBoundary>
  );
}
