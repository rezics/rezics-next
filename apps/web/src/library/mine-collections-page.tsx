import { Exposure } from '../kernel/exposure';
import { buttonVariants } from '@rezics/ui/shadcn/button';
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
  const setLayout = (next: CollectionBrowseLayout) =>
    void navigate({ to: '/library/collections', search: { ...(cursor ? { cursor } : {}), layout: next } });
  const collections = browseRecords(page.collections);
  const navigationCollections = page.navigationCollections ?? page.collections;
  return (
    <div className="w-full min-w-0 max-w-none space-y-5 text-foreground">
      <article className="w-full min-w-0 space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <PageHeading>{m.library_collections_heading()}</PageHeading>
          <div className="flex flex-wrap items-center gap-2">
            <Exposure operation="library_label.list">
              <Link to="/library/labels" className={buttonVariants({ variant: 'outline' })}>
                {m.library_labels_heading()}
              </Link>
            </Exposure>
            <Exposure operation="collection.create">
              <a
                href={`/${getLocale()}/collections/new`}
                className={buttonVariants({ variant: 'outline' })}
                aria-label={m.library_collection_new()}
              >
                <PlusIcon aria-hidden="true" />
                {m.library_collection_new()}
              </a>
            </Exposure>
          </div>
        </header>
        <LibraryNavigation
          current="collections"
          pins={pins}
          collections={navigationCollections}
          collectionsState={
            page.state === 'preparing' ? 'preparing' : page.state && page.state !== 'loaded' ? 'unavailable' : 'loaded'
          }
        />
        <CollectionBrowseToolbar layout={layout} onLayoutChange={setLayout} />
        {!page.signedIn ? (
          <p role="status">{m.library_sign_in()}</p>
        ) : page.state && page.state !== 'loaded' ? (
          <div className="space-y-3" data-collections-state={page.state}>
            <h2 className="text-xl font-semibold">
              {page.state === 'error' || page.state === 'unavailable'
                ? m.error_heading()
                : m.library_collections_heading()}
            </h2>
            <p role={page.state === 'error' || page.state === 'unavailable' ? 'alert' : 'status'}>
              {page.state === 'preparing'
                ? m.library_dynamic_preparing()
                : page.state === 'denied'
                  ? m.library_collections_denied()
                  : page.state === 'error'
                    ? m.error_message()
                    : m.library_collections_unavailable()}
            </p>
            <a href={`/${getLocale()}/library/collections`} className={buttonVariants({ variant: 'outline' })}>
              {m.library_follow_retry()}
            </a>
          </div>
        ) : collections.length ? (
          <CollectionBrowseList
            collections={collections}
            layout={layout}
            menuFor={(collection: CollectionBrowseRecord) => (
              <PinControl collectionId={collection.id} pins={pins} mode="collection" />
            )}
          />
        ) : (
          <p className="text-muted-foreground">{m.library_collections_empty()}</p>
        )}
        {pins.state === 'loaded' && pins.pins.length ? (
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
        {page.next ? (
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
