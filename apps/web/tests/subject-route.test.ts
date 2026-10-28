import { expect, test } from 'bun:test';
import { join } from 'node:path';

const route = join(import.meta.dir, '..', 'src', 'routes', 'subjects', '$id_.$slug.tsx');

test('the subject route renders the page model', async () => {
  const source = await Bun.file(route).text();
  expect(source).toContain("from '../../features/pages/subject");
  expect(source).toContain('loadSubjectPage(');
  expect(source).toContain('<SubjectPage');
  expect(source).toContain('subjectPageTitle(');
  expect(source).not.toMatch(/\.subjects\(\{/);
  expect(source).not.toContain('<dl');
});
