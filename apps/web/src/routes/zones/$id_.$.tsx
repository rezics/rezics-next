import type { CompositionDocument } from '@rezics/composition';
import { createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { RoutePage, type RoutePageData } from '../../features/pages/route';
import { subjectPageMessages } from '../../features/pages/route-support';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ZonePageSurface, ZoneReadBoundary, ZoneShell, zonePageTitle, zoneRouteHeading } from '../../zones/zone-shell';
import { readZonePageRequest } from '../../zones/zone-read';

const configuredRoute = /^(?!subjects(?:\/|$))[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

function routeOf(value: string | undefined): string {
  if (!value || value.length > 255 || !configuredRoute.test(value)) throw notFound();
  return value;
}

export const Route = createFileRoute('/zones/$id_/$')({
  staticData: { sessionReread: true },
  loader: ({ params, context }) => {
    const route = routeOf(params._splat);
    return readZonePageRequest({
      data: {
        id: params.id,
        locale: getLocale(),
        target: { route },
        credentialMode: context.credentialMode,
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
  const nonce = useRouter().options.ssr?.nonce;
  const target = { route } as const;
  return (
    <ZoneReadBoundary initial={initial} request={{ id, locale, target, credentialMode }}>
      {(outcome) => {
        const zone = outcome.page.zone;
        return (
          <ZoneShell zone={zone} locale={locale} route={route}>
            <ZonePageSurface zone={zone} document={outcome.page.document as CompositionDocument}>
              {(document) => (
                <RoutePage
                  page={{ ...outcome.page, route, document } as unknown as RoutePageData}
                  locale={locale}
                  heading={zoneRouteHeading(route, locale)}
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
