import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pullFixtures, readLockedFixture, type FixtureLock } from '../../../scripts/fixtures/pull.ts';
import { classicParagraphs, classicText, splitClassic } from '../../../scripts/dev/seed/classics-text.ts';
import {
  gutenberg, gutenbergBooks, gutenbergOutlines, gutenbergPepys, gutenbergTexts,
  stripGutenbergWrapper, type GutenbergDiary, type GutenbergOutline, type GutenbergText,
} from '../../fixtures/sources/gutenberg.ts';
import { wikidataAuthors, type WikidataFact } from '../../fixtures/sources/wikidata.ts';

const root = resolve(import.meta.dir, '../../..');
const wrapped = (body: string, title = 'Pride and Prejudice', edition = 1342, language = 'English') =>
  `Language: ${language}\r\nRelease date: January 1, 2000 [eBook #${edition}]\r\n` +
  `*** START OF THE PROJECT GUTENBERG EBOOK ${title.toUpperCase()} ***\r\n\r\n${body}\r\n` +
  `*** END OF THE PROJECT GUTENBERG EBOOK ${title.toUpperCase()} ***\r\nLicense footer`;

test('Gutenberg: printed prose becomes reader paragraphs while indented verse keeps its lines', () => {
  expect(classicParagraphs('A printed paragraph\nwraps here.\n\nA second paragraph.\n\n  Verse one\n  Verse two'))
    .toBe('A printed paragraph wraps here.\nA second paragraph.\nVerse one\nVerse two');
});

test('Gutenberg: strip the wrapper, preserve Unicode and reject ambiguous or residual trademark text', () => {
  expect(stripGutenbergWrapper(wrapped('“Café”\r\n\r\nA story.'))).toBe('“Café”\n\nA story.\n');
  expect(stripGutenbergWrapper(wrapped('مشروع غوتنبرغ ومشروع غوتنبرع ومكتبة غوتنبرغ.'), { removeProjectReferences: true }))
    .toBe('المشروع والمشروع والمكتبة الرقمية.\n');
  expect(() => stripGutenbergWrapper('No markers')).toThrow('boundaries');
  expect(() => stripGutenbergWrapper(wrapped('') )).toThrow('empty');
  expect(() => stripGutenbergWrapper(wrapped('Project Gutenberg credit'))).toThrow('trademark');
  expect(() => stripGutenbergWrapper(wrapped(wrapped('duplicate')))).toThrow('boundaries');
});

test('Gutenberg: a missing or cross-edition id fails before pinning text', () => {
  expect(() => gutenberg.normalize(wrapped('A story.'), 'pg999999')).toThrow('Malformed Gutenberg');
  expect(() => gutenberg.normalize(wrapped('A story.'), 'pg2600')).toThrow('edition mismatch');
  expect(() => gutenberg.normalize(wrapped('A story.', 'Pride and Prejudice', 9999), 'pg1342'))
    .toThrow('edition mismatch');
  expect(() => gutenberg.normalize(
    wrapped('Una storia.', 'La Divina Commedia di Dante: Complete', 1000), 'pg1000',
  )).toThrow('edition mismatch');
  expect(() => gutenberg.normalize({ records: [] }, gutenbergPepys.id)).toThrow('Malformed Gutenberg Pepys');
});

