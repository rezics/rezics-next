export interface NameTranslation { language: string; name: string; description: string }

const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
function canonicalLanguage(value: string): string | null {
  if (!languageTag.test(value)) return null;
  try { return Intl.getCanonicalLocales(value)[0] ?? null; } catch { return null; }
}

/** Author's original and independently optional description translations. */
export function communityNames(original: string, name: string, description: string,
  translations: readonly NameTranslation[]) {
  const language = canonicalLanguage(original.trim());
  if (!language || !name.trim() || !description.trim() || translations.length > 19) return null;
  const names: Record<string, string> = { [language]: name.trim() };
  const descriptions: Record<string, string> = { [language]: description.trim() };
  for (const translation of translations) {
    const tag = canonicalLanguage(translation.language.trim());
    if (!tag || tag in names || !translation.name.trim()) return null;
    names[tag] = translation.name.trim();
    if (translation.description.trim()) descriptions[tag] = translation.description.trim();
  }
  return { name: { original: language, labels: names },
    description: { original: language, labels: descriptions } };
}
