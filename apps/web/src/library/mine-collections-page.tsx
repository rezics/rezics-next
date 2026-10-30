import { Exposure, useOperation } from '../kernel/exposure';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
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
      <LibraryNavigation current="collections" pins={pins} collections={navigationCollections} />
      <article className="w-full min-w-0 space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <PageHeading>{m.library_collections_heading()}</PageHeading>
          <div className="flex flex-wrap items-center gap-2">
            <Exposure operation="library_label.list">
              <Link to="/library/labels" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                {m.library_labels_heading()}
              </Link>
            </Exposure>
            <Exposure operation="collection.create">
              <a href={`/${getLocale()}/collections/new`} className={buttonVariants({ size: 'lg' })}>
                {m.library_collection_new()}
              </a>
            </Exposure>
          </div>
        </header>
        <CollectionBrowseToolbar layout={layout} onLayoutChange={setLayout}>
          <span className="sr-only">{m.library_collections_heading()}</span>
        </CollectionBrowseToolbar>
        {pins.state === 'unavailable' ? (
          <p role="status" className="text-sm text-muted-foreground">{m.library_pin_read_failed()}</p>
        ) : null}
        {collections.length ? (
          <CollectionBrowseList
            collections={collections}
            layout={layout}
            readable={readable}
            menuFor={canPin ? (collection) => <PinControl collectionId={collection.id} pins={pins} mode="collection" /> : undefined}
          />
        ) : (
          <p className="text-muted-foreground">{m.library_collections_empty()}</p>
        )}
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
