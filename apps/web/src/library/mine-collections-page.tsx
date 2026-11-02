import { admitMineCollectionsAddress, type MineCollectionsAddressError } from './mine-collections-address';
import { MineCollectionsAddressRecovery } from './mine-collections-address-recovery';
import { Exposure, useOperation } from '../kernel/exposure';
import { ContentItem } from '@rezics/ui/content-item';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@rezics/ui/shadcn/empty';
import { Link, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
import type { MineCollection, MineCollectionsPage } from './mine-collections';
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
}: {
  initial: MineCollectionsViewerPage;
  addressError?: MineCollectionsAddressError;
  layout?: CollectionBrowseLayout;
  cursor?: string;
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
      initial={initial}
      seed={lifetime.seed}
    />
  );
}

function MineCollectionsViewerRead({
  subject,
  address,
  locale,
  hydrated,
  pinsAdmitted,
  collectionsAdmitted,
  origin,
  initial,
  seed,
}: {
  subject: string;
  address: MineCollectionsAddress;
  locale: string;
  hydrated: boolean;
  pinsAdmitted: boolean;
  collectionsAdmitted: boolean;
  origin: ReturnType<typeof useLibraryReadOrigin>;
  initial: MineCollectionsViewerPage;
  seed: boolean;
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
  const pinsOrigin: AcceptedPinsOrigin = {
    lifetime: origin.pins,
    isCurrent: () => current.current && origin.pinsCurrent(),
    queryKey,
  };
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
}: {
  page: MineCollectionsPage;
  pins: LibraryPinsRead;
  pinsOrigin?: AcceptedPinsOrigin;
  layout?: CollectionBrowseLayout;
  cursor?: string;
}) {
  const navigate = useNavigate();
  const canCreate = useOperation('collection.create');
  const canReadLibrary = useOperation('library_entry.list');
  const loaded = page.signedIn && (!page.state || page.state === 'loaded');
  const requestedAddress = admitMineCollectionsAddress({ cursor, layout, addressError: page.invalidAddress });
  const requestedCursor = requestedAddress.cursor;
  const currentCursor = page.cursorReset ? undefined : requestedCursor;
  const search = new URLSearchParams({ layout, ...(currentCursor ? { cursor: currentCursor } : {}) });
  const currentHref = `/${getLocale()}/library/collections?${search}`;
  const firstHref = `/${getLocale()}/library/collections?${new URLSearchParams({ layout })}`;
  const exploreHref = `/${getLocale()}${canReadLibrary ? '/library' : '/search'}`;
  const exploreLabel = canReadLibrary ? m.library_heading() : m.search_heading();
  const setLayout = (next: CollectionBrowseLayout) =>
    void navigate({
      to: '/library/collections',
      search: { ...(currentCursor ? { cursor: currentCursor } : {}), layout: next },
    });
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
        {loaded && collections.length ? <CollectionBrowseToolbar layout={layout} onLayoutChange={setLayout} /> : null}
        {page.signedIn && page.cursorReset ? <p role="status">{m.library_collections_cursor_reset()}</p> : null}
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
              <a
                href={page.state === 'denied' ? exploreHref : currentHref}
                className={buttonVariants({ variant: 'outline' })}
              >
                {page.state === 'denied' ? exploreLabel : m.library_collections_retry()}
              </a>
            </EmptyContent>
          </Empty>
        ) : collections.length ? (
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
            <EmptyContent>
              {firstPageEmpty && canCreate ? (
                createAction
              ) : (
                <a href={firstPageEmpty ? exploreHref : firstHref} className={buttonVariants({ variant: 'outline' })}>
                  {firstPageEmpty ? exploreLabel : m.library_collections_first_page()}
                </a>
              )}
            </EmptyContent>
          </Empty>
        )}
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
        {loaded && page.next ? (
          <Exposure operation="collection.list">
            <nav aria-label={m.library_collections_heading()}>
              <Link
                to="/library/collections"
                search={{ cursor: page.next, layout }}
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
              >
                {m.library_collection_more()}
              </Link>
            </nav>
          </Exposure>
        ) : null}
      </article>
    </div>
  );
}
