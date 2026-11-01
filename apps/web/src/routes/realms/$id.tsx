import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import { realmPageQuery } from '../../community/space-queries';
import { SpacePage } from '../../community/space-page';
import { getLocale } from '../../paraglide/runtime.js';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community/space-head';
import type { Located, SpacePageData } from '../../community/space';
import {
  bindHydratedSpacePage,
  captureSpacePageAdmission,
  getRealmPageAdmission,
  getSpacePageAdmission,
  isObsoleteSpacePageRead,
  ObsoleteSpacePageReadError,
  spacePageSessionSource,
  SpacePageLifetimeHost,
} from '../../community/space-page-lifetime';
import type { SpacePageAdmission, SpacePageTarget } from '../../community/space-page-lifetime';

type RealmLoaderData = { page: SpacePageData; admission: SpacePageAdmission };

export const Route = createFileRoute('/realms/$id')({
  staticData: { publicCache: true },
  loader: async ({ params, context }) => {
    const locale = getLocale();
    const target: SpacePageTarget = { kind: 'realm', id: params.id };
    let original = captureSpacePageAdmission(context.queryClient, {
      target,
      locale,
      credentialMode: context.credentialMode,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const query = realmPageQuery(params.id, locale, context.credentialMode, original);
      let located: Located;
      try {
        located = await context.queryClient.ensureQueryData(query);
        if (getRealmPageAdmission(located)?.readId !== original.readId)
          located = await context.queryClient.fetchQuery({ ...query, staleTime: 0 });
        if (getRealmPageAdmission(located)?.readId !== original.readId) throw new ObsoleteSpacePageReadError();
        if (located.kind === 'redirect')
          throw redirect({ href: `/${locale}/spaces/${encodeURIComponent(located.address)}`, statusCode: 307 });
        const admission = getSpacePageAdmission(located.page);
        if (admission?.readId === original.readId) return { page: located.page, admission } satisfies RealmLoaderData;
        throw new ObsoleteSpacePageReadError();
      } catch (error) {
        if (!isObsoleteSpacePageRead(error) || attempt > 0) throw error;
        original = captureSpacePageAdmission(context.queryClient, {
          target,
          locale,
          credentialMode: context.credentialMode,
        });
      }
    }
    throw new ObsoleteSpacePageReadError();
  },
  head: ({ loaderData, params }) =>
    spacePageHead(loaderData.page, getLocale(), `/realms/${encodeURIComponent(params.id)}`),
  errorComponent: ClosedErrorPage,
  component: RealmRoute,
});

function RealmRoute() {
  const { id } = Route.useParams();
  const locale = getLocale();
  const { credentialMode } = Route.useRouteContext();
  const { page, admission } = Route.useLoaderData();
  const client = useQueryClient();
  const router = useRouter();
  const source = spacePageSessionSource(client);
  const sessionRevision = useSyncExternalStore(source.subscribe, source.revision, source.revision);
  const request = { target: { kind: 'realm' as const, id }, locale, credentialMode };
  const current = bindHydratedSpacePage(page, admission, client, request);
  useEffect(() => {
    if (!current) void router.invalidate();
  }, [current, router, sessionRevision]);
  return (
    <SpacePageLifetimeHost
      page={page}
      admission={admission}
      target={request.target}
      locale={locale}
      credentialMode={credentialMode}
    >
      <SpacePage page={page} />
    </SpacePageLifetimeHost>
  );
}
