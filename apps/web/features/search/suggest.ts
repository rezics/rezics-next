import type { MainClient } from '../discover/types.ts';

// Spelling-tolerant suggestions for a search that found nothing. Main matches
// titles and names exactly (by substring) and by prefix for typeahead, so the
// page asks the typeahead for a short prefix of the phrase and keeps the
// candidates within a small edit distance of what was typed.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
export type TypeaheadPage = Ok<MainClient['v1']['search']['typeahead']['get']>;
export type TypeaheadItem = TypeaheadPage['items'][number];

const wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Text as the comparison sees it: NFC, lower case, punctuation as single spaces. */
export const foldText = (text: string) =>
  text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** CJK text is typed without spaces, so one character is a meaningful prefix; Latin needs two. */
export const isWideText = (text: string) => wide.test(text);

/**
 * Prefixes worth asking the typeahead for, at most two: the first character
 * of CJK text; otherwise the longest word's first three and first two letters,
 * so a slip in the third letter still finds the word.
 */
export function suggestionPrefixes(phrase: string): string[] {
  const folded = foldText(phrase);
  if (!folded) return [];
  if (isWideText(folded)) return [[...folded][0]!];
  const longest = folded.split(' ').reduce((best, word) => ([...word].length > [...best].length ? word : best), '');
  const letters = [...longest];
  if (letters.length < 3) return [];
  return [...new Set([letters.slice(0, 3).join(''), letters.slice(0, 2).join('')])];
}

/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent swaps each cost one. */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const rows = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 },
    (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i += 1) {
    for (let j = 1; j <= y.length; j += 1) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[x.length]![y.length]!;
}

/**
 * How far the phrase is from the closest same-length run of the candidate,
 * starting at a word (or, for CJK, any character). A phrase that is a slip
 * of part of a title ("prejudise" in "Pride and Prejudice") scores low.
 */
export function closeness(phrase: string, candidate: string): number {
  const typed = foldText(phrase);
  const text = foldText(candidate);
  const length = [...typed].length;
  if (!length || !text) return Number.POSITIVE_INFINITY;
  const characters = [...text];
  const starts = isWideText(typed) ? characters.map((_, index) => index)
    : characters.flatMap((character, index) => (index === 0 || characters[index - 1] === ' ') && character !== ' '
      ? [index] : []);
  let best = Number.POSITIVE_INFINITY;
  for (const start of starts) {
    // Compare runs a character shorter and longer too, so a dropped or doubled letter counts once.
    for (const span of [length - 1, length, length + 1]) {
      if (span < 1 || start + span > characters.length + 1) continue;
      best = Math.min(best, editDistance(typed, characters.slice(start, start + span).join('').trim()));
    }
  }
  return best;
}

/** The most distance a suggestion may be from the phrase: one slip per four letters, one for CJK. */
export function tolerance(phrase: string): number {
  const typed = foldText(phrase);
  const length = [...typed.replace(/ /g, '')].length;
  if (isWideText(typed)) return length >= 2 ? 1 : 0;
  return length < 3 ? 0 : Math.max(1, Math.floor(length / 4));
}

export type Suggestion =
  | { kind: 'work'; item: TypeaheadItem }
  /** A credited name that matched; it leads to a search for that name. */
  | { kind: 'name'; name: string; language: string | null };

/**
 * Close titles and names for a phrase, nearest first, one per Work and name.
 * A candidate the phrase already contains exactly is kept: a filter or the
 * scope hid it, and it is still what the reader meant.
 */
export function nearMatches(phrase: string, items: readonly TypeaheadItem[], limit = 3): Suggestion[] {
  const allowed = tolerance(phrase);
  const scored = items.flatMap(item => {
    const distance = Math.min(closeness(phrase, item.matchedText), closeness(phrase, item.title.value));
    return distance <= allowed ? [{ item, distance }] : [];
  }).sort((a, b) => a.distance - b.distance);
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const { item } of scored) {
    const key = item.matchedField === 'credit' ? `name:${foldText(item.matchedText)}` : item.work;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(item.matchedField === 'credit'
      ? { kind: 'name', name: item.matchedText, language: item.matchedLanguage } : { kind: 'work', item });
    if (suggestions.length === limit) break;
  }
  return suggestions;
}
