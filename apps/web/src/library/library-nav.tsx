import { Menu } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { Fragment, type ReactNode } from 'react';
import { builtinCollectionDestinations, type BuiltinCollectionRecord } from './builtin-collections';
import type { LibraryPinsRead } from './pins-read';
import { dynamicCollectionTitle } from './dynamic-collection';

export type LibraryDestination = 'tracked' | 'collections' | { collectionId: string };

type Entry = {
  id: string;
  label: string;
  href?: string;
  current: boolean;
  pin?: { collectionId: string; available: boolean };
};

function entryHref(locale: string, destination: string): string {
  return `/${locale}${destination}`;
}

function isCurrent(current: LibraryDestination, destination: 'tracked' | 'collections' | string): boolean {
  if (destination === 'tracked') return current === 'tracked';
  if (destination === 'collections') return current === 'collections';
  return typeof current === 'object' && current.collectionId === destination;
}

function destinations(
  current: LibraryDestination,
  pins: LibraryPinsRead,
  collections: readonly BuiltinCollectionRecord[],
  locale: string,
): Entry[] {
  const builtins = builtinCollectionDestinations(collections, locale);
  const builtinIds = new Set(builtins.map((item) => item.id));
  const output: Entry[] = [
    {
      id: 'collections',
      label: m.library_nav_collections(),
      href: entryHref(locale, '/library/collections'),
      current: isCurrent(current, 'collections'),
    },
    {
      id: 'tracked',
      label: m.library_state_all(),
      href: entryHref(locale, '/library'),
      current: isCurrent(current, 'tracked'),
    },
    {
      id: 'continue',
      label: m.library_continue(),
      href: entryHref(locale, '/library/continue'),
      current: false,
    },
    ...builtins.map((item) => ({
      id: item.id,
      label: item.title,
      href: entryHref(locale, `/collections/${encodeURIComponent(item.id)}`),
      current: isCurrent(current, item.id),
    })),
  ];
  if (pins.state === 'loaded') {
    for (const pin of pins.pins.slice(0, 8)) {
      if (builtinIds.has(pin.collectionId)) continue;
      if (typeof current === 'object' && current.collectionId === pin.collectionId) continue;
      const available = pin.target !== null;
      const title = pin.target
        ? (pin.target.title ??
          (pin.target.membershipKind === 'dynamic'
            ? dynamicCollectionTitle(
                {
                  builtinKind: pin.target.builtinKind ?? 'state',
                  title: null,
                  ...(pin.target.builtinLabels ? { builtinLabels: pin.target.builtinLabels } : {}),
                },
                locale,
              )
            : m.library_pin_unavailable()))
        : m.library_pin_unavailable();
      output.push({
        id: pin.collectionId,
        label: title,
        ...(available ? { href: entryHref(locale, `/collections/${encodeURIComponent(pin.collectionId)}`) } : {}),
        current: isCurrent(current, pin.collectionId),
        pin: { collectionId: pin.collectionId, available },
      });
    }
  }
  return output;
}

function DestinationLink({ entry, children }: { entry: Entry; children?: ReactNode }) {
  const className =
    'min-w-0 truncate rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground aria-[current=page]:font-semibold aria-[current=page]:text-foreground';
  return entry.href ? (
    <a
      href={entry.href}
      aria-current={entry.current ? 'page' : undefined}
      data-library-pin={entry.pin?.collectionId}
      className={className}
    >
      {entry.label}
      {children}
    </a>
  ) : (
    <span
      aria-current={entry.current ? 'page' : undefined}
      data-library-pin={entry.pin?.collectionId}
      className={`${className} cursor-default text-muted-foreground`}
    >
      {entry.label}
      {children}
    </span>
  );
}

/** The bounded Collection destinations shared by Library and Collection pages. */
export function LibraryNavigation({
  current,
  pins,
  collections,
  locale = getLocale(),
}: {
  current: LibraryDestination;
  pins: LibraryPinsRead;
  collections: readonly BuiltinCollectionRecord[];
  locale?: string;
}) {
  const entries = destinations(current, pins, collections, locale);
  const pinned = entries.filter((entry) => entry.pin !== undefined);
  const visiblePins = pinned.slice(0, 3);
  const desktopEntries = entries.filter((entry) => !entry.pin || pinned.indexOf(entry) < 8);
  return (
    <div data-library-navigation className="min-w-0 space-y-2">
      <nav
        data-library-navigation-desktop
        aria-label={m.library_nav_sidebar_label()}
        className="hidden min-w-0 flex-wrap items-center gap-1 lg:flex"
      >
        {desktopEntries.map((entry, index) => (
          <Fragment key={entry.id}>
            {entry.pin && index > 0 && !desktopEntries[index - 1]!.pin ? (
              <span className="px-2 text-xs font-medium text-muted-foreground">{m.library_pin_pinned_section()}</span>
            ) : null}
            <DestinationLink entry={entry} />
          </Fragment>
        ))}
      </nav>
      <div data-library-navigation-phone className="flex min-w-0 flex-wrap items-center gap-1 lg:hidden">
        <Menu
          title={m.library_nav_selector()}
          trigger={
            <Button aria-label={m.library_nav_selector()} variant="outline" className="max-w-full">
              <span className="max-w-[62vw] truncate">{m.library_navigation()}</span>
            </Button>
          }
          entries={entries.map((entry) =>
            entry.href
              ? { type: 'link' as const, label: entry.label, href: entry.href, current: entry.current }
              : {
                  type: 'item' as const,
                  label: entry.label,
                  disabled: true,
                  current: entry.current,
                  onSelect: () => {},
                },
          )}
        />
        {visiblePins.map((entry) => (
          <DestinationLink key={entry.id} entry={entry} />
        ))}
      </div>
      {pins.state === 'unavailable' ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.library_pin_read_failed()}
        </p>
      ) : null}
    </div>
  );
}
