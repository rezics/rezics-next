import { Exposure, useOperation } from '../kernel/exposure';
import { sharedRatio } from '@rezics/ui/cover';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { coverSrc } from '../media/cover-src';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { dynamicCollectionTitle, type DynamicBuiltinKind } from './dynamic-collection';
import { LibraryNavigation } from './library-nav';
import { PinControl } from './pin-control';
import type { LibraryPinsRead } from './pins-read';
import type { CollectionVisibility } from './reads';
import type { MineCollection, MineCollectionsPage } from './mine-collections';

function visibilityLabel(visibility: CollectionVisibility): string {
  if (visibility === 'public') return m.library_visibility_public();
  if (visibility === 'unlisted') return m.library_visibility_unlisted();
  return m.library_visibility_private();
}

function collectionTitle(collection: MineCollection): string {
  if (collection.title !== null) return collection.title;
  return dynamicCollectionTitle(
    {
      builtinKind: (collection.builtinKind ?? 'state') as DynamicBuiltinKind,
      title: null,
      ...(collection.builtinLabels ? { builtinLabels: collection.builtinLabels } : {}),
    },
    getLocale(),
  );
}

export function MineCollectionsPageView({ page, pins }: { page: MineCollectionsPage; pins: LibraryPinsRead }) {
  const readable = useOperation('collection.get');
  const canPin = useOperation('library_pin.put') && pins.state === 'loaded' && pins.canUpdate !== false;
  return (
    <div className="min-w-0 max-w-7xl space-y-6 text-foreground">
      <LibraryNavigation
        current="collections"
        pins={pins}
        collections={page.navigationCollections ?? page.collections}
      />
      <article className="min-w-0 space-y-8">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <PageHeading>{m.library_collections_heading()}</PageHeading>
          <Exposure operation="collection.create">
            <a href={`/${getLocale()}/collections/new`} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
              {m.library_collection_new()}
            </a>
          </Exposure>
        </header>
        <Exposure operation="library_label.list">
          <a href={`/${getLocale()}/library/labels`} className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            {m.library_labels_heading()}
          </a>
        </Exposure>
        {pins.state === 'loaded' && pins.pins.length ? (
          <section className="space-y-3" aria-labelledby="library-pinned-heading">
            <h2 id="library-pinned-heading" className="text-xl font-semibold">
              {m.library_pin_pinned_section()}
            </h2>
            <ul className="space-y-2">
              {pins.pins.map((pin) => {
                const title =
                  pin.target?.title ?? (pin.target ? m.library_pin_unavailable() : m.library_pin_unavailable());
                return (
                  <li key={pin.collectionId} className="flex min-w-0 items-center gap-2">
                    {pin.target ? (
                      <a
                        href={`/${getLocale()}/collections/${encodeURIComponent(pin.collectionId)}`}
                        className="min-w-0 flex-1 truncate rounded-lg px-3 py-2 underline-offset-4 hover:underline"
                      >
                        {pin.target.membershipKind === 'dynamic'
                          ? dynamicCollectionTitle(
                              {
                                builtinKind: (pin.target.builtinKind ?? 'state') as DynamicBuiltinKind,
                                title: pin.target.title ?? null,
                                ...(pin.target.builtinLabels ? { builtinLabels: pin.target.builtinLabels } : {}),
                              },
                              getLocale(),
                            )
                          : title}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate px-3 py-2 text-muted-foreground">{title}</span>
                    )}
                    <PinControl collectionId={pin.collectionId} pins={pins} mode="list" />
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {page.collections.length ? (
          <CoverGrid
            ratio={sharedRatio(
              page.collections.map((collection) => ({
                id: collection.id,
                title: collectionTitle(collection),
                types: [],
              })),
            )}
          >
            {page.collections.map((collection) => {
              const title = collectionTitle(collection);
              return (
                <CoverCard
                  key={collection.id}
                  {...(readable ? { href: `/${getLocale()}/collections/${encodeURIComponent(collection.id)}` } : {})}
                  title={title}
                  cover={{ subject: { id: collection.id, title, types: [] }, cover: null, src: coverSrc }}
                  {...(collection.membershipKind === 'dynamic'
                    ? {}
                    : {
                        ...(collection.memberCount === undefined
                          ? {}
                          : { secondary: m.library_collection_item_count({ count: collection.memberCount }) }),
                        ...(collection.visibility === undefined
                          ? {}
                          : { state: visibilityLabel(collection.visibility) }),
                      })}
                  {...(canPin
                    ? { menuTrigger: <PinControl collectionId={collection.id} pins={pins} mode="collection" /> }
                    : {})}
                />
              );
            })}
          </CoverGrid>
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
