import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { Button } from '@rezics/ui/shadcn/button';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useId } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { builtinCollectionDestinations, type BuiltinCollectionRecord } from './builtin-collections';
import type { LibraryPinsRead } from './pins-read';
import { dynamicCollectionTitle } from './dynamic-collection';

export type LibraryDestination =
  | 'tracked'
  | 'continue'
  | 'collections'
  | 'follow-counts'
  | 'logs'
  | 'goals'
  | { collectionId: string };
export type LibraryNavigationEntry = {
  id: string;
  label: string;
  href?: string;
  current: boolean;
  pin?: { collectionId: string; available: boolean };
};
type CollectionsState = 'loaded' | 'preparing' | 'denied' | 'unavailable' | 'error';

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
    {
      id: 'goals',
      label: m.library_yearly_goal_title(),
      href: `/${locale}/library/goals`,
      current: current === 'goals',
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
    'inline-flex min-h-11 min-w-11 max-w-48 shrink-0 items-center rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground';
  return entry.href ? (
    <a
      href={entry.href}
      title={entry.label}
      aria-current={entry.current ? 'page' : undefined}
      data-library-pin={entry.pin?.collectionId}
      className={className}
    >
      <span className="truncate">{entry.label}</span>
    </a>
  ) : (
    <span
      title={entry.label}
      aria-current={entry.current ? 'page' : undefined}
      data-library-pin={entry.pin?.collectionId}
      className={`${className} cursor-default`}
    >
      <span className="truncate">{entry.label}</span>
    </span>
  );
}

function destinationMenuEntries(entries: readonly LibraryNavigationEntry[]): MenuEntry[] {
  return entries.map((entry) =>
    entry.href
      ? { type: 'link', label: entry.label, href: entry.href, current: entry.current }
      : { type: 'item', label: entry.label, disabled: true, current: entry.current, onSelect: () => {} },
  );
}

/** Supplied identities stay readable even when the one-row shortcuts have to clip their labels. */
function DestinationList({ entries }: { entries: readonly LibraryNavigationEntry[] }) {
  return (
    <ul data-library-destinations className="m-0 min-w-0 max-w-full list-none space-y-1 p-1">
      {entries.map((entry) => (
        <ListRow
          key={entry.id}
          data-library-destination={entry.id}
          data-library-pin={entry.pin?.collectionId}
          className="min-h-13 min-w-0 p-1 aria-[current=page]:bg-muted"
          aria-current={entry.current && !entry.href ? 'page' : undefined}
        >
          <div
            aria-hidden={entry.href ? true : undefined}
            className={`flex min-h-11 min-w-11 items-start gap-3 rounded-lg px-3 py-3 text-sm leading-5 ${entry.current ? 'bg-muted font-semibold' : ''} ${entry.href ? '' : 'text-muted-foreground'}`}
          >
            <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]">{entry.label}</span>
            {entry.current ? <CheckIcon aria-hidden="true" className="size-5 shrink-0" /> : null}
          </div>
          {entry.href ? (
            <ListRowLink
              href={entry.href}
              aria-current={entry.current ? 'page' : undefined}
              className="min-h-11 min-w-11"
            >
              {entry.label}
            </ListRowLink>
          ) : null}
        </ListRow>
      ))}
    </ul>
  );
}

function managementDestinations(current: LibraryDestination, locale: string): LibraryNavigationEntry[] {
  return [
    {
      id: 'logs',
      label: m.library_my_logs_heading(),
      href: `/${locale}/library/logs`,
      current: current === 'logs',
    },
    {
      id: 'follow-counts',
      label: m.library_follow_counts_heading(),
      href: `/${locale}/library/follow-counts`,
      current: current === 'follow-counts',
    },
  ];
}

/** The same destinations for a page's overflow menu, without a second selected-title trigger. */
export function libraryNavigationMenuEntries(
  current: LibraryDestination,
  pins: LibraryPinsRead,
  collections: readonly BuiltinCollectionRecord[],
  locale = getLocale(),
): MenuEntry[] {
  const { tabs, overflow } = libraryNavigationEntries(current, pins, collections, locale);
  return destinationMenuEntries([...tabs, ...managementDestinations(current, locale), ...overflow]);
}

