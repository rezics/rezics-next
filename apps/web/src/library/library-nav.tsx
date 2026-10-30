import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { ChevronDownIcon } from 'lucide-react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { builtinCollectionDestinations, type BuiltinCollectionRecord } from './builtin-collections';
import type { LibraryPinsRead } from './pins-read';
import { dynamicCollectionTitle } from './dynamic-collection';

export type LibraryDestination = 'tracked' | 'continue' | 'collections' | 'follow-counts' | { collectionId: string };
export type LibraryNavigationEntry = {
  id: string;
  label: string;
  href?: string;
  current: boolean;
  pin?: { collectionId: string; available: boolean };
};

/** Only returned Collection identities become destinations. Pins retain their native order, including hidden targets. */
export function libraryNavigationEntries(
  current: LibraryDestination,
  pins: LibraryPinsRead,
  collections: readonly BuiltinCollectionRecord[],
  locale: string,
): { tabs: LibraryNavigationEntry[]; overflow: LibraryNavigationEntry[] } {
  const seen = new Set<string>();
  const tabs: LibraryNavigationEntry[] = [];
  const overflow: LibraryNavigationEntry[] = [];
  const collectionEntry = (collection: BuiltinCollectionRecord): LibraryNavigationEntry => ({
    id: collection.id,
    label:
      collection.title ??
      (collection.membershipKind === 'dynamic' && collection.builtinKind
        ? dynamicCollectionTitle({ ...collection, builtinKind: collection.builtinKind }, locale)
        : m.library_pin_unavailable()),
    href: `/${locale}/collections/${encodeURIComponent(collection.id)}`,
    current: typeof current === 'object' && current.collectionId === collection.id,
  });
  if (pins.state === 'loaded') {
    for (const pin of pins.pins) {
      if (seen.has(pin.collectionId)) continue;
      seen.add(pin.collectionId);
      (tabs.length < 8 ? tabs : overflow).push({
        ...(pin.target
          ? collectionEntry(pin.target)
          : {
              id: pin.collectionId,
              label: m.library_pin_unavailable(),
              current: typeof current === 'object' && current.collectionId === pin.collectionId,
            }),
        pin: { collectionId: pin.collectionId, available: pin.target !== null },
      });
    }
  }
  for (const builtin of builtinCollectionDestinations(collections, locale)) {
    if (seen.has(builtin.id)) continue;
    seen.add(builtin.id);
    tabs.push({
      id: builtin.id,
      label: builtin.title,
      href: `/${locale}/collections/${encodeURIComponent(builtin.id)}`,
      current: typeof current === 'object' && current.collectionId === builtin.id,
    });
  }
  for (const collection of collections) {
    if (seen.has(collection.id) || collection.membershipKind !== 'dynamic' || collection.builtinKind !== 'state')
      continue;
    seen.add(collection.id);
    tabs.push(collectionEntry(collection));
  }
  tabs.push(
    {
      id: 'tracked',
      label: m.library_nav_tracked_entries(),
      href: `/${locale}/library`,
      current: current === 'tracked',
    },
    {
      id: 'continue',
      label: m.library_continue(),
      href: `/${locale}/library/continue`,
      current: current === 'continue',
    },
    {
      id: 'collections',
      label: m.library_nav_all_collections(),
      href: `/${locale}/library/collections`,
      current: current === 'collections',
    },
  );
  for (const collection of collections) {
    if (seen.has(collection.id)) continue;
    seen.add(collection.id);
    overflow.push(collectionEntry(collection));
  }
  return { tabs, overflow };
}

function DestinationLink({ entry }: { entry: LibraryNavigationEntry }) {
  const className =
    'min-w-0 max-w-48 shrink-0 truncate rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground';
  return entry.href ? (
    <a
      href={entry.href}
      title={entry.label}
      aria-current={entry.current ? 'page' : undefined}
      data-library-pin={entry.pin?.collectionId}
      className={className}
    >
      {entry.label}
    </a>
  ) : (
    <span
      title={entry.label}
      aria-current={entry.current ? 'page' : undefined}
      data-library-pin={entry.pin?.collectionId}
      className={`${className} cursor-default`}
    >
      {entry.label}
    </span>
  );
}

function DestinationMenu({
  entries,
  current,
}: {
  entries: readonly LibraryNavigationEntry[];
  current?: string | undefined;
}) {
  const menuEntries: MenuEntry[] = entries.map((entry) =>
    entry.href
      ? { type: 'link', label: entry.label, href: entry.href, current: entry.current }
      : { type: 'item', label: entry.label, disabled: true, current: entry.current, onSelect: () => {} },
  );
  return (
    <Menu
      title={m.library_nav_selector()}
      entries={menuEntries}
      trigger={
        <Button aria-label={m.library_nav_selector()} variant="outline" className="min-w-0 max-w-48 shrink-0">
          <span className="truncate">{current ?? m.library_more()}</span>
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      }
    />
  );
}

/** One nonwrapping navigation row at either viewport, with the remaining real Collections in a responsive Menu. */
export function LibraryNavigation({
  current,
  pins,
  collections,
  locale = getLocale(),
  collectionsState = 'loaded',
}: {
  current: LibraryDestination;
  pins: LibraryPinsRead;
  collections: readonly BuiltinCollectionRecord[];
  locale?: string;
  collectionsState?: 'loaded' | 'preparing' | 'unavailable';
}) {
  const destinations = libraryNavigationEntries(current, pins, collections, locale);
  const overflow = destinations.overflow;
  // Management destinations are additive to the existing Collection and pin model.
  const tabs: LibraryNavigationEntry[] = [
    ...destinations.tabs,
    {
      id: 'follow-counts',
      label: m.library_follow_counts_heading(),
      href: `/${locale}/library/follow-counts`,
      current: current === 'follow-counts',
    },
  ];
  const all = [...tabs, ...overflow];
  const phonePins = tabs.filter((entry) => entry.pin).slice(0, 3);
  return (
    <div data-library-navigation className="min-w-0 space-y-2">
      <nav
        data-library-navigation-desktop
        aria-label={m.library_nav_sidebar_label()}
        className="hidden min-w-0 items-center gap-1 lg:flex"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((entry) => (
            <DestinationLink key={entry.id} entry={entry} />
          ))}
        </div>
        {overflow.length ? <DestinationMenu entries={overflow} /> : null}
      </nav>
      <nav
        data-library-navigation-phone
        aria-label={m.library_nav_sidebar_label()}
        className="flex min-w-0 items-center gap-1 lg:hidden"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {phonePins.map((entry) => (
            <DestinationLink key={entry.id} entry={entry} />
          ))}
        </div>
        <DestinationMenu entries={all} current={all.find((entry) => entry.current)?.label} />
      </nav>
      {pins.state === 'unavailable' || collectionsState === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {pins.state === 'unavailable' ? m.library_pin_read_failed() : m.library_collections_unavailable()}
        </p>
      ) : pins.state === 'preparing' || collectionsState === 'preparing' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_navigation_loading()}
        </p>
      ) : null}
    </div>
  );
}
