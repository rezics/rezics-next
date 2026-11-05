import { admitMineCollectionsAddress, type MineCollectionsAddressError } from './mine-collections-address';
import { MineCollectionsAddressRecovery } from './mine-collections-address-recovery';
import { Exposure, useOperation } from '../kernel/exposure';
import { ContentItem } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@rezics/ui/shadcn/empty';
import { Link, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { browseCollectionTitle } from './collection-browser';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { LibraryNavigation } from './library-nav';
import { PinControl } from './pin-control';
import { matchesPinsOrigin, type LibraryPinsRead } from './pins-read';
import { useLibraryReadOrigin, type AcceptedPinsOrigin } from './pins-current';
import {
  MineCollectionsWindowsVisit,
  type MineCollectionsLayout,
  type MineCollectionsWindowAction,
  type MineCollectionsWindowsSnapshot,
} from './mine-collections-windows/visit';
import type { MineCollection, MineCollectionsPage } from './mine-collections';
import { SavedQueryDirectory } from './saved-query-directory';
import {
  readMineCollectionsViewerPage,
  type MineCollectionsAddress,
  type MineCollectionsViewerPage,
} from './mine-collections-route';
import {
  CollectionBrowseList,
  CollectionBrowseToolbar,
  type CollectionBrowseLayout,
  type CollectionBrowseRecord,
} from './collection-browser';

const subscribe = () => () => {};
const emptyWindowsSnapshot: MineCollectionsWindowsSnapshot = {
  coordinates: [],
  current: null,
  movement: null,
  cursorReset: false,
  focusReady: false,
  revision: 0,
};
const getEmptyWindowsSnapshot = () => emptyWindowsSnapshot;

function matchesViewer(page: MineCollectionsViewerPage | undefined, subject: string, address: MineCollectionsAddress) {
  return (
    !address.addressError &&
    !page?.requested.addressError &&
    page?.sessionSubject === subject &&
    page.page.signedIn &&
    page.requested.cursor === address.cursor &&
    page.requested.layout === address.layout
  );
}

/** The default private route observes the browser viewer independently of retained loader data. */
export function MineCollectionsCurrentViewer({
  initial,
  layout = 'rows',
  cursor,
  addressError,
  windows,
  locationKey,
}: {
  initial: MineCollectionsViewerPage;
  addressError?: MineCollectionsAddressError;
  layout?: CollectionBrowseLayout;
  cursor?: string;
  windows?: MineCollectionsWindowsVisit;
  locationKey?: string;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const canList = useOperation('collection.list');
  const canListPins = useOperation('library_pin.list');
  const subject = hydrated ? (session.state === 'signed-in' ? session.subject : null) : initial.sessionSubject;
  const admitted = !hydrated || canList;
  const pinsAdmitted = !hydrated || canListPins;
  const admittedAddress = admitMineCollectionsAddress({ cursor, layout, addressError });
  const address: MineCollectionsAddress = { ...admittedAddress, cursor: admittedAddress.cursor ?? null };
  const locale = getLocale();
  const origin = useLibraryReadOrigin(JSON.stringify([address, locale]), initial.sessionSubject);
  const [mountedOrigin, setMountedOrigin] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (origin.mounted()) setMountedOrigin(origin.lifetime);
  }, [origin.lifetime]);
  const originMounted = mountedOrigin === origin.lifetime && origin.mounted();
  const authorityKey = admittedAddress.addressError ? null : mineCollectionsWindowAuthority(origin, locale);
  useLayoutEffect(() => {
    windows?.observe(authorityKey, address.cursor, address.layout, locationKey);
  }, [windows, authorityKey, address.cursor, address.layout, locationKey]);
  const key = JSON.stringify([subject, admitted, pinsAdmitted, address, locale, origin.lifetime]);
  const [lifetime, setLifetime] = useState({ key, generation: 0, seed: true });
  if (lifetime.key !== key) setLifetime({ key, generation: lifetime.generation + 1, seed: false });

  if (admittedAddress.addressError) return <MineCollectionsAddressRecovery address={admittedAddress} />;

  if (!subject || (!admitted && !pinsAdmitted)) {
    const page: MineCollectionsPage = {
      signedIn: hydrated ? session.state !== 'signed-out' : initial.page.signedIn,
      state: session.state === 'unknown' ? 'preparing' : subject && !admitted ? 'denied' : 'unavailable',
      collections: [],
      next: null,
    };
    return (
      <MineCollectionsPageView page={page} pins={{ state: 'closed' }} layout={layout} {...(cursor ? { cursor } : {})} />
    );
  }
  return (
    <MineCollectionsViewerRead
      key={lifetime.generation}
      subject={subject}
      address={address}
      locale={locale}
      hydrated={hydrated}
      pinsAdmitted={pinsAdmitted}
      collectionsAdmitted={admitted}
      origin={origin}
      originMounted={originMounted}
      initial={initial}
      seed={lifetime.seed}
      {...(windows ? { windows } : {})}
      authorityKey={authorityKey}
    />
  );
}

