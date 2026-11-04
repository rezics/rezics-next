import { realmReadingSearch } from '../../community/realm-reading-return';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import { realmPageQuery } from '../../community/space-queries';
import { SpacePage } from '../../community/space-page';
import { getLocale } from '../../paraglide/runtime.js';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community/space-head';
import type { SpacePageData } from '../../community/space';
import {
  awaitSpacePageRead,
  bindHydratedSpacePage,
  captureSpacePageAdmission,
  isObsoleteSpacePageRead,
  ObsoleteSpacePageReadError,
  releaseSpacePageRead,
  spacePageQueryResultIsCurrent,
  spacePageReadWasCancelled,
  spacePageReadResultWasReplaced,
  spacePageSessionSource,
  SpacePageLifetimeHost,
} from '../../community/space-page-lifetime';
import type { SpacePageAdmission, SpacePageTarget } from '../../community/space-page-lifetime';

type RealmLoaderData = { page: SpacePageData; admission: SpacePageAdmission };

export const Route = createFileRoute('/realms/$id')({
  staticData: { publicCache: true },
  validateSearch: realmReadingSearch,
  loaderDeps: ({ search }) => realmReadingSearch(search),
  loader: async ({ params, context, abortController }) => {
    const locale = getLocale();
    const target: SpacePageTarget = { kind: 'realm', id: params.id };
    const signal = abortController.signal;
    let original = captureSpacePageAdmission(context.queryClient, {
      target,
      locale,
      credentialMode: context.credentialMode,
      signal,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted || getLocale() !== locale) {
        releaseSpacePageRead(original);
        throw new ObsoleteSpacePageReadError();
      }
      const query = realmPageQuery(params.id, locale, context.credentialMode, original);
      try {
        let result = await awaitSpacePageRead(original, context.queryClient.ensureQueryData(query));
        if (signal.aborted || getLocale() !== locale) throw new ObsoleteSpacePageReadError();
        if (
          result.admission.readId !== original.readId ||
          !spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result)
        )
          result = await awaitSpacePageRead(original, context.queryClient.fetchQuery({ ...query, staleTime: 0 }));
        if (signal.aborted || getLocale() !== locale) throw new ObsoleteSpacePageReadError();
        if (
          result.admission.readId !== original.readId ||
          !spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result)
        )
          throw new ObsoleteSpacePageReadError();
        const { located, admission } = result;
        if (located.kind === 'redirect') {
          if (!spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result))
            throw new ObsoleteSpacePageReadError();
          releaseSpacePageRead(original);
          throw redirect({ href: `/${locale}/spaces/${encodeURIComponent(located.address)}`, statusCode: 307 });
        }
        const data = { page: located.page, admission } satisfies RealmLoaderData;
        if (!spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result))
          throw new ObsoleteSpacePageReadError();
        releaseSpacePageRead(original, true);
        return data;
      } catch (error) {
        const cancelled = spacePageReadWasCancelled(original, context.queryClient);
        const replaced = spacePageReadResultWasReplaced(original, context.queryClient);
        releaseSpacePageRead(original);
        if (!isObsoleteSpacePageRead(error) && !cancelled) throw error;
        if (attempt > 0 || signal.aborted || getLocale() !== locale || replaced) {
          if (cancelled && !signal.aborted) throw new ObsoleteSpacePageReadError();
          throw error;
        }
        original = captureSpacePageAdmission(context.queryClient, {
          target,
          locale,
          credentialMode: context.credentialMode,
          signal,
        });
      }
    }
    throw new ObsoleteSpacePageReadError();
  },
  head: ({ loaderData, params }) =>
    spacePageHead(loaderData!.page, getLocale(), `/realms/${encodeURIComponent(params.id)}`),
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
  const request = useMemo(
    () => ({ target: { kind: 'realm' as const, id }, locale, credentialMode }),
    [id, locale, credentialMode],
  );
  const current = bindHydratedSpacePage(page, admission, client, request);
  const effectIdentity = JSON.stringify([id, locale, credentialMode, admission.readId, sessionRevision]);
  const latestEffect = useRef({ identity: effectIdentity, client });
  latestEffect.current = { identity: effectIdentity, client };
  const recoveryKey = JSON.stringify([id, locale, credentialMode, admission.readId, sessionRevision]);
  const recovery = useRef({ key: recoveryKey, client, attempted: false });
  if (recovery.current.key !== recoveryKey || recovery.current.client !== client)
    recovery.current = { key: recoveryKey, client, attempted: false };
  useEffect(() => {
    if (
      latestEffect.current.identity === effectIdentity &&
      latestEffect.current.client === client &&
      !recovery.current.attempted &&
      !current &&
      !bindHydratedSpacePage(page, admission, client, request)
    ) {
      recovery.current.attempted = true;
      void router.invalidate();
    }
  }, [admission, client, current, effectIdentity, page, request, router]);
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
