import { createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ZoneComposedPage, ZoneReadBoundary, zonePageTitle } from '../../zones/zone-shell';
import { readZonePageRequest, zoneConfiguredRoute, zoneLocationSearch, zonePageSearch } from '../../zones/zone-read';

function routeOf(value: string | undefined): string {
  const route = zoneConfiguredRoute(value);
  if (route === undefined) throw notFound();
  return route;
}

export const Route = createFileRoute('/zones/$id_/$')({
  staticData: { sessionReread: true },
  validateSearch: (search: Record<string, unknown>) => zonePageSearch(search),
  loader: ({ params, context, location }) => {
    const route = routeOf(params._splat);
    return readZonePageRequest({
      data: {
        id: params.id,
        locale: getLocale(),
        target: { route },
        ...(context.credentialMode === undefined ? {} : { credentialMode: context.credentialMode }),
        ...zoneLocationSearch(location.search),
      },
    });
  },
  head: ({ loaderData, params }) => ({
    meta: [
      {
        title:
          loaderData?.kind === 'page'
            ? zonePageTitle(loaderData.page.zone, routeOf(params._splat), getLocale())
            : m.not_found_heading(),
      },
    ],
  }),
  component: ConfiguredZoneRoute,
});

function ConfiguredZoneRoute() {
  const { id } = Route.useParams();
  const route = routeOf(Route.useParams()._splat);
  const search = zoneLocationSearch(Route.useSearch());
  const initial = Route.useLoaderData();
  const { credentialMode } = Route.useRouteContext();
  const locale = getLocale();
  const nonce = useRouter().options.ssr?.nonce;
  const target = { route } as const;
  return (
    <ZoneReadBoundary
      initial={initial}
      request={{
        id,
        locale,
        target,
        ...(credentialMode === undefined ? {} : { credentialMode }),
        ...search,
      }}
    >
      {(outcome) => (
        <ZoneComposedPage
          page={outcome.page}
          visit={{
            locale,
            zoneId: id,
            target: { kind: 'route', route },
            ...search,
          }}
          {...(nonce !== undefined ? { nonce } : {})}
        />
      )}
    </ZoneReadBoundary>
  );
}