function mineCollectionsWindowAuthority(
  origin: ReturnType<typeof useLibraryReadOrigin>,
  locale: string,
): string | null {
  const current = origin.workspaceAdmission.read();
  const observation = current.observation;
  if (
    !origin.hydrated ||
    !origin.subject ||
    !observation ||
    observation.subject !== origin.subject ||
    current.allowed[1] !== true
  )
    return null;
  return JSON.stringify([
    origin.subject,
    current.viewer,
    observation.id,
    current.episodes[1],
    current.dispatch[1],
    current.allowed[1],
    locale,
  ]);
}

function MineCollectionsViewerRead({
  subject,
  address,
  locale,
  hydrated,
  pinsAdmitted,
  collectionsAdmitted,
  origin,
  originMounted,
  initial,
  seed,
  windows,
  authorityKey,
}: {
  subject: string;
  address: MineCollectionsAddress;
  locale: string;
  hydrated: boolean;
  pinsAdmitted: boolean;
  collectionsAdmitted: boolean;
  origin: ReturnType<typeof useLibraryReadOrigin>;
  originMounted: boolean;
  initial: MineCollectionsViewerPage;
  seed: boolean;
  windows?: MineCollectionsWindowsVisit;
  authorityKey: string | null;
}) {
  // A retired admission/address cannot reuse a previous lifetime's private cache, including ABA returns.
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matchesViewer(initial, subject, address) ? initial : undefined));
  const queryKey = ['mine-collections-current-viewer', subject, locale, address.cursor, address.layout, lifetime];
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      if (!origin.mounted() || !origin.isCurrent()) throw new Error('Retired My Collections read');
      const result = await readMineCollectionsViewerPage({
        data: { cursor: address.cursor ?? undefined, layout: address.layout },
      });
      if (!origin.mounted() || !origin.isCurrent() || !matchesViewer(result, subject, address))
        throw new Error('Unaccepted My Collections read');
      return result;
    },
    initialData,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // Router invalidation (including a completed pin command) refreshes this lifetime's
  // actual read. A retained loader response never becomes a fallback for a replacement.
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    void query.refetch();
  }, [initial, query.refetch]);
  const accepted =
    !query.isError && origin.isCurrent() && matchesViewer(query.data, subject, address) ? query.data : undefined;
  // The initial envelope is itself the parent's same-prepared viewer/address authority.
  // Older pure fixtures omit nested provenance; a supplied conflicting provenance always fails closed.
  const pins =
    accepted &&
    pinsAdmitted &&
    origin.pinsCurrent() &&
    (!accepted.pins.origin || matchesPinsOrigin(accepted.pins.origin, subject, 100))
      ? accepted.pins
      : { state: 'closed' as const };
  const current = useRef(false);
  current.current = !!accepted && pins.state === 'loaded';
  const admittedCollections =
    !!accepted &&
    collectionsAdmitted &&
    originMounted &&
    origin.mounted() &&
    origin.isCurrent() &&
    origin.collectionsCurrent() &&
    accepted.page.signedIn &&
    (!accepted.page.state || accepted.page.state === 'loaded');
  useEffect(() => {
    if (!windows || !authorityKey) return;
    if (admittedCollections && accepted) {
      windows.accept(authorityKey, address.cursor ?? null, accepted.page.cursorReset === true);
      return;
    }
    if (
      origin.mounted() &&
      origin.collectionsCurrent() &&
      (query.isError || (!!accepted && accepted.page.state !== 'loaded'))
    )
      windows.failMovement(authorityKey, address.cursor ?? null);
  }, [windows, authorityKey, admittedCollections, accepted, address.cursor, query.isError, query.data]);
  const pinsOrigin: AcceptedPinsOrigin = {
    lifetime: origin.pins,
    isCurrent: () => current.current && origin.pinsCurrent(),
    queryKey,
  };
  const admittedCursor = accepted?.page.cursorReset ? null : (address.cursor ?? null);
  return (
    <MineCollectionsPageView
      page={
        accepted && collectionsAdmitted && origin.collectionsCurrent()
          ? accepted.page
          : {
              signedIn: true,
              state: !collectionsAdmitted ? 'denied' : query.isError || query.data ? 'unavailable' : 'preparing',
              collections: [],
              next: null,
            }
      }
      pins={pins}
      pinsOrigin={pinsOrigin}
      layout={address.layout}
      viewerId={subject}
      {...(windows ? { windows } : {})}
      windowAuthorityKey={authorityKey}
      windowCurrent={() => !!admittedCollections && origin.collectionsCurrent() && origin.isCurrent()}
      onMove={(action, target, element) => {
        if (!windows || !authorityKey || !admittedCollections || !origin.collectionsCurrent() || !origin.isCurrent())
          return false;
        return windows.beginMovement(authorityKey, action, admittedCursor, target, element);
      }}
      onLayoutChange={(nextLayout) => {
        const currentCursor = accepted?.page.cursorReset ? null : (address.cursor ?? null);
        if (windows && authorityKey && admittedCollections)
          windows.beginLayoutChange(authorityKey, currentCursor, nextLayout);
      }}
      onRetry={(element) => {
        if (windows && authorityKey) windows.retryMovement(authorityKey, address.cursor ?? null, element);
        void query.refetch();
      }}
      {...(address.cursor ? { cursor: address.cursor } : {})}
    />
  );
}