function DestinationMenu({
  entries,
  current,
}: {
  entries: readonly LibraryNavigationEntry[];
  current?: string | undefined;
}) {
  const titleId = useId();
  const purposeId = useId();
  return (
    <Menu
      title={m.library_nav_selector()}
      content={<DestinationList entries={entries} />}
      closeOnNavigation
      trigger={
        <Button
          aria-label={m.library_nav_selector()}
          aria-labelledby={`${titleId} ${purposeId}`}
          variant="outline"
          className="min-h-11 min-w-11 max-w-48 shrink-0"
        >
          <span id={titleId} className="truncate">
            {current ?? m.library_more()}
          </span>
          <span id={purposeId} className="sr-only">
            {m.library_nav_selector()}
          </span>
          <ChevronDownIcon aria-hidden="true" />
        </Button>
      }
    />
  );
}

/** One navigation row and one complete responsive reading/selection surface at either viewport. */
export function LibraryNavigation({
  current,
  pins,
  collections,
  locale = getLocale(),
  collectionsState = 'loaded',
  showCollectionsNotice = true,
}: {
  current: LibraryDestination;
  pins: LibraryPinsRead;
  collections: readonly BuiltinCollectionRecord[];
  locale?: string;
  collectionsState?: CollectionsState;
  /** A leaf page can explain its own Collection read while retaining independent pin notices. */
  showCollectionsNotice?: boolean;
}) {
  const destinations = libraryNavigationEntries(current, pins, collections, locale);
  const overflow = destinations.overflow;
  // Management destinations are additive to the existing Collection and pin model.
  const tabs: LibraryNavigationEntry[] = [...destinations.tabs, ...managementDestinations(current, locale)];
  const all = [...tabs, ...overflow];
  const phonePins = tabs.filter((entry) => entry.pin).slice(0, 3);
  return (
    <div data-library-navigation data-collections-state={collectionsState} className="min-w-0 space-y-2">
      <nav
        aria-label={m.library_nav_sidebar_label()}
        className="flex min-w-0 items-center gap-1"
      >
        <div
          data-library-navigation-desktop
          className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 lg:flex"
        >
          {tabs.map((entry) => (
            <DestinationLink key={entry.id} entry={entry} />
          ))}
        </div>
        <div
          data-library-navigation-phone
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 lg:hidden"
        >
          {phonePins.map((entry) => (
            <DestinationLink key={entry.id} entry={entry} />
          ))}
        </div>
        <DestinationMenu entries={all} current={all.find((entry) => entry.current)?.label} />
      </nav>
      <LibraryNavigationNotice
        pins={pins}
        collectionsState={collectionsState}
        showCollectionsNotice={showCollectionsNotice}
      />
    </div>
  );
}

export function LibraryNavigationNotice({
  pins,
  collectionsState = 'loaded',
  showCollectionsNotice = true,
}: {
  pins: LibraryPinsRead;
  collectionsState?: CollectionsState;
  showCollectionsNotice?: boolean;
}) {
  const collectionsUnavailable =
    showCollectionsNotice &&
    (collectionsState === 'unavailable' || collectionsState === 'denied' || collectionsState === 'error');
  const platformClosed = pins.state === 'closed' && pins.platformClosed === true;
  const pinNotice =
    pins.state === 'unavailable'
      ? m.library_pin_read_failed()
      : pins.state === 'denied'
        ? m.library_pin_denied()
        : platformClosed
          ? m.library_subject_closed()
          : undefined;
  const collectionsNotice = collectionsUnavailable
    ? collectionsState === 'denied'
      ? m.library_collections_denied()
      : m.library_collections_unavailable()
    : undefined;
  const notice = pinNotice ?? collectionsNotice;
  return notice ? (
    <p role="status" className="text-sm text-muted-foreground">
      {notice}
    </p>
  ) : pins.state === 'preparing' || (showCollectionsNotice && collectionsState === 'preparing') ? (
    <p role="status" className="text-sm text-muted-foreground">
      {m.library_navigation_loading()}
    </p>
  ) : null;
}
