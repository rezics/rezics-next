import { Exposure, useOperation } from '../kernel/exposure';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader } from '@rezics/ui/shadcn/empty';
import { Link, useNavigate } from '@tanstack/react-router';
import { PlusIcon } from 'lucide-react';
import { browseCollectionTitle } from './collection-browser';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { LibraryNavigation } from './library-nav';
import { PinControl } from './pin-control';
import type { LibraryPinsRead } from './pins-read';
import type { MineCollection, MineCollectionsPage } from './mine-collections';
import {
  CollectionBrowseList,
  CollectionBrowseToolbar,
  type CollectionBrowseLayout,
  type CollectionBrowseRecord,
} from './collection-browser';

function browseRecords(collections: readonly MineCollection[]): CollectionBrowseRecord[] {
  return collections.map((collection) => ({ ...collection, preview: collection.preview ?? { state: 'unavailable' } }));
}

export function MineCollectionsPageView({
  page,
  pins,
  layout = 'rows',
  cursor,
}: {
  page: MineCollectionsPage;
  pins: LibraryPinsRead;
  layout?: CollectionBrowseLayout;
  cursor?: string;
}) {
  const navigate = useNavigate();
  const canCreate = useOperation('collection.create');
  const canReadLibrary = useOperation('library_entry.list');
  const loaded = page.signedIn && (!page.state || page.state === 'loaded');
  const requestedCursor = cursor && cursor.length <= 4096 ? cursor : undefined;
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
              <PinControl collectionId={collection.id} pins={pins} mode="collection" />
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
                  <li
                    key={pin.collectionId}
                    className="flex min-w-0 items-center justify-between gap-2 rounded-lg px-2 py-1"
                  >
                    {pin.target ? (
                      <a
                        className="truncate hover:underline"
                        href={`/${getLocale()}/collections/${encodeURIComponent(pin.collectionId)}`}
                      >
                        {browseCollectionTitle({ ...pin.target, title: pin.target.title ?? null })}
                      </a>
                    ) : (
                      <span>{m.library_pin_unavailable()}</span>
                    )}
                    <PinControl collectionId={pin.collectionId} pins={pins} mode="list" />
                  </li>
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