test('Gutenberg: plain UTF-8 acquisition locks source provenance and replays offline with integrity checks', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/gutenberg-test-'));
  const raw = wrapped('A public-domain story.');
  const adapter = { ...gutenberg, requests: [gutenberg.requests[0]!] };
  try {
    await pullFixtures(directory, { adapters: [adapter], mode: 'live', updateLock: true,
      fetcher: async (_url, init) => {
        expect(new Headers(init?.headers).get('accept')).toBe('text/plain');
        return new Response(raw);
      } });
    const lock = JSON.parse(readFileSync(join(directory, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as FixtureLock;
    const entry = lock.entries[0]!;
    expect(entry.seed).toBe(`tests/fixtures/gutenberg/${entry.sha256}.json`);
    expect(readLockedFixture(directory, 'gutenberg', 'pg1342')).toEqual({ edition: 1342,
      sourceSha256: createHash('sha256').update(raw).digest('hex'), text: 'A public-domain story.\n' });
    rmSync(join(directory, '.cache'), { recursive: true });
    expect((await pullFixtures(directory, { adapters: [adapter], offline: true,
      fetcher: async () => { throw new Error('network used'); } }))[0]?.status).toBe('hydrated');
    writeFileSync(join(directory, entry.seed), '{}');
    rmSync(join(directory, '.cache'), { recursive: true });
    expect(() => readLockedFixture(directory, 'gutenberg', 'pg1342')).toThrow('integrity mismatch');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Gutenberg: complete outline sources may exceed the default response cap', async () => {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp/gutenberg-size-test-'));
  const request = gutenberg.requests[0]!;
  const raw = wrapped('A'.repeat(2_000_001));
  const fetcher = async () => new Response(raw);
  try {
    await expect(pullFixtures(directory, { adapters: [{ ...gutenberg, requests: [request] }], mode: 'live', fetcher }))
      .rejects.toThrow('response too large');
    const expandedRequest = { ...request, maxResponseBytes: 3_000_000 };
    const result = await pullFixtures(directory, {
      adapters: [{ ...gutenberg, requests: [expandedRequest] }], mode: 'live', fetcher,
    });
    expect(result[0]?.id).toBe(request.id);
    expect(result[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const book of gutenbergBooks) {
  test(`Gutenberg: ${book.id} has every ordered chapter and a bounded, readable opening sample`, () => {
    const fixture = readLockedFixture(root, 'gutenberg', `pg${book.edition}`) as GutenbergText;
    expect(fixture.text).not.toMatch(/gutenberg|pglaf/i);
    const sections = splitClassic(book, fixture.text);
    expect(sections).toHaveLength(book.sections);
    expect(new Set(sections.map(chapter => chapter.title)).size).toBe(book.sections);
    const { chapters } = classicText(root, book);
    // Frankenstein adds its four letters; Pride and Prejudice the openings of its Volumes II and III.
    expect(chapters).toHaveLength(book.id === 'frankenstein' ? 7 : book.id === 'pride' ? 5 : 3);
    for (const chapter of chapters) {
      expect(chapter.body.length).toBeGreaterThan(500);
      expect(chapter.body.length).toBeLessThanOrEqual(65_536);
    }
    if (book.id === 'pride') {
      expect(chapters[0]!.body).toStartWith('It is a truth universally acknowledged');
      expect(chapters[0]!.body.split('\n')[0]).toBe('It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.');
      expect(chapters[1]!.body).toStartWith('Mr. Bennet was among the earliest');
      for (const chapter of sections) expect(chapter.body).not.toMatch(/Illustration|\]\]/);
    }
    if (book.id === 'alice') {
      expect(chapters[0]!.title).toBe('Chapter 1: Down the Rabbit-Hole');
      expect(chapters[0]!.body).toStartWith('Alice was beginning to get very tired');
    }
    if (book.id === 'frankenstein') {
      expect(chapters.map(chapter => chapter.title)).toEqual([
        'Letter 1', 'Letter 2', 'Letter 3', 'Letter 4', 'Chapter 1', 'Chapter 2', 'Chapter 3']);
    }
    expect(() => splitClassic(book, fixture.text.slice(0, fixture.text.length / 2))).toThrow('sections');
  });
}

test('Gutenberg: requested lock entries and content-addressed seeds are complete and clean', () => {
  const lock = JSON.parse(readFileSync(join(root, 'tests/fixtures/fixtures.lock.json'), 'utf8')) as FixtureLock;
  const entries = new Map(lock.entries.filter(entry => entry.source === 'gutenberg').map(entry => [entry.id, entry]));
  const bodies: string[] = [];
  for (const request of gutenberg.requests) {
    const entry = entries.get(request.id);
    expect(entry).toBeDefined();
    expect(entry!.seed).toBe(`tests/fixtures/gutenberg/${entry!.sha256}.json`);
    const bytes = readFileSync(join(root, entry!.seed));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry!.sha256);
    expect(bytes.byteLength).toBe(entry!.size);
    const fixture = readLockedFixture(root, 'gutenberg', request.id) as Record<string, unknown>;
    if (typeof fixture.text === 'string') bodies.push(fixture.text);
    if (Array.isArray(fixture.parts)) {
      for (const part of fixture.parts) {
        expect(typeof (part as { date?: unknown }).date).toBe('string');
        if (typeof (part as { body?: unknown }).body === 'string') bodies.push((part as { body: string }).body);
      }
    }
    if (Array.isArray(fixture.outline)) {
      expect(fixture.outline.every(item => typeof (item as { heading?: unknown }).heading === 'string')).toBe(true);
    }
  }
  expect(bodies).toHaveLength(gutenbergTexts.length + gutenbergPepys.entryCount);
  for (const body of bodies) expect(body).not.toMatch(/gutenberg|pglaf/i);
});

test('Gutenberg: language texts are complete, under 2 MB and explicitly US public domain', () => {
  for (const pin of [...gutenbergBooks, ...gutenbergTexts, ...gutenbergOutlines, gutenbergPepys]) {
    expect(pin.license).toBe('Public domain in the United States.');
  }
  const languageTexts = gutenbergTexts.filter((pin) => pin.language);
  expect(languageTexts.map((pin) => pin.language)).toEqual(['it', 'ru', 'ar']);
  for (const pin of languageTexts) {
    const fixture = readLockedFixture(root, 'gutenberg', `pg${pin.edition}`) as GutenbergText;
    expect(fixture.edition).toBe(pin.edition);
    expect(fixture.text.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(fixture.text, 'utf8')).toBeLessThanOrEqual(2_000_000);
  }
  expect((readLockedFixture(root, 'gutenberg', 'pg5316') as GutenbergText).text)
    .toContain('Красавице, которая нюхала');
  expect((readLockedFixture(root, 'gutenberg', 'pg43007') as GutenbergText).text)
    .not.toMatch(/مشروع غوتنبر|مكتبة غوتنبر/u);
});

for (const pin of gutenbergOutlines) {
  test(`Gutenberg: ${pin.id} keeps ${pin.sections} sections and ${pin.divisions + pin.frontMatter} named divisions`, () => {
    const fixture = readLockedFixture(root, 'gutenberg', `pg${pin.edition}`) as GutenbergOutline;
    expect(fixture.edition).toBe(pin.edition);
    expect(fixture.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.outline).toHaveLength(pin.sections + pin.divisions + pin.frontMatter);
    const sections = fixture.outline.filter(item => ['chapter', 'scene', 'section'].includes(item.kind));
    expect(sections).toHaveLength(pin.sections);
    expect(fixture.outline.every(item => item.heading.length > 0 && item.ordinal > 0 && item.depth > 0)).toBe(true);
    if (pin.id === 'hong-lou-meng') {
      expect(fixture.outline[0]?.heading).toMatch(/^第一回/u);
      expect(fixture.outline.map(item => item.ordinal)).toEqual(Array.from({ length: 120 }, (_, index) => index + 1));
    }
    if (pin.id === 'hamlet') expect(fixture.outline.filter(item => item.kind === 'act')).toHaveLength(5);
  });
}

test('Gutenberg: Pepys pins the first 1,100 dated entries in order and records every source edition', () => {
  const diary = readLockedFixture(root, 'gutenberg', gutenbergPepys.id) as GutenbergDiary;
  expect(diary.entryCount).toBe(gutenbergPepys.entryCount);
  expect(diary.parts).toHaveLength(gutenbergPepys.entryCount);
  expect(diary.dateRange.start).toBe(diary.parts[0]?.date);
  expect(diary.dateRange.end).toBe(diary.parts.at(-1)?.date);
  expect(diary.dateRange.start).toBe('1660-01-01');
  expect(diary.dateRange.end).toBe('1663-01-19');
  expect([1660, 1661, 1662, 1663].map((year) => diary.parts.filter((part) => part.date.startsWith(String(year))).length))
    .toEqual([366, 355, 360, 19]);
  expect(diary.parts[0]?.body).toStartWith('Blessed be God, at the end of the last year');
  expect(diary.editions.map(item => [item.year, item.edition])).toEqual(gutenbergPepys.editions.map(item => [item.year, item.edition]));
  for (let index = 0; index < diary.parts.length; index++) {
    const part = diary.parts[index]!;
    expect(part.body.length).toBeGreaterThan(0);
    expect(part.body).not.toMatch(/gutenberg|pglaf/i);
    if (index > 0) expect(part.date > diary.parts[index - 1]!.date).toBe(true);
  }
});

for (const author of wikidataAuthors) {
  test(`Wikidata: ${author.id} retains only its available selected labels and revision`, () => {
    const fact = readLockedFixture(root, 'wikidata', author.id) as WikidataFact;
    expect(fact.id).toBe(author.id);
    expect(fact.revision).toBeGreaterThan(0);
    expect(fact.labels.every(({ language }) => ['en', 'ja', 'zh'].includes(language))).toBe(true);
    expect(new Set(fact.labels.map(({ language }) => language)).size).toBe(fact.labels.length);
    for (const [language, value] of Object.entries(author.labels)) {
      expect(fact.labels.find((label) => label.language === language)?.value).toBe(value);
    }
    expect(Object.keys(fact)).toEqual(['id', 'revision', 'labels']);
  });
}
