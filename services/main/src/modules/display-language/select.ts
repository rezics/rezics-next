import { canonicalLanguage, direction, languageMatch, parseLanguage } from './tag.ts';
export { canonicalLanguage, direction, languageSatisfies, parseLanguage } from './tag.ts';
export type { LanguageTag, LanguageMatch } from './tag.ts';

/** An independently selected field. The original is a language tag, not a second string. */
export interface LocalizedText { original: string; labels: Record<string, string> }
export const DISPLAY_LANGUAGE_BASES = ['requested', 'same-script', 'other-script', 'fallback'] as const;
export interface DisplayName { value: string; language: string; direction: 'ltr' | 'rtl';
  basis: (typeof DISPLAY_LANGUAGE_BASES)[number] }

export const LOCALIZED_TEXT_MAX_BYTES = 64 * 1024;

/** Cardinality is unrestricted; callers may supply their smaller UTF-8 payload budget. */
export function validLocalizedText(value: LocalizedText, maxLength: number,
  maxBytes = LOCALIZED_TEXT_MAX_BYTES): boolean {
  if (!value || typeof value !== 'object' || !value.labels || typeof value.labels !== 'object'
    || Array.isArray(value.labels) || typeof value.original !== 'string') return false;
  const labels = Object.entries(value.labels);
  return labels.length >= 1
    && canonicalLanguage(value.original) === value.original && Object.hasOwn(value.labels, value.original)
    && labels.every(([language, text]) => canonicalLanguage(language) === language
      && language !== 'mul'
      && typeof text === 'string' && !!text.trim() && text.length <= maxLength
      && !/[\u0000-\u001f\u007f]/u.test(text))
    && new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
}

/** Query languages retain caller order; a header uses quality, then header order. */
export function readerLanguages(languages?: string | null, acceptLanguage?: string | null): string[] {
  const raw = languages ? languages.split(',').map(value => value.trim())
    : (acceptLanguage ?? '').split(',').map((part, index) => {
      const [value, parameter] = part.trim().split(';');
      const quality = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameter?.trim() ?? '');
      return { value: value ?? '', quality: parameter ? Number(quality?.[1] ?? 0) : 1, index };
    }).filter(part => part.quality > 0).sort((a, b) => b.quality - a.quality || a.index - b.index)
      .map(part => part.value);
  return [...new Set(raw.map(canonicalLanguage).filter((value): value is string => !!value))].slice(0, 20);
}

/** Respect reader order among exact/same-script matches before any other-script fallback. */
export function selectDisplayName(field: LocalizedText | ReadonlyMap<string, string>,
  requested: readonly string[] = []): DisplayName | null {
  const original = 'labels' in field ? field.original : null;
  const source = 'labels' in field ? Object.entries(field.labels) : [...field];
  const labels = source.flatMap(([language, value]) => {
    const parsed = parseLanguage(language);
    return (parsed || language === '') && value ? [{ language: parsed?.tag ?? '', value, parsed }] : [];
  });
  let otherScript: (typeof labels)[number] | undefined;
  for (const preference of requested) {
    const language = parseLanguage(preference);
    if (!language) continue;
    const exact = labels.find(row => row.parsed && languageMatch(row.parsed, language) === 'requested');
    const selected = exact
      ?? labels.find(row => row.parsed && languageMatch(row.parsed, language) === 'same-script');
    if (selected) return { value: selected.value, language: selected.language,
      direction: direction(selected.language), basis: exact ? 'requested' : 'same-script' };
    otherScript ??= labels.find(row => row.parsed && languageMatch(row.parsed, language) === 'other-script');
  }
  const selected = otherScript ?? labels.find(row => row.language === (canonicalLanguage(original ?? '') ?? original))
    ?? labels[0];
  return selected ? { value: selected.value, language: selected.language,
    direction: direction(selected.language), basis: otherScript ? 'other-script' : 'fallback' } : null;
}

export function legacyLocalizedText(labels: { en: string; 'zh-CN': string }): LocalizedText {
  return { original: 'en', labels: { en: labels.en, 'zh-Hans': labels['zh-CN'] } };
}
