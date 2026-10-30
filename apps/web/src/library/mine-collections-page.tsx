import { Exposure, useOperation } from '../kernel/exposure';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PlusIcon } from 'lucide-react';
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
  return collections.map((collection) => ({ ...collection, preview: { state: 'unavailable' } }));
}

export function MineCollectionsPageView({ page, pins }: { page: MineCollectionsPage; pins: LibraryPinsRead }) {
  const readable = useOperation('collection.get');
  const canPin = useOperation('library_pin.put') && pins.state === 'loaded' && pins.canUpdate !== false;
  const [layout, setLayout] = useState<CollectionBrowseLayout>('rows');
  const collections = browseRecords(page.collections);
  const navigationCollections = page.navigationCollections ?? page.collections;
  return (
    <div className="w-full min-w-0 max-w-none space-y-5 text-foreground">
      <article className="w-full min-w-0 space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <PageHeading>{m.library_collections_heading()}</PageHeading>
          <Exposure operation="library_label.list">
            <Link to="/library/labels" className={buttonVariants({ variant: 'outline' })}>
              {m.library_labels_heading()}
            </Link>
          </Exposure>
        </header>
        <CollectionBrowseToolbar layout={layout} onLayoutChange={setLayout}>
          <LibraryNavigation current="collections" pins={pins} collections={navigationCollections} />
          <Exposure operation="collection.create">
            <a
              href={`/${getLocale()}/collections/new`}
              className={buttonVariants({ size: 'icon' })}
              aria-label={m.library_collection_new()}
            >
              <PlusIcon aria-hidden="true" />
            </a>
          </Exposure>
        </CollectionBrowseToolbar>
        {collections.length ? (
          <CollectionBrowseList
            collections={collections}
            layout={layout}
            readable={readable}
            {...(canPin
              ? {
                  menuFor: (collection: CollectionBrowseRecord) => (
                    <PinControl collectionId={collection.id} pins={pins} mode="collection" />
                  ),
                }
              : {})}
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
                        {pin.target.title ?? m.library_pin_unavailable()}
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
                search={{ cursor: page.next }}
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
