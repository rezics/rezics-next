import { expect, test } from 'bun:test';
import { join } from 'node:path';

const route = join(import.meta.dir, '..', 'src', 'routes', 'subjects', '$id_.$slug.tsx');
const routeFiles = [
  route,
  join(import.meta.dir, '..', 'src', 'routes', 'subjects', '$id_.$slug_.$view.tsx'),
  join(import.meta.dir, '..', 'src', 'routes', 'subjects', '$id_.$slug_.relations.tsx'),
];

test('the subject route renders the page model', async () => {
  const source = await Bun.file(route).text();
  expect(source).toContain("from '../../features/pages/subject");
  expect(source).toContain('subjectPageQuery(');
  expect(source).toContain('<SubjectPage');
  expect(source).toContain('subjectPageTitle(');
  expect(source).not.toMatch(/\.subjects\(\{/);
  expect(source).not.toContain('<dl');
});

test('overview, named view and relations loaders bind canonical reads to the retiring route', async () => {
  const sources = await Promise.all(routeFiles.map((file) => Bun.file(file).text()));
  for (const source of sources) {
    expect(source).toContain('abortController.signal');
    expect(source).toContain('awaitSubjectRoute(');
    expect(source).toContain('subjectRequestReader({ data: { realm: deps.realm }, signal })');
  }
  expect(sources.every((source) => source.includes('readSubjectCanonicalQuery('))).toBe(true);
});
