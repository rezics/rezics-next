import { expect, test } from 'bun:test';

const source = async (path: string) => Bun.file(new URL(path, import.meta.url)).text();

test('shelf sizes use home tile width and phone grids adapt their columns while preserving the cover ratio', async () => {
  const [shelf, coverGrid, home] = await Promise.all([
    source('../src/library/shelf-view.tsx'),
    source('../../../packages/ui/src/components/cover-card.tsx'),
    source('../src/library/continue.tsx'),
  ]);
  expect(shelf).toContain("s: 'small', m: 'medium', l: 'large'");
  expect(coverGrid).toContain('grid-cols-4');
  expect(coverGrid).toContain('grid-cols-3');
  expect(coverGrid).toContain('grid-cols-2');
  expect(coverGrid).toContain('repeat(auto-fill,7.5rem)');
  expect(shelf).toContain('CoverGrid');
  expect(shelf).toContain('ratio="5:7"');
  expect(home).toContain('CoverGrid');
  expect(home).toContain('progress={');
});

test('active shelf progress is formatted through the Continue progress helper in every layout without another read', async () => {
  const [shelf, rows, entries, progress] = await Promise.all([
    source('../src/library/shelf-view.tsx'),
    source('../src/library/shelf-rows.ts'),
    source('../src/library/entries-read.ts'),
    source('../src/library/progress-label.ts'),
  ]);
  expect(shelf).toContain('progressView');
  expect(shelf).toContain('const progress = entryProgress(entry, locale)');
  expect(shelf).toContain('...(progress ? { progress } : {})');
  expect(shelf).toContain('progress: <ProgressRow {...progress} />');
  expect(shelf).toContain('GridView');
  expect(shelf).toContain('ListView');
  expect(shelf).toContain('TableView');
  expect(entries).toContain('activeProgressSession');
  expect(progress).toContain('export function progressView');
  expect(shelf).not.toContain('progressSessions.get');
  expect(rows).not.toContain('progressSessions.get');
});

test("home's section headings share the same heading component and style, including Continue", async () => {
  const [home, pageData] = await Promise.all([
    source('../src/library/continue.tsx'),
    source('../src/features/pages/data.tsx'),
  ]);
  expect(home).toContain('SectionHeading');
  expect(home).not.toContain('font-serif');
  expect(pageData).toContain('SectionHeading');
});

test('search result covers use the shared Cover component', async () => {
  const results = await source('../src/search/results.tsx');
  expect(results).toContain("from '@rezics/ui/cover'");
  expect(results).toContain('<Cover');
});

test('typed visual novel home tiles keep their localized type label', async () => {
  const pages = await source('../src/features/pages/data.tsx');
  const homeQueries = await source('../src/features/pages/home-queries.ts');
  expect(pages).toContain('typeLabel');
  expect(pages).toContain('hit.typeLabel');
  expect(homeQueries).toContain('nameSubjectTypes(subjects)');
});
