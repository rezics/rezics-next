import { PublicQueryUnavailable } from './search-budget.ts';

/** Bounded search candidates may contain several selected languages. Preserve
 * the Main Version result grain with its strongest matching text, then a stable
 * unit tie-break; never merge two heads for the same normalized language.
 * Cost: O(C log C) time and O(C) memory within the caller's phrase hit bound. */
export function mainSearchMatches<T extends { mainVersion: string; language: string;
  matchUnit: string; score: number }>(matches: T[]): T[] {
  const languages = new Set<string>();
  for (const match of matches) {
    const key = `${match.mainVersion}\0${match.language.toLowerCase()}`;
    if (languages.has(key)) throw new PublicQueryUnavailable('Main language search heads are ambiguous');
    languages.add(key);
  }
  const seen = new Set<string>();
  return [...matches].sort((a, b) => b.score - a.score
    || a.mainVersion.localeCompare(b.mainVersion) || a.matchUnit.localeCompare(b.matchUnit))
    .filter(match => {
      if (seen.has(match.mainVersion)) return false;
      seen.add(match.mainVersion);
      return true;
    });
}
