/** A bounded, independently selected field. The original is a language tag, not a second string. */
export interface LocalizedText { original: string; labels: Record<string, string> }
export interface DisplayName { value: string; language: string; direction: 'ltr' | 'rtl';
  basis: 'requested' | 'fallback' }

const rtl = new Set(['ar', 'arc', 'ckb', 'dv', 'fa', 'he', 'ks', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);
const tag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

export function canonicalLanguage(value: string): string | null {
  if (!tag.test(value)) return null;
  try { return Intl.getCanonicalLocales(value)[0] ?? null; } catch { return null; }
}

export function direction(language: string): 'ltr' | 'rtl' {
  return rtl.has(language.split('-')[0]!.toLowerCase()) ? 'rtl' : 'ltr';
}

export function validLocalizedText(value: LocalizedText, maxLength: number): boolean {
  if (!value || typeof value !== 'object' || !value.labels || typeof value.labels !== 'object'
    || Array.isArray(value.labels) || typeof value.original !== 'string') return false;
  const labels = Object.entries(value.labels);
  return labels.length >= 1 && labels.length <= 20
    && canonicalLanguage(value.original) === value.original && value.original in value.labels
    && labels.every(([language, text]) => canonicalLanguage(language) === language
      && typeof text === 'string' && !!text.trim() && text.length <= maxLength
      && !/[\u0000-\u001f\u007f]/u.test(text));
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

function script(value: string): string | null {
  try { return new Intl.Locale(value).maximize().script ?? null; } catch { return null; }
}

/** Exact tag, language plus script, then primary language for each reader preference. */
export function selectDisplayName(field: LocalizedText | ReadonlyMap<string, string>,
  requested: readonly string[] = []): DisplayName | null {
  const original = 'labels' in field ? field.original : null;
  const source = 'labels' in field ? Object.entries(field.labels) : [...field];
  const labels = source.flatMap(([language, value]) => {
    const canonical = canonicalLanguage(language);
    return canonical && value ? [{ language: canonical, value }] : [];
  });
  for (const preference of requested) {
    const language = canonicalLanguage(preference);
    if (!language) continue;
    const primary = language.split('-')[0];
    const selected = labels.find(row => row.language === language)
      ?? labels.find(row => row.language.split('-')[0] === primary && script(row.language) === script(language))
      ?? labels.find(row => row.language.split('-')[0] === primary);
    if (selected) return { ...selected, direction: direction(selected.language), basis: 'requested' };
  }
  const selected = labels.find(row => row.language === canonicalLanguage(original ?? ''))
    ?? labels.find(row => row.language === 'en') ?? labels[0];
  return selected ? { ...selected, direction: direction(selected.language), basis: 'fallback' } : null;
}

export function legacyLocalizedText(labels: { en: string; 'zh-CN': string }): LocalizedText {
  return { original: 'en', labels: { en: labels.en, 'zh-Hans': labels['zh-CN'] } };
}
