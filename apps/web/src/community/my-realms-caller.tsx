import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import type { MyRealmsPage } from './space';
import { MyRealmsPageView } from './my-realms-page';
import { MyRealmsCurrentControllerHost } from './my-realms-current/controller';
import { myRealmsQuery } from './realm-membership-queries';
import {
  MyRealmsCaller,
  myRealmsCallerForVisit,
  type MyRealmsMovement,
  type MyRealmsVisit,
  type MyRealmsViewOwner,
} from './my-realms-lifetime';

export {
  MyRealmsCaller,
  captureMyRealmsCaller,
  myRealmsCallerForVisit,
  retireMyRealmsNavigation,
  useMyRealmsInventoryVisit,
} from './my-realms-lifetime';
export type { MyRealmsMovement, MyRealmsNavigation, MyRealmsViewOwner, MyRealmsVisit } from './my-realms-lifetime';

const browserHydration = { subscribe: () => () => {}, getSnapshot: () => true, getServerSnapshot: () => false };

function normalizedTarget(pathname: string) {
  return pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/u, '').replace(/\/$/u, '') || '/';
}

export function MyRealmsCallerHost({
  initial,
  cursor,
}: {
  initial: { page: MyRealmsPage; visit: MyRealmsVisit };
  cursor?: string | undefined;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const session = useSession();
  const locale = getLocale();
  const caller = useMemo(() => myRealmsCallerForVisit(client, initial.visit), [client, initial.visit.id]);
  const hydrated = useSyncExternalStore(
    browserHydration.subscribe,
    browserHydration.getSnapshot,
    browserHydration.getServerSnapshot,
  );
  useSyncExternalStore(caller.subscribe, caller.getRevision, caller.getRevision);
  const address = {
    target: normalizedTarget(location.pathname),
    cursor,
    locale,
    credentialMode: 'session' as const,
  };
  const matchingAddress = caller.isCurrentAddress(address);
  const currentOwner = useMemo<MyRealmsViewOwner>(
    () => ({
      visit: initial.visit,
      ready: hydrated && caller.isCurrent(),
      subscribe: caller.subscribe,
      getRevision: caller.getRevision,
      isCurrent: () => caller.isCurrent(),
      acceptsPage: (page) => caller.acceptsLoaderData(initial.visit, page) || caller.acceptsQueryData(page),
    }),
    [caller, hydrated, initial.visit],
  );
  const focusContinuation = caller.hasContinuationFocus() ? () => caller.claimContinuationFocus() : undefined;
  const onMove = (kind: MyRealmsMovement, cursor: string | null, trigger?: HTMLElement) =>
    caller.move(kind, cursor, trigger);

  useEffect(() => {
    const disconnect = caller.connect();
    caller.verifyHydration();
    return disconnect;
  }, [caller]);

  if (!matchingAddress) throw new Error('My Realms route changed');
  if (!hydrated && caller.acceptsHydrationSeed(initial.visit, initial.page))
    return (
      <div className="space-y-6">
        <Link to="/realms/new" className="inline-flex min-h-10 items-center text-primary underline underline-offset-4">
          {m.space_setup_heading()}
        </Link>
        <MyRealmsCurrentControllerHost page={initial.page} owner={currentOwner}>
          {(controller) => (
            <MyRealmsPageView
              page={initial.page}
              navigation={caller.navigation()}
              onMove={onMove}
              focusContinuation={focusContinuation}
              currentController={controller}
            />
          )}
        </MyRealmsCurrentControllerHost>
      </div>
    );
  if (hydrated && caller.adoptionPending()) return null;
  if (hydrated && session.state !== 'signed-in') throw new Error('Realm list is unavailable');
  // A signed-in route match may briefly outlive its visit while the router admits the next one.
  if (hydrated && !caller.isCurrent()) return null;
  return (
    <MyRealmsAdmittedPage
      caller={caller}
      initial={initial}
      cursor={cursor}
      owner={currentOwner}
      onMove={onMove}
      focusContinuation={focusContinuation}
    />
  );
}

/** Retired cached route matches must not recreate the target Query during caller capture. */
function MyRealmsAdmittedPage({
  caller,
  initial,
  cursor,
  owner,
  onMove,
  focusContinuation,
}: {
  caller: MyRealmsCaller;
  initial: { page: MyRealmsPage; visit: MyRealmsVisit };
  cursor: string | undefined;
  owner: MyRealmsViewOwner;
  onMove: (kind: MyRealmsMovement, cursor: string | null, trigger?: HTMLElement) => boolean;
  focusContinuation: (() => boolean) | undefined;
}) {
  caller.assertCurrent();
  const query = useQuery({ ...myRealmsQuery(cursor, caller), enabled: false });
  if (query.isError) throw query.error;
  const page = caller.acceptsQueryData(query.data)
    ? query.data
    : caller.acceptsLoaderData(initial.visit, initial.page)
      ? initial.page
      : undefined;
  if (!page) throw new Error('Realm list is unavailable');

  return (
    <div className="space-y-6">
      <Link to="/realms/new" className="inline-flex min-h-10 items-center text-primary underline underline-offset-4">
        {m.space_setup_heading()}
      </Link>
      <MyRealmsCurrentControllerHost page={page} owner={owner}>
        {(controller) => (
          <MyRealmsPageView
            page={page}
            navigation={caller.navigation()}
            onMove={onMove}
            focusContinuation={focusContinuation}
            currentController={controller}
          />
        )}
      </MyRealmsCurrentControllerHost>
    </div>
  );
}
