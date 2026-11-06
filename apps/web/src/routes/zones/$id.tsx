import type { CompositionDocument } from '@rezics/composition';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { type RoutePageData, zonePageDestinations, ZoneRoutePage } from '../../features/pages/route';
import { subjectPageMessages } from '../../features/pages/route-support';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ZonePageSurface, ZoneReadBoundary, ZoneShell, zonePageTitle } from '../../zones/zone-shell';
import { readZonePageRequest, zonePageSearch } from '../../zones/zone-read';

export const Route = createFileRoute('/zones/$id')({
  staticData: { sessionReread: true },
  loader: ({ params, context, location }) => {
    const search = zonePageSearch(location.searchStr);
    return readZonePageRequest({
      data: {
        id: params.id,
        locale: getLocale(),
        target: { route: '' },
        credentialMode: context.credentialMode,
        ...(search.cursor ? { cursor: search.cursor } : {}),
      },
    });
  },
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
  const initial = Route.useLoaderData();
  const { credentialMode } = Route.useRouteContext();
  const locale = getLocale();
  const router = useRouter();
  const nonce = router.options.ssr?.nonce;
  const search = zonePageSearch(router.state.location.searchStr);
  return (
    <ZoneReadBoundary initial={initial} request={{ id, locale, target: { route: '' }, credentialMode }}>
      {(outcome) => {
        const zone = outcome.page.zone;
        return (
          <ZoneShell zone={zone} locale={locale}>
            <ZonePageSurface zone={zone} document={outcome.page.document as CompositionDocument}>
              {(document) => (
                <ZoneRoutePage
                  page={{ ...outcome.page, route: '', document } as unknown as RoutePageData}
                  locale={locale}
                  heading={zonePageTitle(zone, '', locale)}
                  messages={subjectPageMessages()}
                  destinations={zonePageDestinations(id, locale, '', search)}
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
