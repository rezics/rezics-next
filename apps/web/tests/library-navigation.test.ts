import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LibraryNavigation,
  LibraryNavigationNotice,
  libraryNavigationEntries,
  libraryNavigationMenuEntries,
  type LibraryDestination,
} from '../src/library/library-nav';
import type { BuiltinCollectionRecord } from '../src/library/builtin-collections';
import type { LibraryPin, LibraryPinsRead } from '../src/library/pins-read';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import collectionRecording from '../src/kernel/recorded/library-collection.json';
import { libraryNavigation } from '../src/library/navigation';

test('My ratings has one signed-in Library navigation contribution in every locale', () => {
  const entries = libraryNavigation.filter((entry) => entry.id === 'library.own-ratings');
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  expect(entry).toMatchObject({
    href: '/library/ratings',
    group: 'personal',
    match: 'exact',
    signedIn: true,
    operation: 'rating.own_votes_page',
  });
  if (typeof entry.label !== 'function') throw new Error('My ratings label must follow the current locale');
  for (const locale of locales) expect(entry.label({ locale, pathname: '/library/ratings' })).toBeTruthy();
});

function expectSelectorName(navigation: string, visibleTitle: string): string[] {
  const button = navigation.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0];
  expect(button).toBeDefined();
  const labelIds = button!.match(/aria-labelledby="([^"]+)"/)?.[1]?.split(' ');
  expect(labelIds).toHaveLength(2);
  expect(button).toContain(
    renderToStaticMarkup(createElement('span', { id: labelIds![0], className: 'truncate' }, visibleTitle)),
  );
  expect(button).toContain(
    renderToStaticMarkup(createElement('span', { id: labelIds![1], className: 'sr-only' }, m.library_nav_selector())),
  );
  return labelIds!;
}

test('Collection outer page keeps a visible reachable All Collections destination with nine pins at390 without hiding unknown or unavailable pins', () => {
  // The CollectionsNinePins story checks the open selector's visibility at the review viewport.
  // Here, cover native targets in each responsive group, including a partial signed pin page.
  for (const unavailableIndex of [0, 3, 8]) {
    const pins: LibraryPinsRead = {
      state: 'loaded',
      revision: 17,
      next: 'signed-next-page',
      pins: Array.from({ length: 9 }, (_, index): LibraryPin => ({
        collectionId: `collection-${index}`,
        target:
          index === unavailableIndex
            ? null
            : index === 7
              ? { id: `collection-${index}`, title: null, membershipKind: 'dynamic', builtinKind: 'unknown' }
              : { id: `collection-${index}`, title: `Collection ${index}`, membershipKind: 'curated' },
      })),
    };
    const before = structuredClone(pins);
    const { tabs, overflow } = libraryNavigationEntries('collections', pins, [], 'en');
    const pinEntries = [...tabs, ...overflow].filter((entry) => entry.pin);

    expect(tabs.filter((entry) => entry.pin)).toHaveLength(8);
    expect(overflow.filter((entry) => entry.pin)).toHaveLength(1);
    expect(pinEntries.map((entry) => entry.id)).toEqual(pins.pins.map((pin) => pin.collectionId));
    expect(pinEntries[unavailableIndex]).toMatchObject({
      label: m.library_pin_unavailable(),
      pin: { available: false },
    });
    expect(pinEntries[unavailableIndex]!.href).toBeUndefined();
    expect(pinEntries[7]).toMatchObject({
      label: m.library_other(),
      href: '/en/collections/collection-7',
      pin: { available: true },
    });
    expect(tabs.filter((entry) => entry.id === 'collections')).toEqual([
      {
        id: 'collections',
        label: m.library_nav_all_collections(),
        href: '/en/library/collections',
        current: true,
      },
    ]);
    expect(pins).toEqual(before);

    const html = renderToStaticMarkup(
      createElement(LibraryNavigation, { current: 'collections', pins, collections: [], locale: 'en' }),
    );
    const phone = html.match(/<nav\b[^>]*data-library-navigation-phone[\s\S]*?<\/nav>/)?.[0];
    expect(phone).toBeDefined();
    expect(phone!.match(/data-library-pin=/g)).toHaveLength(3);
    expectSelectorName(phone!, m.library_nav_all_collections());
    expect(phone).toContain(m.library_nav_all_collections());
    expect(html).not.toContain(`href="/en/collections/collection-${unavailableIndex}"`);
  }
});

