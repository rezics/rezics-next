import { expect, test } from 'bun:test';
import { createNavigation, navigationForPlacement, resolveNavigation } from './navigation';

const navigation = createNavigation([
  {
    id: 'community.realms',
    kind: 'navigation',
    group: 'primary',
    order: 30,
    href: '/realms',
    match: 'prefix',
    label: 'Your Realms',
  },
]);

test('localized route prefixes select the intended link only at segment boundaries', () => {
  const realm = resolveNavigation(navigation, { locale: 'ja', pathname: '/ja/realms/example' })[0];
  expect(realm).toMatchObject({
    id: 'community.realms',
    group: 'primary',
    order: 30,
    href: '/ja/realms',
    current: true,
  });

  const neighboringPath = resolveNavigation(navigation, { locale: 'ja', pathname: '/ja/realmstone' })[0];
  expect(neighboringPath?.current).toBe(false);
});

test('global placement admits only essentials and signed-in Library without changing contextual navigation', () => {
  const entries = createNavigation([
    ...[
      'shell.home',
      'books.catalogue',
      'shell.search',
      'shell.library',
      'shell.orders',
      'shell.inbox',
      'library.import',
      'zone.editor',
    ].map((id, order) => ({
      id,
      order,
      kind: 'navigation' as const,
      group: 'primary' as const,
      href: `/${id}` as const,
      label: id,
      signedIn: id === 'shell.library',
    })),
    { id: 'create.post', order: 0, kind: 'creation', group: 'create', href: '/new', label: 'Create' },
  ]);
  expect(navigationForPlacement(entries, 'global-sidebar', 'signed-in').map(({ id }) => id)).toEqual([
    'shell.home',
    'books.catalogue',
    'shell.search',
    'shell.library',
  ]);
  for (const session of ['unknown', 'signed-out', 'unavailable'] as const)
    expect(navigationForPlacement(entries, 'global-sidebar', session).map(({ id }) => id)).toEqual([
      'shell.home',
      'books.catalogue',
      'shell.search',
    ]);
  expect(navigationForPlacement(entries, 'contextual', 'signed-in')).toBe(entries);
  expect(navigationForPlacement(entries, 'account-tools', 'signed-in').map(({ id }) => id)).toEqual([
    'shell.orders',
    'library.import',
    'zone.editor',
  ]);
});
