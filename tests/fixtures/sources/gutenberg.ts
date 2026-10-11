import { createHash } from 'node:crypto';
import type { FixtureRequest, FixtureSource } from './wikidata.ts';

const publicDomain = 'Public domain in the United States.';

/** UTF-8 editions, with their complete chapter counts (including Frankenstein's letters). */
export const gutenbergBooks = [
  { id: 'pride', edition: 1342, title: 'Pride and Prejudice', sections: 61, license: publicDomain },
  { id: 'alice', edition: 11, title: "Alice's Adventures in Wonderland", sections: 12, license: publicDomain },
  { id: 'frankenstein', edition: 84, title: 'Frankenstein', sections: 28, license: publicDomain },
  { id: 'jane-eyre', edition: 1260, title: 'Jane Eyre', sections: 38, license: publicDomain },
  { id: 'sherlock', edition: 1661, title: 'Adventures of Sherlock Holmes', sections: 12, license: publicDomain },
  { id: 'little-women', edition: 514, title: 'Little Women', sections: 47, license: publicDomain },
  { id: 'secret-garden', edition: 113, title: 'The Secret Garden', sections: 27, license: publicDomain },
] as const;
export type GutenbergBook = (typeof gutenbergBooks)[number];

export interface GutenbergText { edition: number; sourceSha256: string; text: string }
export interface GutenbergOutlineHeading {
  heading: string;
  ordinal: number;
  depth: number;
  kind: 'front-matter' | 'volume' | 'book' | 'chapter' | 'act' | 'scene' | 'section';
}
export interface GutenbergOutline {
  edition: number;
  sourceSha256: string;
  outline: GutenbergOutlineHeading[];
}
export interface GutenbergDiaryPart { date: string; body: string }
export interface GutenbergDiary {
  entryCount: number;
  dateRange: { start: string; end: string };
  editions: Array<{ year: number; edition: number; sourceSha256: string }>;
  parts: GutenbergDiaryPart[];
}

export interface GutenbergTextPin {
  id: string;
  edition: number;
  title: string;
  license: string;
  language?: string;
}

export const gutenbergTexts: readonly GutenbergTextPin[] = [
  ...gutenbergBooks.map(({ id, edition, title, license }) => ({ id, edition, title, license })),
  { id: 'divina-commedia', edition: 1000, title: 'La Divina Commedia di Dante: Complete', language: 'it', license: publicDomain },
  { id: 'beautiful-smoker', edition: 5316, title: 'Красавице, которая нюхала табак', language: 'ru', license: publicDomain },
  { id: 'tribute-to-michael-hart', edition: 43007, title: 'Tribute to Michael Hart', language: 'ar', license: publicDomain },
];

export interface GutenbergOutlinePin {
  id: string;
  edition: number;
  title: string;
  /** Count of chapter, scene, or short-section headings retained in the outline. */
  sections: number;
  /** Higher-level headings, such as books, volumes, or acts. */
  divisions: number;
  /** Extra named front-matter headings retained in the outline. */
  frontMatter: number;
  license: string;
  language?: string;
}

export const gutenbergOutlines: readonly GutenbergOutlinePin[] = [
  { id: 'moby-dick', edition: 2701, title: 'Moby Dick', sections: 135, divisions: 0, frontMatter: 2, license: publicDomain },
  { id: 'war-and-peace', edition: 2600, title: 'War and Peace', sections: 365, divisions: 15, frontMatter: 0, license: publicDomain },
  { id: 'les-miserables', edition: 135, title: 'Les Misérables', sections: 365, divisions: 53, frontMatter: 0, license: publicDomain },
  { id: 'hamlet', edition: 1524, title: 'Hamlet', sections: 20, divisions: 5, frontMatter: 0, license: publicDomain },
  { id: 'leaves-of-grass', edition: 1322, title: 'Leaves of Grass', sections: 52, divisions: 0, frontMatter: 0, license: publicDomain },
  { id: 'hong-lou-meng', edition: 24264, title: '紅樓夢', sections: 120, divisions: 0, frontMatter: 0, license: publicDomain, language: 'zh' },
];

export const gutenbergPepys = {
  id: 'pepys-diary',
  entryCount: 1_100,
  editions: [
    { year: 1660, edition: 4125 },
    { year: 1661, edition: 4131 },
    { year: 1662, edition: 4138 },
    { year: 1663, edition: 4145 },
  ],
  license: publicDomain,
} as const;