test('Shared Library selector accessible name includes actual selected visible title without losing navigation focus or private pin semantics', () => {
  const previousLocale = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const collection = collectionRecording.collection;
      const cases: { current: LibraryDestination; collections: BuiltinCollectionRecord[]; title: string }[] = [
        { current: 'tracked', collections: [], title: m.library_nav_tracked_entries() },
        { current: 'continue', collections: [], title: m.library_continue() },
        { current: 'collections', collections: [], title: m.library_nav_all_collections() },
        { current: { collectionId: collection.id }, collections: [collection], title: collection.title },
        {
          current: { collectionId: 'liked' },
          collections: [{ id: 'liked', title: null, membershipKind: 'dynamic', builtinKind: 'liked' }],
          title: m.library_dynamic_liked(),
        },
        { current: { collectionId: 'missing' }, collections: [], title: m.library_more() },
      ];
      for (const { current, collections, title } of cases) {
        const html = renderToStaticMarkup(
          createElement(LibraryNavigation, { current, collections, locale, pins: { state: 'closed' } }),
        );
        const phone = html.match(/<nav\b[^>]*data-library-navigation-phone[\s\S]*?<\/nav>/)?.[0];
        expect(phone).toBeDefined();
        expectSelectorName(phone!, title);
      }
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});

test('selected overflow and unavailable pins retain actual titles, current destinations and distinct selector labels', () => {
  const collection = collectionRecording.collection;
  const pins: LibraryPinsRead = {
    state: 'loaded',
    revision: 17,
    next: 'signed-next-page',
    pins: [
      { collectionId: 'unavailable', target: null },
      ...Array.from({ length: 7 }, (_, index): LibraryPin => ({
        collectionId: `pin-${index}`,
        target: { id: `pin-${index}`, title: `Reading list ${index}`, membershipKind: 'curated' },
      })),
      { collectionId: collection.id, target: collection },
    ],
  };
  const before = structuredClone(pins);
  for (const [collectionId, title] of [
    [collection.id, collection.title],
    ['unavailable', m.library_pin_unavailable()],
  ] as const) {
    const current = { collectionId };
    const html = renderToStaticMarkup(
      createElement(LibraryNavigation, { current, pins, collections: [], locale: 'en' }),
    );
    const desktop = html.match(/<nav\b[^>]*data-library-navigation-desktop[\s\S]*?<\/nav>/)?.[0];
    const phone = html.match(/<nav\b[^>]*data-library-navigation-phone[\s\S]*?<\/nav>/)?.[0];
    expect(desktop).toBeDefined();
    expect(phone).toBeDefined();
    const labelIds = [...expectSelectorName(desktop!, m.library_more()), ...expectSelectorName(phone!, title)];
    expect(new Set(labelIds).size).toBe(4);
    const { tabs, overflow } = libraryNavigationEntries(current, pins, [], 'en');
    const selected = [...tabs, ...overflow].filter((entry) => entry.current);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ id: collectionId, label: title });
    expect(selected[0]!.href).toBe(
      collectionId === 'unavailable' ? undefined : `/en/collections/${encodeURIComponent(collectionId)}`,
    );
    expect(html).not.toContain('href="/en/collections/unavailable"');
    expect(pins).toEqual(before);
  }
});

test('Collection overflow keeps every real Library destination and unavailable pin without adding a mutation', () => {
  const previousLocale = getLocale();
  const pins: LibraryPinsRead = {
    state: 'loaded',
    revision: 17,
    next: 'signed-next-page',
    pins: [
      { collectionId: 'unavailable', target: null },
      ...Array.from({ length: 9 }, (_, index): LibraryPin => ({
        collectionId: `pin-${index}`,
        target: { id: `pin-${index}`, title: `Reading list ${index}`, membershipKind: 'curated' },
      })),
    ],
  };
  const collections: BuiltinCollectionRecord[] = [
    collectionRecording.collection,
    { id: 'liked', title: null, membershipKind: 'dynamic', builtinKind: 'liked' },
  ];
  const before = structuredClone({ pins, collections });
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const current = { collectionId: collectionRecording.collection.id };
      const { tabs, overflow } = libraryNavigationEntries(current, pins, collections, locale);
      const entries = libraryNavigationMenuEntries(current, pins, collections, locale);
      const links = entries.filter((entry) => entry.type === 'link');
      const expected = [...tabs, ...overflow].filter((entry) => entry.href);
      expect(links).toHaveLength(expected.length + 2);
      for (const entry of expected)
        expect(links).toContainEqual({ type: 'link', label: entry.label, href: entry.href, current: entry.current });
      expect(links.filter((entry) => entry.current)).toEqual([
        {
          type: 'link',
          label: collectionRecording.collection.title,
          href: `/${locale}/collections/${collectionRecording.collection.id}`,
          current: true,
        },
      ]);
      expect(links.map((entry) => entry.href)).toContain(`/${locale}/library/logs`);
      expect(links.map((entry) => entry.href)).toContain(`/${locale}/library/follow-counts`);
      expect(entries.filter((entry) => entry.type !== 'link')).toEqual([
        {
          type: 'item',
          label: m.library_pin_unavailable(),
          disabled: true,
          current: false,
          onSelect: expect.any(Function),
        },
      ]);
      expect(
        renderToStaticMarkup(createElement(LibraryNavigationNotice, { pins: { state: 'unavailable' } })),
      ).toContain(m.library_pin_read_failed());
      expect(renderToStaticMarkup(createElement(LibraryNavigationNotice, { pins: { state: 'preparing' } }))).toContain(
        m.library_navigation_loading(),
      );
    }
    expect({ pins, collections }).toEqual(before);
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});
