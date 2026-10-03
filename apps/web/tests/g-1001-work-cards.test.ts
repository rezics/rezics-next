import { expect, test } from 'bun:test';
import { resourceWork } from '../features/discover/resource-card.tsx';
import { browseId } from '../features/discover/browse-fixtures.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import type { ResourceCard } from '../features/discover/api.ts';
import { resourceHref } from '../features/address/path.ts';

test('G1001: the shared Work tile receives authors, links, the honest credit total and Global rating', () => {
  seedServedTypes();
  const item: ResourceCard = { id: browseId(1), kind: 'work', types: ['https://schema.org/Book'],
    name: { value: 'Rain', language: 'en', direction: 'ltr', basis: 'requested' },
    icon: { kind: 'fallback', key: 'rain', policy: 'avatar-fallback-v1', resourceType: 'work' },
    work: { primaryCredits: [{ id: browseId(2), role: 'author', participantKind: 'agent', agent: browseId(3),
      provider: null, key: null, ordinal: null, displayName: 'Lin Mei', handle: 'lin-mei' }],
      creditCount: { value: 3, kind: 'at-least' }, rating: { context: browseId(9), count: 2, sum: 9,
        mean: 4.5, scale: { min: 1, max: 5 } } } };
  const card = resourceWork(item, { kind: 'realm', realm: browseId(8).slice(-36) }, 'en');
  expect(card.authors).toEqual([{ name: 'Lin Mei',
    href: resourceHref('/a/', { prefix: '/@', key: 'lin-mei', suffixSource: '' }) }]);
  expect(card.creditSummary).toBe('At least 2 more');
  expect(card.rating).toEqual({ mean: 4.5, count: 2, max: 5 });
  expect(card.href).toContain('scope=realm');
  expect(resourceWork(item, { kind: 'global' }, 'zh-Hans').creditSummary).toBe('至少另有 2 条署名');
});
