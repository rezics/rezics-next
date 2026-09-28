import { createHash } from 'node:crypto';
import type { FixtureSource } from './wikidata.ts';

/** UTF-8 editions, with their complete chapter counts (including Frankenstein's letters). */
export const gutenbergBooks = [
  { id: 'pride', edition: 1342, sections: 61 },
  { id: 'alice', edition: 11, sections: 12 },
  { id: 'frankenstein', edition: 84, sections: 28 },
  { id: 'jane-eyre', edition: 1260, sections: 38 },
  { id: 'sherlock', edition: 1661, sections: 12 },
  { id: 'little-women', edition: 514, sections: 47 },
  { id: 'secret-garden', edition: 113, sections: 27 },
] as const;
export type GutenbergBook = (typeof gutenbergBooks)[number];
export interface GutenbergText { edition: number; sourceSha256: string; text: string }

export const gutenbergUrl = (edition: number) =>
  `https://www.gutenberg.org/cache/epub/${edition}/pg${edition}.txt`;

/** Policy 1.C: distribute the unrestricted text without the trademark or license wrapper.
 * Source attribution belongs in provenance, not in the book's text.
 * https://www.gutenberg.org/policy/license.html */
export function stripGutenbergWrapper(raw: string): string {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const start = /^\*\*\* START OF THE PROJECT GUTENBERG EBOOK .+ \*\*\*$/gm;
  const end = /^\*\*\* END OF THE PROJECT GUTENBERG EBOOK .+ \*\*\*$/gm;
  const starts = [...normalized.matchAll(start)], ends = [...normalized.matchAll(end)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index >= ends[0]!.index) {
    throw new Error('Unrecognized Gutenberg text boundaries');
  }
  const text = normalized.slice(starts[0]!.index + starts[0]![0].length, ends[0]!.index).trim();
  if (!text || /gutenberg|pglaf/i.test(text)) {
    throw new Error('Gutenberg body is empty or still contains trademark text; review the edition');
  }
  return `${text}\n`;
}

export const gutenberg: FixtureSource & { responseFormat: 'text' } = {
  name: 'gutenberg', responseFormat: 'text', minimumIntervalMs: 1000,
  requests: gutenbergBooks.map(book => ({ id: `pg${book.edition}`, url: gutenbergUrl(book.edition) })),
  reuseBasis: 'Public-domain literary text in the United States; UTF-8 editions with the license, header, footer and trademark references removed under section 1.C. Source attribution retained only as provenance. https://www.gutenberg.org/policy/license.html',
  normalize(raw: unknown, id: string): GutenbergText {
    const book = gutenbergBooks.find(item => `pg${item.edition}` === id);
    if (!book || typeof raw !== 'string') throw new Error(`Malformed Gutenberg ${id}`);
    return { edition: book.edition, sourceSha256: createHash('sha256').update(raw).digest('hex'),
      text: stripGutenbergWrapper(raw) };
  },
};
