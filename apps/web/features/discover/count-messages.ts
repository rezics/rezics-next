import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

const count = <const Pattern extends string>(one: Pattern, other: Pattern = one) =>
  plural({ one: insert(one), other: insert(other) }, { count: asValue(number()) });

/** Counts are whole messages: each locale places the number and inflects the noun. */
export const browseCounts = defineMessages({
  en: {
    credits: count('{{count}} author credit', '{{count}} author credits'), atLeastCredits: count('At least {{count}} author credit', 'At least {{count}} author credits'),
    results: count('{{count}} result', '{{count}} results'),
    atLeastResults: count('At least {{count}} result', 'At least {{count}} results'),
    usage: count('{{count}} work', '{{count}} works'),
  },
  'zh-Hant': {
    credits: count('{{count}} 筆作者署名'), atLeastCredits: count('至少 {{count}} 筆作者署名'),
    results: count('{{count}} 項結果'), atLeastResults: count('至少 {{count}} 項結果'), usage: count('{{count}} 部作品'),
  },
  'zh-Hans': {
    credits: count('{{count}} 条作者署名'), atLeastCredits: count('至少 {{count}} 条作者署名'),
    results: count('{{count}} 项结果'), atLeastResults: count('至少 {{count}} 项结果'), usage: count('{{count}} 部作品'),
  },
  ja: {
    credits: count('著者クレジット {{count}} 件'), atLeastCredits: count('著者クレジットは少なくとも {{count}} 件'),
    results: count('{{count}} 件の結果'), atLeastResults: count('少なくとも {{count}} 件の結果'), usage: count('{{count}} 作品'),
  },
  ko: {
    credits: count('저자 크레딧 {{count}}개'), atLeastCredits: count('저자 크레딧 최소 {{count}}개'),
    results: count('결과 {{count}}개'), atLeastResults: count('결과 최소 {{count}}개'), usage: count('작품 {{count}}개'),
  },
  de: {
    credits: count('{{count}} Autorenangabe', '{{count}} Autorenangaben'), atLeastCredits: count('Mindestens {{count}} Autorenangabe', 'Mindestens {{count}} Autorenangaben'),
    results: count('{{count}} Ergebnis', '{{count}} Ergebnisse'),
    atLeastResults: count('Mindestens {{count}} Ergebnis', 'Mindestens {{count}} Ergebnisse'),
    usage: count('{{count}} Werk', '{{count}} Werke'),
  },
  fr: {
    credits: count('{{count}} crédit d’auteur', '{{count}} crédits d’auteur'), atLeastCredits: count('Au moins {{count}} crédit d’auteur', 'Au moins {{count}} crédits d’auteur'),
    results: count('{{count}} résultat', '{{count}} résultats'),
    atLeastResults: count('Au moins {{count}} résultat', 'Au moins {{count}} résultats'),
    usage: count('{{count}} œuvre', '{{count}} œuvres'),
  },
  es: {
    credits: count('{{count}} crédito de autor', '{{count}} créditos de autor'), atLeastCredits: count('Al menos {{count}} crédito de autor', 'Al menos {{count}} créditos de autor'),
    results: count('{{count}} resultado', '{{count}} resultados'),
    atLeastResults: count('Al menos {{count}} resultado', 'Al menos {{count}} resultados'),
    usage: count('{{count}} obra', '{{count}} obras'),
  },
});
