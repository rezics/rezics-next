import type { CompositionDocument } from '@rezics/composition';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { RoutePage, type RoutePageData } from '../../features/pages/route';
import { subjectPageMessages } from '../../features/pages/route-support';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ZonePageSurface, ZoneReadBoundary, ZoneShell, zonePageTitle } from '../../zones/zone-shell';
import { readZonePageRequest } from '../../zones/zone-read';

export const Route = createFileRoute('/zones/$id')({
  staticData: { sessionReread: true },
  loader: ({ params, context }) =>
    readZonePageRequest({
      data: {
        id: params.id,
        locale: getLocale(),
        target: { route: '' },
        credentialMode: context.credentialMode,
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
  const initial = Route.useLoaderData();
  const locale = getLocale();
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <ZoneReadBoundary initial={initial} request={{ id, locale, target: { route: '' } }}>
      {(outcome) => {
        const zone = outcome.page.zone;
        return (
          <ZoneShell zone={zone} locale={locale}>
            <ZonePageSurface zone={zone} document={outcome.page.document as CompositionDocument}>
              {(document) => (
                <RoutePage
                  page={{ ...outcome.page, route: '', document } as unknown as RoutePageData}
                  locale={locale}
                  heading={zonePageTitle(zone, '', locale)}
                  messages={subjectPageMessages()}
                  {...(nonce !== undefined ? { nonce } : {})}
                  renderJsonLd={false}
                />
              )}
            </ZonePageSurface>
          </ZoneShell>
        );
      }}
    </ZoneReadBoundary>
  );
}
