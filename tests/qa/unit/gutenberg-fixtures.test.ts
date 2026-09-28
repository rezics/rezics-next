import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pullFixtures, readLockedFixture, type FixtureLock } from '../../../scripts/fixtures/pull.ts';
import { classicParagraphs, classicText, splitClassic } from '../../../scripts/dev/seed/classics-text.ts';
import { gutenberg, gutenbergBooks, stripGutenbergWrapper, type GutenbergText } from '../../fixtures/sources/gutenberg.ts';

const root = resolve(import.meta.dir, '../../..');
const wrapped = (body: string) => `License header\r\n*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\r\n\r\n${body}\r\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\r\nLicense footer`;

test('Gutenberg: printed prose becomes reader paragraphs while indented verse keeps its lines', () => {
  expect(classicParagraphs('A printed paragraph\nwraps here.\n\nA second paragraph.\n\n  Verse one\n  Verse two'))
    .toBe('A printed paragraph wraps here.\nA second paragraph.\nVerse one\nVerse two');
});

test('Gutenberg: strip the wrapper, preserve Unicode and reject ambiguous or residual trademark text', () => {
  expect(stripGutenbergWrapper(wrapped('“Café”\r\n\r\nA story.'))).toBe('“Café”\n\nA story.\n');
  expect(() => stripGutenbergWrapper('No markers')).toThrow('boundaries');
  expect(() => stripGutenbergWrapper(wrapped('') )).toThrow('empty');
  expect(() => stripGutenbergWrapper(wrapped('Project Gutenberg credit'))).toThrow('trademark');
  expect(() => stripGutenbergWrapper(wrapped(wrapped('duplicate')))).toThrow('boundaries');
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

for (const book of gutenbergBooks) {
  test(`Gutenberg: ${book.id} has every ordered chapter and a bounded, readable opening sample`, () => {
    const fixture = readLockedFixture(root, 'gutenberg', `pg${book.edition}`) as GutenbergText;
    expect(fixture.text).not.toMatch(/gutenberg|pglaf/i);
    const sections = splitClassic(book, fixture.text);
    expect(sections).toHaveLength(book.sections);
    expect(new Set(sections.map(chapter => chapter.title)).size).toBe(book.sections);
    const { chapters } = classicText(root, book);
    expect(chapters).toHaveLength(book.id === 'frankenstein' ? 7 : 3);
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
