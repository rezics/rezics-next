import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../src/features/pages/', import.meta.url);
const source = async (name: string) => readFile(new URL(name, root), 'utf8');

test('subject hero facts use one two-column term/value list that contains long values', async () => {
  const overview = await source('overview.tsx');
  expect(overview).toMatch(/grid[^"']*(?:grid-cols-\[minmax\(0,\d+fr\)_minmax\(0,\d+fr\)\]|grid-cols-2)/);
  expect(overview).toMatch(/<dt[^>]*>[\s\S]*?<\/dt>[\s\S]*?<dd[^>]*min-w-0[\s\S]*?break-words/);
});

test('spoiler control is an icon text button, outside subject values', async () => {
  const overview = await source('overview.tsx');
  expect(overview).toMatch(/<button[^>]*>[\s\S]*?(?:Eye|EyeOff)[\s\S]*?\{[^}]*spoilerShow[^}]*\}[\s\S]*?<\/button>/);
  expect(overview).not.toMatch(/<dt[^>]*>[\s\S]*spoilerShow/);
});

test('reactions and the subject menu share a top-right row; library actions are grouped under the title', async () => {
  const subject = await readFile(new URL('../src/features/pages/subject.tsx', import.meta.url), 'utf8');
  expect(subject).toMatch(/data-slot="subject-header-actions"[\s\S]*?Reactions[\s\S]*?menu/);
  expect(subject).toMatch(/data-slot="subject-library-actions"[\s\S]*?SubjectLibrarySlot/);
});

test('overview sections share the shell heading and spacing classes', async () => {
  const overview = await source('overview.tsx');
  expect(overview.match(/className=\{headingClass\}/g)?.length).toBeGreaterThan(0);
  expect(overview.match(/className=\{sectionClass\}/g)?.length).toBeGreaterThan(0);
  expect(overview).toMatch(/sectionClass\s*=\s*['"]min-w-0 space-y-4/);
});

test('cover credit is rendered only in Sources and the cover viewer', async () => {
  const [overview, subject] = await Promise.all([source('overview.tsx'), readFile(new URL('../features/pages/subject.tsx', import.meta.url), 'utf8')]);
  const creditOccurrences = [overview, subject].join('\n').match(/rightsHolder/g) ?? [];
  expect(creditOccurrences).toHaveLength(1);
  expect(overview).toMatch(/data-slot="subject-sources"[\s\S]*?rightsHolder/);
});