export const gutenbergUrl = (edition: number) =>
  `https://www.gutenberg.org/cache/epub/${edition}/pg${edition}.txt`;

/** Policy 1.C: distribute the unrestricted text without the trademark or license wrapper.
 * Source attribution belongs in provenance, not in the book's text.
 * https://www.gutenberg.org/policy/license.html */
export function stripGutenbergWrapper(raw: string, options: { removeProjectReferences?: boolean } = {}): string {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const start = /^\*\*\* START OF THE PROJECT GUTENBERG EBOOK .+ \*\*\*$/gm;
  const end = /^\*\*\* END OF THE PROJECT GUTENBERG EBOOK .+ \*\*\*$/gm;
  const starts = [...normalized.matchAll(start)], ends = [...normalized.matchAll(end)];
  if (starts.length !== 1 || ends.length !== 1 || starts[0]!.index >= ends[0]!.index) {
    throw new Error('Unrecognized Gutenberg text boundaries');
  }
  let text = normalized.slice(starts[0]!.index + starts[0]![0].length, ends[0]!.index).trim();
  if (options.removeProjectReferences) {
    text = text
      .replace(/Project Gutenberg(?:™|®)?/giu, 'the project')
      .replace(/\bGutenberg(?:[’']s)?\b/giu, 'the project')
      .replace(/\bPGLAF\b/giu, 'the foundation')
      .replace(/مشروع\s+غوتنبر[غعجگ]/gu, 'المشروع')
      .replace(/مكتبة\s+غوتنبر[غعجگ]/gu, 'المكتبة الرقمية');
  }
  if (!text || /gutenberg|pglaf/i.test(text)) {
    throw new Error('Gutenberg body is empty or still contains trademark text; review the edition');
  }
  return `${text}\n`;
}

const titleKey = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '')
  .normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function checkEditionTitle(raw: string, edition: number, title: string): void {
  const marker = /^\*\*\* START OF THE PROJECT GUTENBERG EBOOK (.+) \*\*\*$/m.exec(raw)?.[1];
  if (!marker || !titleKey(marker).includes(titleKey(title)) || !raw.includes(`[eBook #${edition}]`)) {
    throw new Error(`Gutenberg edition mismatch: pg${edition} is not ${title}`);
  }
}

function checkEditionLanguage(raw: string, edition: number, language: string): void {
  const languageNames: Record<string, string> = { it: 'Italian', ru: 'Russian', ar: 'Arabic' };
  const expected = languageNames[language];
  const actual = /^Language:\s*(.+)$/m.exec(raw)?.[1]?.trim();
  if (!expected || actual !== expected) {
    throw new Error(`Gutenberg edition mismatch: pg${edition} is not ${expected ?? language}`);
  }
}

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
function cleanBody(raw: string, id: string): string {
  try {
    return stripGutenbergWrapper(raw, { removeProjectReferences: true });
  } catch (error) {
    throw new Error(`Gutenberg ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const romanValues: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
function ordinal(value: string): number {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = value.toUpperCase().split('');
  return digits.reduce((sum, digit, index) => {
    const current = romanValues[digit] ?? 0;
    return sum + (current < (romanValues[digits[index + 1]!] ?? 0) ? -current : current);
  }, 0);
}

function lineMatches(text: string, pattern: RegExp) {
  return [...text.matchAll(pattern)].map((match) => ({
    heading: match[0]!.trim(),
    ordinal: ordinal(match[1]!),
    index: match.index!,
  }));
}

function outlineFor(pin: GutenbergOutlinePin, text: string): GutenbergOutlineHeading[] {
  const chapter = (heading: string, value: string, index: number): GutenbergOutlineHeading & { index: number } =>
    ({ heading, ordinal: ordinal(value), depth: 2, kind: 'chapter', index });
  const division = (heading: string, value: string, index: number, kind: 'volume' | 'book' | 'act'): GutenbergOutlineHeading & { index: number } =>
    ({ heading, ordinal: ordinal(value), depth: 1, kind, index });
  const all: Array<GutenbergOutlineHeading & { index: number }> = [];
  let sectionMatches: ReturnType<typeof lineMatches> = [];
  let divisionMatches: ReturnType<typeof lineMatches> = [];

  switch (pin.id) {
    case 'moby-dick': {
      const chapters = lineMatches(text, /^CHAPTER (\d+)\. [^\n]+$/gm);
      sectionMatches = chapters.slice(-pin.sections);
      const firstChapter = sectionMatches[0]?.index ?? text.length;
      for (const match of text.matchAll(/^(ETYMOLOGY|EXTRACTS)\.?$/gm)) {
        if (match.index! < firstChapter) all.push({ heading: match[0]!, ordinal: all.length + 1, depth: 1, kind: 'front-matter', index: match.index! });
      }
      all.push(...sectionMatches.map((item) => chapter(item.heading, String(item.ordinal), item.index)));
      break;
    }
    case 'war-and-peace': {
      const books = lineMatches(text, /^BOOK (ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN)(?:[,:—-][^\n]*)?$/gm);
      const chapters = lineMatches(text, /^CHAPTER ([IVXLCDM]+)\.?$/gm);
      divisionMatches = books.slice(-pin.divisions);
      sectionMatches = chapters.slice(-pin.sections);
      all.push(...divisionMatches.map((item) => division(item.heading, String(books.indexOf(item) + 1), item.index, 'book')));
      all.push(...sectionMatches.map((item) => chapter(item.heading, String(item.ordinal), item.index)));
      break;
    }
    case 'les-miserables': {
      const volumes = lineMatches(text, /^[ \t]*VOLUME ([IVX]+)[ .:—-].*$/gim);
      const books = lineMatches(text, /^BOOK (FIRST|SECOND|THIRD|FOURTH|FIFTH|SIXTH|SEVENTH|EIGHTH|NINTH|TENTH|ELEVENTH|TWELFTH|THIRTEENTH|FOURTEENTH|FIFTEENTH)(?:[ .:—-].*)?$/gim);
      const chapters = lineMatches(text, /^CHAPTER ([IVXLCDM]+)(?:[ .:—-].*)?$/gim);
      const numeric = (value: string) => ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH', 'THIRTEENTH', 'FOURTEENTH', 'FIFTEENTH'].indexOf(value.toUpperCase()) + 1;
      const wantedBooks = books.slice(-48);
      sectionMatches = chapters.slice(-pin.sections);
      divisionMatches = [...volumes.slice(-5), ...wantedBooks];
      all.push(...volumes.slice(-5).map((item, index) => division(item.heading, String(index + 1), item.index, 'volume')));
      all.push(...wantedBooks.map((item) => division(item.heading, String(numeric(item.heading.match(/BOOK ([A-Z]+)/i)?.[1] ?? '')), item.index, 'book')));
      all.push(...sectionMatches.map((item) => chapter(item.heading, String(item.ordinal), item.index)));
      break;
    }
    case 'hamlet': {
      const acts = lineMatches(text, /^[ \t]*ACT ([IVX]+)\.?$/gm);
      const scenes = lineMatches(text, /^[ \t]*SCENE ([IVX]+)\.?[^\n]*$/gm);
      divisionMatches = acts.slice(-pin.divisions);
      sectionMatches = scenes.slice(-pin.sections);
      all.push(...divisionMatches.map((item) => division(item.heading, String(item.ordinal), item.index, 'act')));
      all.push(...sectionMatches.map((item) => ({ heading: item.heading, ordinal: item.ordinal, depth: 2, kind: 'scene' as const, index: item.index })));
      break;
    }
    case 'leaves-of-grass': {
      const start = text.search(/^Song of Myself\s*$/im);
      const end = start < 0 ? -1 : text.slice(start + 1).search(/^BOOK IV\./im);
      const song = text.slice(start < 0 ? 0 : start, end < 0 ? undefined : start + end + 1);
      sectionMatches = lineMatches(song, /^[ \t]*(\d{1,2})\.?[ \t]*$/gm);
      if (sectionMatches.some((item, index) => item.ordinal !== index + 1)) {
        throw new Error('Leaves of Grass numbered sections are not consecutive');
      }
      all.push(...sectionMatches.map((item) => ({ heading: `Section ${item.ordinal}`, ordinal: item.ordinal, depth: 1, kind: 'section' as const, index: start + item.index })));
      break;
    }
    case 'hong-lou-meng': {
      // Chapter titles follow 回 after whitespace; the same edition has editor comments such as
      // “第四回中既將…” that begin with a chapter reference but are not chapter headings.
      const chapterLines = lineMatches(text, /^[ \t\u3000]*第([一二三四五六七八九十百零〇两]+)回(?:[　 \t]+[^\n]+)?[ \t\u3000]*$/gm);
      // A page break repeats chapter 45's heading twice in this edition; retain its final occurrence.
      const chapters = chapterLines.filter((item, index, items) => items[index + 1]?.heading !== item.heading);
      const chineseOrdinal = (value: string) => {
        const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        if (!/[十百]/u.test(value)) {
          return [...value].reduce((number, character) => number * 10 + (digits[character] ?? 0), 0);
        }
        let total = 0, section = 0;
        for (const character of value) {
          if (character === '百') { section = (section || 1) * 100; total += section; section = 0; }
          else if (character === '十') { section = (section || 1) * 10; total += section; section = 0; }
          else section = digits[character] ?? 0;
        }
        return total + section;
      };
      const allChapters = chapters.map((item) => {
        const matched = /^第([一二三四五六七八九十百零〇两]+)回/u.exec(item.heading)!;
        const heading = item.heading.replace(/\s+/gu, ' ');
        return { heading, ordinal: chineseOrdinal(matched[1]!), index: item.index };
      });
      sectionMatches = allChapters.slice(-pin.sections);
      all.push(...sectionMatches.map((item) => ({ heading: item.heading, ordinal: item.ordinal, depth: 1, kind: 'chapter' as const, index: item.index })));
      break;
    }
  }

  if (pin.id !== 'moby-dick') all.sort((a, b) => a.index - b.index);
  const ordered = all.sort((a, b) => a.index - b.index).map(({ index: _index, ...item }) => item);
  const headings = ordered.filter((item) => item.kind === 'chapter' || item.kind === 'scene' || item.kind === 'section');
  if (headings.length !== pin.sections || ordered.length !== pin.sections + pin.divisions + pin.frontMatter) {
    throw new Error(`${pin.id}: expected ${pin.sections} sections and ${pin.divisions + pin.frontMatter} divisions, got ${headings.length} and ${ordered.length - headings.length}`);
  }
  return ordered;
}

const months: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};
const monthNumber = (value: string) => months[value[0]!.toUpperCase() + value.slice(1).toLowerCase()];
const monthHeading = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}(?:-\d{2,4})?\s*$/gim;
const dayHeading = /^[ \t]*(?:(January|February|March|April|May|June|July|August|September|October|November|December)\s+)?(\d{1,2})(?:st|nd|rd|th|d)(?:\s*\([^\n)]*\))?(?:[.,:]|(?=\s+[A-Za-z]))\s*(?!\d{3,4}\b)(.*)$/gim;
const isoDate = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

function diaryEntries(text: string, year: number): GutenbergDiaryPart[] {
  const monthsInYear = [...text.matchAll(monthHeading)];
  const entries: GutenbergDiaryPart[] = [];
  for (const [monthIndex, sectionHeading] of monthsInYear.entries()) {
    const sectionStart = sectionHeading.index! + sectionHeading[0].length;
    const sectionEnd = monthsInYear[monthIndex + 1]?.index ?? text.length;
    const section = text.slice(sectionStart, sectionEnd);
    const month = monthNumber(sectionHeading[1]!);
    const headings = [...section.matchAll(dayHeading)].filter((heading) => {
      const preceding = section.slice(0, heading.index!);
      const hasEntryGap = /(?:^|\n)[ \t]*\n$/u.test(preceding);
      return hasEntryGap && (!heading[1] || monthNumber(heading[1]) === month);
    });
    let lastDay = year === 1660 && month === 1 && monthIndex === 0 ? 1 : 0;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const datedHeadings = headings.filter((heading) => {
      const day = Number(heading[2]);
      // Editor notes sometimes begin with an earlier quoted date or one outside the current month.
      if (day <= lastDay || day > daysInMonth) return false;
      lastDay = day;
      return true;
    });
    if (year === 1660 && month === 1 && monthIndex === 0) {
      const opening = /^Blessed be God, at the end of the last year/m.exec(section);
      if (!opening || !datedHeadings[0] || datedHeadings[0].index! <= opening.index!) {
        throw new Error('Pepys 1660: missing undated January 1 opening entry');
      }
      const body = section.slice(opening.index!, datedHeadings[0].index!).trim();
      entries.push({ date: isoDate(year, month, 1), body });
    }
    for (const [index, heading] of datedHeadings.entries()) {
      const day = Number(heading[2]);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new Error(`Pepys ${year}: invalid dated entry ${heading[0]}`);
      }
      const body = [
        heading[3]!,
        section.slice(heading.index! + heading[0].length, datedHeadings[index + 1]?.index ?? section.length),
      ].join('\n').trim();
      if (!body || /gutenberg|pglaf/i.test(body)) throw new Error(`Pepys ${year}: empty or wrapped entry ${heading[0]}`);
      entries.push({ date: isoDate(year, month, day), body });
    }
  }
  for (let index = 1; index < entries.length; index++) {
    if (entries[index]!.date <= entries[index - 1]!.date) {
      throw new Error(`Pepys ${year}: entries are out of order (${entries[index - 1]!.date} then ${entries[index]!.date})`);
    }
  }
  return entries;
}

function normalizePepys(raw: unknown): GutenbergDiary {
  const records = (raw as { records?: Array<{ id?: unknown; record?: unknown }> })?.records;
  if (!Array.isArray(records) || records.length !== gutenbergPepys.editions.length) {
    throw new Error('Malformed Gutenberg Pepys bundle');
  }
  const editions: GutenbergDiary['editions'] = [];
  const parts: GutenbergDiaryPart[] = [];
  for (const [index, expected] of gutenbergPepys.editions.entries()) {
    const record = records[index];
    if (record?.id !== `pg${expected.edition}` || typeof record.record !== 'string') {
      throw new Error(`Malformed Gutenberg Pepys edition ${expected.edition}`);
    }
    checkEditionTitle(record.record, expected.edition, String(expected.year));
    const entries = diaryEntries(cleanBody(record.record, `pg${expected.edition}`), expected.year);
    editions.push({ year: expected.year, edition: expected.edition, sourceSha256: hash(record.record) });
    parts.push(...entries);
  }
  const selected = parts.slice(0, gutenbergPepys.entryCount);
  if (selected.length !== gutenbergPepys.entryCount) {
    throw new Error(`Pepys diary requires ${gutenbergPepys.entryCount} dated entries, got ${selected.length}`);
  }
  return {
    entryCount: selected.length,
    dateRange: { start: selected[0]!.date, end: selected.at(-1)!.date },
    editions,
    parts: selected,
  };
}

const requestForPin = (pin: GutenbergTextPin | GutenbergOutlinePin, maxResponseBytes?: number): FixtureRequest => ({
  id: `pg${pin.edition}`,
  url: gutenbergUrl(pin.edition),
  ...(maxResponseBytes ? { maxResponseBytes } : {}),
});

export const gutenberg: FixtureSource & { responseFormat: 'text' } = {
  name: 'gutenberg', responseFormat: 'text', minimumIntervalMs: 1000,
  requests: [
    ...gutenbergTexts.map((pin) => requestForPin(pin)),
    ...gutenbergOutlines.map((pin) => requestForPin(pin, 10_000_000)),
    {
      id: gutenbergPepys.id,
      url: gutenbergUrl(gutenbergPepys.editions[0].edition),
      records: gutenbergPepys.editions.map(({ edition }) => ({ id: `pg${edition}`, url: gutenbergUrl(edition) })),
    },
  ],
  reuseBasis: 'Public-domain literary text in the United States; UTF-8 editions with the license, header, footer and trademark references removed under section 1.C. Source attribution retained only as provenance. https://www.gutenberg.org/policy/license.html',
  normalize(raw: unknown, id: string): GutenbergText | GutenbergOutline | GutenbergDiary {
    if (id === gutenbergPepys.id) return normalizePepys(raw);
    if (typeof raw !== 'string') throw new Error(`Malformed Gutenberg ${id}`);
    const textPin = gutenbergTexts.find((item) => `pg${item.edition}` === id);
    const outlinePin = gutenbergOutlines.find((item) => `pg${item.edition}` === id);
    const pin = textPin ?? outlinePin;
    if (!pin) throw new Error(`Malformed Gutenberg ${id}`);
    checkEditionTitle(raw, pin.edition, pin.title);
    if (textPin?.language) checkEditionLanguage(raw, pin.edition, textPin.language);
    const sourceSha256 = hash(raw);
    const text = cleanBody(raw, id);
    return textPin
      ? { edition: pin.edition, sourceSha256, text }
      : { edition: pin.edition, sourceSha256, outline: outlineFor(outlinePin!, text) };
  },
};
