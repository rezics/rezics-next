const languageCode = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/;

/** A language's name in this page's locale; unsupported codes have no guessed label. */
export function pageLanguageName(code: string, locale: string): string | undefined {
  if (!languageCode.test(code)) return undefined;
  try {
    return new Intl.DisplayNames([locale], { type: 'language', fallback: 'none' }).of(code) ?? undefined;
  } catch {
    return undefined;
  }
}
