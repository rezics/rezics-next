import { expect, test } from 'bun:test';
import { createNavigation, resolveNavigation } from './navigation';

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
