import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LibraryNavigation, libraryNavigationEntries } from '../src/library/library-nav';
import type { LibraryPin, LibraryPinsRead } from '../src/library/pins-read';
import { m } from '../src/paraglide/messages.js';

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
    expect(phone).toContain(`aria-label="${m.library_nav_selector()}"`);
    expect(phone).toContain(m.library_nav_all_collections());
    expect(html).not.toContain(`href="/en/collections/collection-${unavailableIndex}"`);
  }
});
