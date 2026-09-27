import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';

/** The content language an interface locale reads: zh-CN readers read Simplified Chinese. */
export const localeLanguage = (locale: UiLocale) => (locale === 'zh-CN' ? 'zh-Hans' : locale);

/** A BCP 47 tag's name in the interface language ("zh-Hant" → "繁体中文"), or the tag itself. */
export function languageName(tag: string, locale: UiLocale): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language', fallback: 'code' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

export const formatNumber = (value: number, locale: UiLocale, digits = 0) =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

export const formatShare = (part: number, whole: number, locale: UiLocale) =>
  new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(whole ? part / whole : 0);

// Main's Work semantic types (`WORK_SEMANTIC_TYPES` in services/main/src/modules/work/activate.ts).
const typeLabels = {
  'https://schema.org/Book': 'book',
  'https://schema.org/DigitalDocument': 'digitalDocument',
  'https://schema.org/Recipe': 'recipe',
} as const satisfies Record<string, keyof WorkPageMessages>;

/** Labels for the types the interface knows; an unknown type is left out rather than shown as an IRI. */
export function typeNames(types: readonly string[], t: Pick<WorkPageMessages, (typeof typeLabels)[keyof typeof typeLabels]>) {
  return types.flatMap(type => type in typeLabels ? [t[typeLabels[type as keyof typeof typeLabels]]] : []);
}
