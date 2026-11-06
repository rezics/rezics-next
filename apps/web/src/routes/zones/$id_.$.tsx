import type { CompositionDocument } from '@rezics/composition';
import { createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { type RoutePageData, zonePageDestinations, ZoneRoutePage } from '../../features/pages/route';
import { subjectPageMessages } from '../../features/pages/route-support';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ZonePageSurface, ZoneReadBoundary, ZoneShell, zonePageTitle, zoneRouteHeading } from '../../zones/zone-shell';
import { readZonePageRequest, zonePageSearch } from '../../zones/zone-read';

const configuredRoute = /^(?!subjects(?:\/|$))[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

function routeOf(value: string | undefined): string {
  // TanStack can select this route for the home URL with an empty splat.
  if (value === undefined || value.length > 255 || (value !== '' && !configuredRoute.test(value))) throw notFound();
  return value;
}

export const Route = createFileRoute('/zones/$id_/$')({
  staticData: { sessionReread: true },
  loader: ({ params, context, location }) => {
    const route = routeOf(params._splat);
    const search = zonePageSearch(location.searchStr);
    return readZonePageRequest({
      data: {
        id: params.id,
        locale: getLocale(),
        target: { route },
        credentialMode: context.credentialMode,
        ...(search.cursor ? { cursor: search.cursor } : {}),
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
  const initial = Route.useLoaderData();
  const { credentialMode } = Route.useRouteContext();
  const locale = getLocale();
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  const search = zonePageSearch(router.state.location.searchStr);
  const target = { route } as const;
  return (
    <ZoneReadBoundary initial={initial} request={{ id, locale, target, credentialMode }}>
      {(outcome) => {
        const zone = outcome.page.zone;
        return (
          <ZoneShell zone={zone} locale={locale} route={route}>
            <ZonePageSurface zone={zone} document={outcome.page.document as CompositionDocument}>
              {(document) => (
                <ZoneRoutePage
                  page={{ ...outcome.page, route, document } as unknown as RoutePageData}
                  locale={locale}
                  heading={route === '' ? zonePageTitle(zone, '', locale) : zoneRouteHeading(route, locale)}
                  messages={subjectPageMessages()}
                  destinations={zonePageDestinations(id, locale, route, search)}
                  {...(nonce !== undefined ? { nonce } : {})}
                />
              )}
            </ZonePageSurface>
          </ZoneShell>
        );
      }}
    </ZoneReadBoundary>
  );
}
