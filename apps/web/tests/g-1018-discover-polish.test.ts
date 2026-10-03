import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { browseResources } from '../features/discover/browse-fixtures.ts';
import { browseCounts } from '../features/discover/count-messages.ts';
import { resourceWork } from '../features/discover/resource-card.tsx';
import type { ResourceCard } from '../features/discover/api.ts';
import { uiLocales } from '../i18n/define.ts';

const item = browseResources[0]!;
const credit = {
  id: browseResources[1]!.id,
  role: 'author',
  participantKind: 'external-reference',
  provider: 'open-library',
  key: 'OL21594A',
  ordinal: 1,
  agent: null,
  handle: null,
} as const;
function work(value: number, kind: 'exact' | 'at-least', names: (string | null)[]): ResourceCard {
  return {
    ...item,
    work: {
      ...item.work!,
      creditCount: { value, kind },
      primaryCredits: names.map((displayName) => ({ ...credit, displayName })),
    },
  };
}

test('G1018: credit summaries count only beyond displayed author names, retaining lower bounds', () => {
  for (const locale of uiLocales) {
    const t = materializeData(browseCounts[locale], { locale });
    for (const kind of ['exact', 'at-least'] as const) {
      expect(resourceWork(work(0, kind, []), undefined, locale).creditSummary).toBeUndefined();
      expect(
        resourceWork(work(1, kind, ['Lin Mei']), undefined, locale).creditSummary,
      ).toBeUndefined();
      expect(
        resourceWork(work(3, kind, ['Lin Mei', 'Austen', 'Mori']), undefined, locale).creditSummary,
      ).toBeUndefined();
      const card = resourceWork(work(3, kind, ['Lin Mei', null, '']), undefined, locale);
      expect(card.authors).toHaveLength(1);
      expect(card.creditSummary).toBe(
        kind === 'exact' ? t.moreCredits(2) : t.atLeastMoreCredits(2),
      );
      expect(resourceWork(work(2, kind, []), undefined, locale).creditSummary).toBe(
        kind === 'exact' ? t.moreCredits(2) : t.atLeastMoreCredits(2),
      );
    }
    expect(
      resourceWork({ ...item, work: undefined }, undefined, locale).creditSummary,
    ).toBeUndefined();
  }
});

test('G1018: extra credits use whole translated messages and locale plural rules', () => {
  const expected = {
    en: ['+1 more', '+2 more', 'At least 2 more'],
    'zh-Hant': ['另有 1 筆署名', '另有 2 筆署名', '至少另有 2 筆署名'],
    'zh-Hans': ['另有 1 条署名', '另有 2 条署名', '至少另有 2 条署名'],
    ja: ['ほか 1 件', 'ほか 2 件', 'ほか少なくとも 2 件'],
    ko: ['그 외 1개', '그 외 2개', '그 외 최소 2개'],
    de: ['+1 weitere', '+2 weitere', 'Mindestens 2 weitere'],
    fr: ['+1 autre', '+2 autres', 'Au moins 2 autres'],
    es: ['+1 más', '+2 más', 'Al menos 2 más'],
  };
  for (const locale of uiLocales) {
    const t = materializeData(browseCounts[locale], { locale });
    expect([t.moreCredits(1), t.moreCredits(2), t.atLeastMoreCredits(2)]).toEqual(expected[locale]);
  }
});