function browseRecords(collections: readonly MineCollection[]): CollectionBrowseRecord[] {
  return collections.map((collection) => ({ ...collection, preview: collection.preview ?? { state: 'unavailable' } }));
}

export function MineCollectionsPageView({
  page,
  pins,
  pinsOrigin,
  layout = 'rows',
  cursor,
  viewerId,
  windows,
  windowAuthorityKey,
  windowCurrent,
  onMove,
  onLayoutChange,
  onRetry,
}: {
  page: MineCollectionsPage;
  pins: LibraryPinsRead;
  pinsOrigin?: AcceptedPinsOrigin;
  layout?: CollectionBrowseLayout;
  cursor?: string;
  viewerId?: string | null;
  windows?: MineCollectionsWindowsVisit;
  windowAuthorityKey?: string | null;
  windowCurrent?: () => boolean;
  onMove?: (
    action: MineCollectionsWindowAction,
    target: string | null,
    element: HTMLElement,
  ) => boolean;
  onLayoutChange?: (layout: CollectionBrowseLayout) => void;
  onRetry?: (element: HTMLElement) => void;
}) {
  const navigate = useNavigate();
  const canCreate = useOperation('collection.create');
  const canReadLibrary = useOperation('library_entry.list');
  const canEditRules = useOperation('collection.update');
  const loaded = page.signedIn && (!page.state || page.state === 'loaded');
  const requestedAddress = admitMineCollectionsAddress({ cursor, layout, addressError: page.invalidAddress });
  const requestedCursor = requestedAddress.cursor;
  const currentCursor = page.cursorReset ? undefined : requestedCursor;
  const search = new URLSearchParams({ layout, ...(currentCursor ? { cursor: currentCursor } : {}) });
  const currentHref = `/${getLocale()}/library/collections?${search}`;
  const exploreHref = `/${getLocale()}${canReadLibrary ? '/library' : '/search'}`;
  const exploreLabel = canReadLibrary ? m.library_heading() : m.search_heading();
  const setLayout = (next: CollectionBrowseLayout) => {
    onLayoutChange?.(next);
    void navigate({
      to: '/library/collections',
      search: { ...(currentCursor ? { cursor: currentCursor } : {}), layout: next },
    });
  };
  const windowSnapshot = useSyncExternalStore(
    windows?.subscribe ?? subscribe,
    windows?.getSnapshot ?? getEmptyWindowsSnapshot,
    getEmptyWindowsSnapshot,
  );
  const collectionRegion = useRef<HTMLDivElement>(null);
  const currentCoordinate = currentCursor ?? null;
  const hasCurrentCoordinate =
    windowSnapshot.current === currentCoordinate && windowSnapshot.coordinates.at(-1) === currentCoordinate;
  const canPrevious =
    loaded && !!windows && !!windowAuthorityKey && hasCurrentCoordinate && windowSnapshot.coordinates.length > 1;
  const canFirst = loaded && currentCursor !== undefined;
  useEffect(() => {
    if (!loaded || !windows || !windowAuthorityKey || !windowSnapshot.focusReady) return;
    if (!windowCurrent?.()) {
      windows.cancelMovementFocus(windowAuthorityKey);
      return;
    }
    if (windows.consumeFocus(windowAuthorityKey)) collectionRegion.current?.focus();
  }, [loaded, windows, windowAuthorityKey, windowSnapshot.focusReady, windowCurrent]);
  const collections = loaded ? browseRecords(page.collections) : [];
  const navigationCollections = page.navigationCollections ?? page.collections;
  const firstPageEmpty = loaded && !collections.length && !currentCursor && !page.next;
  const createAction = (
    <a href={`/${getLocale()}/collections/new`} className={buttonVariants({ variant: 'outline' })}>
      <PlusIcon aria-hidden="true" />
      {m.library_collection_new()}
    </a>
  );
  if (requestedAddress.addressError) return <MineCollectionsAddressRecovery address={requestedAddress} />;
  return (
    <div className="w-full min-w-0 max-w-none space-y-5 text-foreground">
      <article className="w-full min-w-0 space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <PageHeading>{m.library_collections_heading()}</PageHeading>
          {loaded && collections.length ? (
            <div className="flex flex-wrap items-center gap-2">
              <Exposure operation="library_label.list">
                <Link to="/library/labels" className={buttonVariants({ variant: 'outline' })}>
                  {m.library_labels_heading()}
                </Link>
              </Exposure>
              <Exposure operation="collection.create">{createAction}</Exposure>
            </div>
          ) : null}
        </header>
        {page.signedIn ? (
          <LibraryNavigation
            current="collections"
            pins={pins}
            collections={loaded ? navigationCollections : []}
            collectionsState={page.state ?? 'loaded'}
            showCollectionsNotice={false}
          />
        ) : null}
        {loaded && viewerId ? (
          <SavedQueryDirectory
            collections={page.collections}
            capability={page.savedQueryCapability ?? 'unavailable'}
            viewerId={viewerId}
            canEditRules={canEditRules}
            currentHref={currentHref}
            next={page.next}
            layout={layout}
          />
        ) : null}
        {loaded && collections.length ? <CollectionBrowseToolbar layout={layout} onLayoutChange={setLayout} /> : null}
        {page.signedIn && (page.cursorReset || windowSnapshot.cursorReset) ? (
          <p role="status">{m.library_collections_cursor_reset()}</p>
        ) : null}
        {!page.signedIn ? (
          <Empty>
            <EmptyHeader>
              <EmptyDescription>{m.library_sign_in()}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <a
                href={`/auth/sign-in?return_to=${encodeURIComponent(currentHref)}`}
                className={buttonVariants({ variant: 'outline' })}
              >
                {m.account_sign_in()}
              </a>
            </EmptyContent>
          </Empty>
        ) : !loaded ? (
          <Empty data-collections-state={page.state}>
            <EmptyHeader>
              <EmptyDescription role={page.state === 'error' || page.state === 'unavailable' ? 'alert' : 'status'}>
                {page.state === 'preparing'
                  ? m.library_collections_preparing()
                  : page.state === 'denied'
                    ? m.library_collections_denied()
                    : page.state === 'error'
                      ? m.library_collections_read_failed()
                      : m.library_collections_unavailable()}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {page.state === 'denied' ? (
                <a href={exploreHref} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                  {exploreLabel}
                </a>
              ) : onRetry ? (
                <button
                  type="button"
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                  onClick={(event) => onRetry(event.currentTarget)}
                >
                  {m.library_collections_retry()}
                </button>
              ) : (
                <a href={currentHref} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                  {m.library_collections_retry()}
                </a>
              )}
            </EmptyContent>
          </Empty>
        ) : (
          <div
            ref={collectionRegion}
            role="region"
            aria-label={m.library_collections_heading()}
            tabIndex={-1}
            className="rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            data-collections-list-region
          >
            {collections.length ? (
              <CollectionBrowseList
                collections={collections}
                layout={layout}
                menuFor={(collection: CollectionBrowseRecord) => (
                  <PinControl collectionId={collection.id} pins={pins} mode="collection" origin={pinsOrigin} />
                )}
              />
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyDescription>
                    {firstPageEmpty ? m.library_collections_empty() : m.library_collections_page_empty()}
                  </EmptyDescription>
                  {firstPageEmpty ? (
                    <EmptyDescription>
                      {canCreate ? m.library_collections_start() : m.library_collections_start_unavailable()}
                    </EmptyDescription>
                  ) : null}
                </EmptyHeader>
                {firstPageEmpty && canCreate ? <EmptyContent>{createAction}</EmptyContent> : null}
              </Empty>
            )}
          </div>
        )}
        {loaded && (canPrevious || canFirst || page.next) ? (
          <Exposure operation="collection.list">
            <nav aria-label={m.library_collections_heading()} className="flex flex-wrap gap-2">
              {canPrevious ? (
                <Link
                  to="/library/collections"
                  search={{
                    ...(windowSnapshot.coordinates.at(-2) ? { cursor: windowSnapshot.coordinates.at(-2)! } : {}),
                    layout,
                  }}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      (event.button !== 0 && event.detail !== 0) ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    if (
                      onMove &&
                      !onMove('previous', windowSnapshot.coordinates.at(-2) ?? null, event.currentTarget)
                    )
                      event.preventDefault();
                  }}
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                >
                  {m.library_collections_previous()}
                </Link>
              ) : null}
              {canFirst ? (
                <Link
                  to="/library/collections"
                  search={{ layout }}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      (event.button !== 0 && event.detail !== 0) ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    if (onMove && !onMove('first', null, event.currentTarget)) event.preventDefault();
                  }}
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                >
                  {m.library_collections_first_page()}
                </Link>
              ) : null}
              {page.next ? (
                <Link
                  to="/library/collections"
                  search={{ cursor: page.next, layout }}
                  onClick={(event) => {
                    if (
                      event.defaultPrevented ||
                      (event.button !== 0 && event.detail !== 0) ||
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    if (onMove && !onMove('next', page.next, event.currentTarget)) event.preventDefault();
                  }}
                  className={buttonVariants({ variant: 'outline', size: 'lg' })}
                >
                  {m.library_collection_more()}
                </Link>
              ) : null}
            </nav>
          </Exposure>
        ) : null}
        {page.signedIn && pins.state === 'loaded' && pins.pins.length ? (
          <details className="rounded-xl bg-muted/30 p-3" data-library-pin-manager>
            <summary className="cursor-pointer text-sm font-medium">{m.library_pin_pinned_section()}</summary>
            <section aria-labelledby="library-pinned-heading" className="mt-3">
              <h2 id="library-pinned-heading" className="sr-only">
                {m.library_pin_pinned_section()}
              </h2>
              <ul className="space-y-1">
                {pins.pins.map((pin) => (
                  <ContentItem
                    key={pin.collectionId}
                    title={
                      pin.target
                        ? browseCollectionTitle({ ...pin.target, title: pin.target.title ?? null })
                        : m.library_pin_unavailable()
                    }
                    headingLevel={3}
                    {...(pin.target
                      ? { href: `/${getLocale()}/collections/${encodeURIComponent(pin.collectionId)}` }
                      : {})}
                    actions={<PinControl collectionId={pin.collectionId} pins={pins} mode="list" origin={pinsOrigin} />}
                  />
                ))}
              </ul>
            </section>
          </details>
        ) : null}
      </article>
    </div>
  );
}
