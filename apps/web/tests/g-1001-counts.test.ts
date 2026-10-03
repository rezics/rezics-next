import { expect, test } from 'bun:test';
import { materializeData } from 'native-i18n';
import { browseCounts } from '../features/discover/count-messages.ts';
import { messages as workMessages } from '../features/work-page/messages.ts';
import { uiLocales } from '../i18n/define.ts';

test('G-1001 counts inflect results, topic use and ratings across all eight locales', () => {
  const one = {
    en: ['1 result', '1 work', '1 rating'],
    'zh-Hant': ['1 項結果', '1 部作品', '1 則評分'],
    'zh-Hans': ['1 项结果', '1 部作品', '1 个评分'],
    ja: ['1 件の結果', '1 作品', '1 件の評価'],
    ko: ['결과 1개', '작품 1개', '평점 1개'],
    de: ['1 Ergebnis', '1 Werk', '1 Bewertung'],
    fr: ['1 résultat', '1 œuvre', '1 note'],
    es: ['1 resultado', '1 obra', '1 valoración'],
  };
  const many = {
    en: ['20 results', '20 works', '20 ratings'],
    'zh-Hant': ['20 項結果', '20 部作品', '20 則評分'],
    'zh-Hans': ['20 项结果', '20 部作品', '20 个评分'],
    ja: ['20 件の結果', '20 作品', '20 件の評価'],
    ko: ['결과 20개', '작품 20개', '평점 20개'],
    de: ['20 Ergebnisse', '20 Werke', '20 Bewertungen'],
    fr: ['20 résultats', '20 œuvres', '20 notes'],
    es: ['20 resultados', '20 obras', '20 valoraciones'],
  };
  for (const locale of uiLocales) {
    const counts = materializeData(browseCounts[locale], { locale });
    const work = materializeData(workMessages[locale], { locale });
    expect([counts.results(1), counts.usage(1), work.ratingCount(1)]).toEqual(one[locale]);
    expect([counts.results(20), counts.usage(20), work.ratingCount(20)]).toEqual(many[locale]);
    expect(counts.atLeastResults(20)).toContain('20');
    expect(counts.atLeastResults(20)).not.toBe(counts.results(20));
    expect(counts.results(0)).not.toContain('{{');
  }
});
