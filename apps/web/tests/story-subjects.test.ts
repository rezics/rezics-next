import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const kernel = join(import.meta.dir, '../src/kernel');
const recorded = join(kernel, 'recorded');
const storyRecordings = ['home-page', 'search', 'library-entries', 'subject-page'];
const locales = ['en', 'zh-Hans'];
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

async function subjects() {
  const module = await import('../src/kernel/story-subjects.ts');
  return module.storySubjects as Array<{
    id: string;
    type: string;
    labels: Record<string, string>;
    originalLanguage: string;
    cover?: unknown;
  }>;
}

function walk(value: unknown, found: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(value)) {
    for (const child of value) walk(child, found);
  } else if (value && typeof value === 'object') {
    const item = value as Record<string, any>;
    if (typeof item.id === 'string' && typeof item.type === 'string' && (item.labels || item.label)) found.push(item);
    for (const child of Object.values(item)) walk(child, found);
  }
  return found;
}

function coverOf(subject: Record<string, any>): unknown {
  return subject.cover ?? subject.summary?.cover ?? null;
}

function coversById(value: unknown): Map<string, unknown> {
  return new Map(walk(value).map((subject) => [subject.id, coverOf(subject)]));
}

function storySubjectsIn(name: string, page: Record<string, any>): Record<string, any>[] {
  if (name === 'search') return Array.isArray(page.subjects) ? page.subjects : [];
  if (name === 'library-entries')
    return Array.isArray(page.libraryEntries)
      ? page.libraryEntries.map((row: Record<string, any>) => row.subject).filter(Boolean)
      : [];
  if (name === 'home-page') return Object.values(page.reads ?? {}).flatMap((read: any) => read.body?.subjects ?? []);
  if (name === 'subject-page')
    return Object.values(page.reads ?? {}).flatMap((read: any) => (read.body?.subject ? [read.body.subject] : []));
  return [];
}

function localizedRecording(base: string, locale: string): string {
  const candidates =
    locale === 'en'
      ? [`${base}.json`, `${base}-${locale}.json`, `${base}.${locale}.json`]
      : [`${base}-${locale}.json`, `${base}.${locale}.json`];
  const file = candidates.find((candidate) => readdirSync(recorded).includes(candidate));
  expect(file, `missing ${locale} recording for ${base}`).toBeDefined();
  return join(recorded, file!);
}

test('recorded and fake story subjects use identities and metadata from the shared subject set', async () => {
  const entries = await subjects();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const fixtures = readJson(join(kernel, 'fixtures.json'));
  const pages = storyRecordings.flatMap((name) => {
    const base = readJson(join(recorded, `${name}.json`));
    return [base, ...locales.map((locale) => readJson(localizedRecording(name, locale)))];
  });
  const displayed = [
    ...storyRecordings.flatMap((name) => {
      const base = readJson(join(recorded, `${name}.json`));
      return [base, ...locales.map((locale) => readJson(localizedRecording(name, locale)))].flatMap((page) =>
        storySubjectsIn(name, page),
      );
    }),
    ...walk(fixtures),
  ];

  for (const subject of displayed) {
    const entry = byId.get(subject.id);
    if (!entry) continue;
    expect(subject.type).toBe(entry.type);
    if (subject.labels)
      for (const [language, label] of Object.entries(subject.labels)) expect(entry.labels[language]).toBe(label);
    if (typeof subject.label === 'string') expect(Object.values(entry.labels)).toContain(subject.label);
    if (subject.summary?.label?.value) expect(Object.values(entry.labels)).toContain(subject.summary.label.value);
    expect(coverOf(subject)).toEqual(entry.cover ?? null);
  }

  for (const name of storyRecordings) {
    const files = [join(recorded, `${name}.json`), ...locales.map((locale) => localizedRecording(name, locale))];
    for (const file of files) {
      for (const subject of storySubjectsIn(name, readJson(file)))
        expect(byId.has(subject.id), `${name}: ${subject.id}`).toBe(true);
    }
  }
});

test('home, search, library and subject stories use the shared cover or placeholder for each subject ID', async () => {
  const entries = new Map((await subjects()).map((entry) => [entry.id, entry]));
  const ids = new Set<string>();
  for (const name of storyRecordings) {
    for (const page of [
      readJson(join(recorded, `${name}.json`)),
      ...locales.map((locale) => readJson(localizedRecording(name, locale))),
    ]) {
      for (const subject of walk(page)) ids.add(subject.id);
    }
  }
  for (const id of ids) {
    const expected = entries.get(id);
    if (!expected) continue;
    for (const name of storyRecordings) {
      const page = readJson(join(recorded, `${name}.json`));
      const actual = coversById(page).get(id);
      if (actual !== undefined) expect(actual).toEqual(expected.cover ?? null);
    }
  }
});

test('no two story subjects share a cover image', async () => {
  const seen = new Map<string, string>();
  for (const subject of await subjects()) {
    const cover = subject.cover as Record<string, unknown> | undefined;
    if (!cover) continue;
    const image = String(cover.media ?? cover.id ?? JSON.stringify(cover));
    expect(seen.has(image), `${subject.id} and ${seen.get(image)} share ${image}`).toBe(false);
    seen.set(image, subject.id);
  }
});

test('record.ts seeds its recorded subjects from the shared subject set', () => {
  const recorder = readFileSync(join(import.meta.dir, '../scripts/record.ts'), 'utf8');
  expect(recorder).toMatch(/story-subjects/);
  expect(recorder).not.toMatch(/const homeSubjects\s*=/);
  expect(recorder).not.toMatch(/const librarySubjects\s*=/);
});

test('each label-bearing response has locale recordings and fake replay selects Accept-Language', () => {
  const files = new Set(readdirSync(recorded));
  for (const name of [
    'home-page',
    'search',
    'library-entries',
    'library-collections',
    'library-collection',
    'library-continue-entries',
  ]) {
    for (const locale of locales) {
      const recording = locale === 'en' ? `${name}.json` : `${name}-${locale}.json`;
      expect(files.has(recording), `${name}-${locale}`).toBe(true);
    }
  }
  const fake = readFileSync(join(kernel, 'fake.ts'), 'utf8');
  expect(fake).toMatch(/Accept-Language/);
  expect(fake).toMatch(/requestedRecording/);
});
