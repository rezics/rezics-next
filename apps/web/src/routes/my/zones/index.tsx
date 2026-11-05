import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useSession } from '../../../session/query';
import { ZonesOwnerWorkspace } from '../../../features/zones/manage/workspace';
import { changeMyZone, readMyZones } from '../../../features/zones/manage/actions';
import { listInput } from '../../../features/zones/manage/model';
import { getLocale } from '../../../paraglide/runtime.js';
import { ZonesPending, ZonesRouteError } from '../../../features/zones/manage/route-feedback';
import { captureOwnerRead, sameOwnerRead, useOwnerLifetime } from '../../../features/zones/editor/owner-lifetime';
import type { CommandOutcome, ListOutcome } from '../../../features/zones/manage/model';

export const Route = createFileRoute('/my/zones/')({
  validateSearch: listInput,
  loaderDeps: ({ search }) => ({ input: listInput(search), locale: getLocale() }),
  loader: async ({ context, deps, abortController }) => {
    const requestedOwner = captureOwnerRead(context.queryClient, abortController.signal);
    const outcome = requestedOwner
      ? await readMyZones({
          data: { ...deps.input, expectedReader: requestedOwner.reader, admission: requestedOwner.admission },
        })
      : ({ kind: 'signed-out' } as ListOutcome);
    return { outcome, requestedOwner, input: deps.input, locale: deps.locale };
  },
  pendingComponent: ZonesPending,
  errorComponent: ZonesRouteError,
  component: MyZonesRoute,
});

function MyZonesRoute() {
  const router = useRouter();
  const { state: sessionState } = useSession();
  const location = useLocation();
  const input = listInput(Route.useSearch());
  const { outcome, requestedOwner, input: loadedInput, locale: loadedLocale } = Route.useLoaderData();
  const locale = getLocale();
  const routeKey = JSON.stringify([locale, location.pathname, location.search, input]);
  const { lifetime, snapshot } = useOwnerLifetime(routeKey, requestedOwner);
  const invalidated = useRef<string | null>(null);
  const loaderMatchesRoute =
    loadedLocale === locale && loadedInput.deleted === input.deleted && loadedInput.cursor === input.cursor;
  const invalidationKey = `${routeKey}:${snapshot.incarnation}:${requestedOwner?.admission ?? 'none'}`;
  const requestedCurrent = sameOwnerRead(requestedOwner, snapshot.capture?.observation);
  const currentRead = loaderMatchesRoute && requestedCurrent && lifetime.owns(outcome.ownerObservation);
  const visibleOutcome = sessionState === 'signed-out' ? { kind: 'signed-out' as const } : outcome;
  useLayoutEffect(() => {
    const capture = snapshot.capture;
    if (!capture || !requestedCurrent || currentRead || !lifetime.isCurrent(capture)) return;
    lifetime.retire(capture);
  }, [currentRead, lifetime, requestedCurrent, snapshot]);
  useEffect(() => {
    const capture = snapshot.capture;
    if (!capture || !loaderMatchesRoute || (requestedCurrent && currentRead) || !lifetime.isCurrent(capture)) return;
    if (invalidated.current === invalidationKey) return;
    invalidated.current = invalidationKey;
    void router.invalidate();
  }, [currentRead, invalidationKey, lifetime, loaderMatchesRoute, requestedCurrent, router, snapshot]);
  return (
    <ZonesOwnerWorkspace
      key={`${routeKey}:${snapshot.incarnation}`}
      locale={locale}
      input={input}
      outcome={sessionState === 'signed-out' ? visibleOutcome : currentRead ? visibleOutcome : null}
      owner={lifetime}
      onChange={(command, capture): Promise<CommandOutcome> => {
        if (!lifetime.isCurrent(capture)) return Promise.resolve({ kind: 'stale' });
        return changeMyZone({
          data: {
            ...command,
            expectedReader: capture.observation.reader,
            admission: capture.observation.admission,
          },
          headers: { 'X-CSRF-Token': capture.csrfToken ?? '' },
        });
      }}
      onReload={() => router.invalidate()}
    />
  );
}
