import { pickLanguage } from '@rezics/composition';

const ALIAS_DISPLAY_CAP = 3;

/**
 * The aliases a search row shows: `pickLanguage` over languages that already hold names, native
 * order inside that language, and at most three names. Search hits do not carry original language.
 */
export function pickResultAliases(
  aliases: Record<string, string[]> | undefined,
  locale: string,
): { language: string; aliases: string[] } | undefined {
  const language = pickLanguage(
    Object.keys(aliases ?? {}).filter((tag) => aliases?.[tag]?.length),
    locale,
  );
  if (language === undefined) return undefined;
  const chosen = aliases?.[language]?.slice(0, ALIAS_DISPLAY_CAP);
  return chosen?.length ? { language, aliases: chosen } : undefined;
}
