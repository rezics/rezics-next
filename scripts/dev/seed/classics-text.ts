import { readLockedFixture } from '../../fixtures/pull.ts';
import { gutenbergBooks, type GutenbergBook, type GutenbergText } from '../../../tests/fixtures/sources/gutenberg.ts';

export interface ClassicChapter { title: string; body: string; kind: 'chapter' | 'letter' }

const roman = (value: string) => {
  const digits: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  return [...value].reduce((n, digit, index) => n + (digits[digit]! < (digits[value[index + 1]!] ?? 0)
    ? -digits[digit]! : digits[digit]!), 0);
};
const words = ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN',
  'NINETEEN', 'TWENTY'];
const wordNumber = (word: string) => {
  const exact = words.indexOf(word);
  if (exact >= 0) return exact + 1;
  const [tens, units] = word.split('-');
  return ({ TWENTY: 20, THIRTY: 30, FORTY: 40 }[tens!] ?? 0)
    + (units ? words.indexOf(units) + 1 : 0);
};

function withoutIllustrations(body: string): string {
  // Captions may contain nested [copyright] notices. A first-']' regex leaves debris in the prose.
  const markers = /\[Illustration(?=[:\]])/g;
  let cursor = 0, result = '';
  for (let marker = markers.exec(body); marker; marker = markers.exec(body)) {
    result += body.slice(cursor, marker.index);
    let depth = 0;
    let end = marker.index;
    for (; end < body.length; end++) {
      if (body[end] === '[') depth++;
      if (body[end] === ']' && --depth === 0) break;
    }
    if (depth !== 0) throw new Error('Unterminated illustration caption');
    cursor = end + 1;
    markers.lastIndex = cursor;
  }
  return result + body.slice(cursor);
}

/** Content stores one paragraph per line. Preserve intentionally indented verse, but unwrap printed prose. */
export function classicParagraphs(body: string): string {
  return body.trim().split(/\n\s*\n/).map(block => {
    const lines = block.split('\n');
    return lines.some(line => /^ {2,}\S/.test(line))
      ? lines.map(line => line.trim()).join('\n')
      : lines.map(line => line.trim()).join(' ');
  }).join('\n');
}

/** Anchored edition-specific headings exclude indented contents and Holmes's internal I./II./III. */
export function splitClassic(book: GutenbergBook, text: string): ClassicChapter[] {
  const patterns: Record<GutenbergBook['id'], RegExp> = {
    pride: /^(?:CHAPTER|Chapter) ([IVXL]+)\.?\]?$/gm,
    alice: /^CHAPTER ([IVX]+)\.\n([^\n]+)$/gm,
    frankenstein: /^(Letter|Chapter) (\d+)$/gm,
    'jane-eyre': /^CHAPTER ([IVXL]+)(?:—CONCLUSION)?$/gm,
    sherlock: /^([IVX]+)\. ([A-Z][^\n]+)$/gm,
    'little-women': /^CHAPTER ([A-Z-]+)\n([^\n]+)$/gm,
    'secret-garden': /^CHAPTER ([IVX]+)\.?\n([^\n]+)$/gm,
  };
  const headings = [...text.matchAll(patterns[book.id])];
  if (headings.length !== book.sections) throw new Error(`${book.id}: expected ${book.sections} sections, got ${headings.length}`);
  return headings.map((heading, index) => {
    const letter = book.id === 'frankenstein' && heading[1] === 'Letter';
    const number = book.id === 'frankenstein' ? Number(heading[2])
      : book.id === 'little-women' ? wordNumber(heading[1]!) : roman(heading[1]!);
    const expected = book.id === 'frankenstein' && !letter ? index - 3 : index + 1;
    if (number !== expected) throw new Error(`${book.id}: section ${index + 1} is out of order`);
    const subtitle = ['alice', 'little-women', 'secret-garden', 'sherlock'].includes(book.id) ? heading[2] : null;
    const title = book.id === 'sherlock' ? `${number}. ${subtitle}`
      : `${letter ? 'Letter' : 'Chapter'} ${number}${subtitle ? `: ${subtitle}` : ''}`;
    // Omit illustration placeholders, never prose, from a text-only edition.
    const body = classicParagraphs(withoutIllustrations(text.slice(heading.index + heading[0].length,
      headings[index + 1]?.index ?? text.length)));
    if (body.length < 500) throw new Error(`${book.id}: empty or truncated ${title}`);
    return { title, body, kind: letter ? 'letter' : 'chapter' };
  });
}

// Full books stay locked offline; the demo publishes a bounded opening sample to leave room for the other seed steps.
export const CLASSIC_CHAPTER_LIMIT = 3;
/** Pride and Prejudice was published in three volumes (1813); the sample opens each of them. */
const PRIDE_VOLUMES = [{ title: 'Volume I', first: 1, last: 23 }, { title: 'Volume II', first: 24, last: 42 },
  { title: 'Volume III', first: 43, last: 61 }] as const;
const chapterNumber = (chapter: ClassicChapter) => Number(/^Chapter (\d+)/.exec(chapter.title)?.[1] ?? 0);

/** How a classic's sample is divided: Pride and Prejudice into its volumes, Frankenstein's letters into a part. */
export function classicGroups(book: GutenbergBook['id'], chapters: readonly ClassicChapter[]):
  Array<{ title: string; division: 'volume' | 'part'; chapters: number[] }> {
  const indexes = (keep: (chapter: ClassicChapter) => boolean) => chapters.flatMap((chapter, index) =>
    keep(chapter) ? [index] : []);
  if (book === 'pride') {
    return PRIDE_VOLUMES.map(volume => ({ title: volume.title, division: 'volume' as const,
      chapters: indexes(chapter => chapterNumber(chapter) >= volume.first && chapterNumber(chapter) <= volume.last) }));
  }
  if (book === 'frankenstein') {
    return [{ title: 'Letters', division: 'part', chapters: indexes(chapter => chapter.kind === 'letter') }];
  }
  return [];
}
export function classicText(root: string, book: GutenbergBook) {
  const fixture = readLockedFixture(root, 'gutenberg', `pg${book.edition}`) as GutenbergText;
  if (fixture.edition !== book.edition || !/^[a-f0-9]{64}$/.test(fixture.sourceSha256)) {
    throw new Error(`Invalid locked edition for ${book.id}`);
  }
  const all = splitClassic(book, fixture.text);
  const chapters = all.filter((chapter, index) => chapter.kind === 'letter'
    || index < CLASSIC_CHAPTER_LIMIT + (book.id === 'frankenstein' ? 4 : 0)
    || book.id === 'pride' && PRIDE_VOLUMES.some(volume => volume.first === index + 1));
  if (chapters.some(chapter => chapter.body.length > 65_536)) {
    throw new Error(`${book.id}: a sample chapter exceeds the Content text budget`);
  }
  return { fixture, chapters, totalSections: all.length };
}

export const classicTextPlan = (root: string) => gutenbergBooks.map(book => ({ book, ...classicText(root, book) }));
