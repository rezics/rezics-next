import { direction } from '@rezics/main/language';
import type { EntityPickerItem, EntityPickerLoad } from '@rezics/ui/entity-picker';
import type { ConceptChoice, ListPage, ResourceCard } from './api.ts';
import { topicItem, type TopicItem } from './topic-picker.tsx';

export const browseId = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const name = (value: string, language = 'en') => ({
  value,
  language,
  direction: direction(language, value),
  basis: 'requested' as const,
});
export const browseConcepts: ConceptChoice[] = Array.from({ length: 2400 }, (_, index) => ({
  id: browseId(index + 1),
  name: name(index === 0 ? '宇宙 · Space' : `Topic ${index + 1}`, index === 0 ? 'zh-Hans' : 'en'),
  broader: [{ id: browseId(9000), name: name('Arts and science') }],
  usageCount: 10000 - index,
  followed: index < 3,
}));
const kinds: ResourceCard['kind'][] = ['work', 'realm', 'site', 'agent', 'collection', 'concept'];
export const browseResources: ResourceCard[] = Array.from({ length: 2400 }, (_, index) => ({
  id: browseId(index + 3000),
  kind: kinds[index % kinds.length]!,
  types: [],
  name: name(
    index === 0 ? '雨夜の図書館 · A library on a rainy night' : `Resource ${index + 1}`,
    index === 0 ? 'ja' : 'en',
  ),
  icon: {
    kind: 'fallback',
    policy: 'avatar-fallback-v1',
    key: String(index),
    resourceType: kinds[index % kinds.length]!,
  },
}));
export function fixturePage<T>(items: readonly T[], offset = 0, size = 20): ListPage<T> {
  const end = Math.min(offset + size, items.length),
    complete = end === items.length;
  return {
    items: items.slice(offset, end),
    nextCursor: complete ? null : String(end),
    complete,
    count: { value: end, kind: complete ? 'exact' : 'at-least' },
  };
}
export function fixtureTopicLoader(
  options: { slow?: boolean; fail?: boolean } = {},
): EntityPickerLoad<TopicItem> {
  return fixtureListLoader(browseConcepts.map(topicItem), options);
}
export function fixtureListLoader<T extends EntityPickerItem>(
  items: readonly T[],
  options: { slow?: boolean; fail?: boolean } = {},
): EntityPickerLoad<T> {
  let failed = false;
  return async ({ q, cursor }) => {
    if (options.slow) await new Promise((resolve) => setTimeout(resolve, 700));
    if (options.fail && !failed) {
      failed = true;
      throw new Error('Fixture unavailable');
    }
    return fixturePage(
      items.filter((item) => item.label.toLowerCase().includes(q.toLowerCase())),
      Number(cursor ?? 0),
    );
  };
}
