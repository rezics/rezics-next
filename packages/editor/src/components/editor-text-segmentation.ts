export const unspacedScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

export function wordSegmenter(locale?: string): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  try {
    return new Intl.Segmenter(locale, { granularity: 'word' });
  } catch {
    return new Intl.Segmenter(undefined, { granularity: 'word' });
  }
}
