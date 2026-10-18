import { textStats } from '@rezics/ui/editor';

// Scripts written without spaces between words. Their writers measure a
// manuscript in characters (中文“字数”, 日本語「文字数」); a word count there
// is a segmenter's guess. Korean separates words with spaces and counts them.
const unspaced = new Set(['zh', 'ja', 'yue', 'wuu', 'lzh', 'hak', 'nan', 'cmn', 'gan', 'hsn']);

export interface ManuscriptLength { unit: 'characters' | 'words'; value: number }

/** The unit a language's writers count a manuscript in. */
export const lengthUnit = (language: string): ManuscriptLength['unit'] =>
  unspaced.has(language.split('-')[0]!.toLowerCase()) ? 'characters' : 'words';

/**
 * How long a manuscript is, as writers of its language count it: characters
 * (without spaces and line breaks) for Chinese and Japanese, words elsewhere.
 */
export function manuscriptLength(text: string, language: string): ManuscriptLength {
  if (lengthUnit(language) === 'characters') {
    let value = 0;
    for (const { segment } of new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(text)) {
      if (!/^\s+$/u.test(segment)) value += 1;
    }
    return { unit: 'characters', value };
  }
  return { unit: 'words', value: textStats(text, language).words };
}
