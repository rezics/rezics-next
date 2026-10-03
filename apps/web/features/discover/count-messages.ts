import { asValue, insert, number, plural } from 'native-i18n';
import { defineMessages } from '../../i18n/define.ts';

const count = <const Pattern extends string>(one: Pattern, other: Pattern = one) =>
  plural({ one: insert(one), other: insert(other) }, { count: asValue(number()) });

/** Counts are whole messages: each locale places the number and inflects the noun. */
export const browseCounts = defineMessages({
  en: {
    moreCredits: count('+{{count}} more'), atLeastMoreCredits: count('At least {{count}} more'),
    credits: count('{{count}} author credit', '{{count}} author credits'), atLeastCredits: count('At least {{count}} author credit', 'At least {{count}} author credits'),
    results: count('{{count}} result', '{{count}} results'),
    atLeastResults: count('At least {{count}} result', 'At least {{count}} results'),
    usage: count('{{count}} work', '{{count}} works'),
  },
  'zh-Hant': {
    moreCredits: count('另有 {{count}} 筆署名'), atLeastMoreCredits: count('至少另有 {{count}} 筆署名'),
    credits: count('{{count}} 筆作者署名'), atLeastCredits: count('至少 {{count}} 筆作者署名'),
    results: count('{{count}} 項結果'), atLeastResults: count('至少 {{count}} 項結果'), usage: count('{{count}} 部作品'),
  },
  'zh-Hans': {
    moreCredits: count('另有 {{count}} 条署名'), atLeastMoreCredits: count('至少另有 {{count}} 条署名'),
    credits: count('{{count}} 条作者署名'), atLeastCredits: count('至少 {{count}} 条作者署名'),
    results: count('{{count}} 项结果'), atLeastResults: count('至少 {{count}} 项结果'), usage: count('{{count}} 部作品'),
  },
  ja: {
    moreCredits: count('ほか {{count}} 件'), atLeastMoreCredits: count('ほか少なくとも {{count}} 件'),
    credits: count('著者クレジット {{count}} 件'), atLeastCredits: count('著者クレジットは少なくとも {{count}} 件'),
    results: count('{{count}} 件の結果'), atLeastResults: count('少なくとも {{count}} 件の結果'), usage: count('{{count}} 作品'),
  },
  ko: {
    moreCredits: count('그 외 {{count}}개'), atLeastMoreCredits: count('그 외 최소 {{count}}개'),
    credits: count('저자 크레딧 {{count}}개'), atLeastCredits: count('저자 크레딧 최소 {{count}}개'),
    results: count('결과 {{count}}개'), atLeastResults: count('결과 최소 {{count}}개'), usage: count('작품 {{count}}개'),
  },
  de: {
    moreCredits: count('+{{count}} weitere'), atLeastMoreCredits: count('Mindestens {{count}} weitere'),
    credits: count('{{count}} Autorenangabe', '{{count}} Autorenangaben'), atLeastCredits: count('Mindestens {{count}} Autorenangabe', 'Mindestens {{count}} Autorenangaben'),
    results: count('{{count}} Ergebnis', '{{count}} Ergebnisse'),
    atLeastResults: count('Mindestens {{count}} Ergebnis', 'Mindestens {{count}} Ergebnisse'),
    usage: count('{{count}} Werk', '{{count}} Werke'),
  },
  fr: {
    moreCredits: count('+{{count}} autre', '+{{count}} autres'), atLeastMoreCredits: count('Au moins {{count}} autre', 'Au moins {{count}} autres'),
    credits: count('{{count}} crédit d’auteur', '{{count}} crédits d’auteur'), atLeastCredits: count('Au moins {{count}} crédit d’auteur', 'Au moins {{count}} crédits d’auteur'),
    results: count('{{count}} résultat', '{{count}} résultats'),
    atLeastResults: count('Au moins {{count}} résultat', 'Au moins {{count}} résultats'),
    usage: count('{{count}} œuvre', '{{count}} œuvres'),
  },
  es: {
    moreCredits: count('+{{count}} más'), atLeastMoreCredits: count('Al menos {{count}} más'),
    credits: count('{{count}} crédito de autor', '{{count}} créditos de autor'), atLeastCredits: count('Al menos {{count}} crédito de autor', 'Al menos {{count}} créditos de autor'),
    results: count('{{count}} resultado', '{{count}} resultados'),
    atLeastResults: count('Al menos {{count}} resultado', 'Al menos {{count}} resultados'),
    usage: count('{{count}} obra', '{{count}} obras'),
  },
});
