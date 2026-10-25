// Not a client module: server components compute initials too.

// Scripts written without spaces, where one character already stands for a name.
const ideographic = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Alphabets whose initials combine. A second letter joins only from the same one,
// so "Daniel Chen 陈丹尼" is DC and "Daniel 陈丹尼" is D, never D陈.
const alphabets = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Hebrew', 'Arabic', 'Devanagari', 'Thai']
  .map(script => new RegExp(`^\\p{Script=${script}}`, 'u'));
const alphabetOf = (letter: string) => alphabets.findIndex(pattern => pattern.test(letter));

/** A word's first letter, past any leading punctuation or digits. */
const firstLetter = (word: string) => word.match(/\p{L}/u)?.[0] ?? '';

/**
 * The letters an avatar shows without a picture, the same for a person or an
 * organization wherever it appears. A name that starts in Han, Kana or Hangul
 * shows its first character ("陈丹尼" → 陈, "김민지" → 김); any other shows the
 * first letters of its first two words when both are in one alphabet ("Lin Mei
 * 林梅" → LM, "élodie" → É). "·", "/", "|" and commas separate words.
 */
export function initials(name: string, fallback = '?'): string {
  const words = name.split(/[\s·・,，/|]+/u).filter(word => /\p{L}/u.test(word));
  const first = firstLetter(words[0] ?? '');
  if (!first) return name.match(/\p{N}/u)?.[0] ?? fallback;
  if (ideographic.test(first)) return first;
  const second = firstLetter(words[1] ?? '');
  const alphabet = alphabetOf(first);
  return (alphabet >= 0 && second && alphabetOf(second) === alphabet ? first + second : first).toLocaleUpperCase();
}
