import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

const count = <const Pattern extends string>(one: Pattern, other: Pattern = one) =>
  plural({ one: insert(one), other: insert(other) }, { count: asValue(number()) });

/** Counts are whole messages: each locale places the number and inflects the noun. */
export const browseCounts = defineMessages({
  en: {
    results: count('{{count}} result', '{{count}} results'),
    atLeastResults: count('At least {{count}} result', 'At least {{count}} results'),
    usage: count('{{count}} work', '{{count}} works'),
  },
  'zh-Hant': {
    results: count('{{count}} 項結果'), atLeastResults: count('至少 {{count}} 項結果'), usage: count('{{count}} 部作品'),
  },
  'zh-Hans': {
    results: count('{{count}} 项结果'), atLeastResults: count('至少 {{count}} 项结果'), usage: count('{{count}} 部作品'),
  },
  ja: {
    results: count('{{count}} 件の結果'), atLeastResults: count('少なくとも {{count}} 件の結果'), usage: count('{{count}} 作品'),
  },
  ko: {
    results: count('결과 {{count}}개'), atLeastResults: count('결과 최소 {{count}}개'), usage: count('작품 {{count}}개'),
  },
  de: {
    results: count('{{count}} Ergebnis', '{{count}} Ergebnisse'),
    atLeastResults: count('Mindestens {{count}} Ergebnis', 'Mindestens {{count}} Ergebnisse'),
    usage: count('{{count}} Werk', '{{count}} Werke'),
  },
  fr: {
    results: count('{{count}} résultat', '{{count}} résultats'),
    atLeastResults: count('Au moins {{count}} résultat', 'Au moins {{count}} résultats'),
    usage: count('{{count}} œuvre', '{{count}} œuvres'),
  },
  es: {
    results: count('{{count}} resultado', '{{count}} resultados'),
    atLeastResults: count('Al menos {{count}} resultado', 'Al menos {{count}} resultados'),
    usage: count('{{count}} obra', '{{count}} obras'),
  },
});
