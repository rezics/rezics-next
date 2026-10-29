import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../src/library/collection-page.tsx', import.meta.url), 'utf8');
const row = await readFile(new URL('../src/library/subject-row.tsx', import.meta.url), 'utf8');

test('Collection page uses localized metadata and a localized relative time', () => {
  expect(page).toContain('<PageHeading>{page.title}</PageHeading>');
  expect(page).toContain('<AccountRef account={page.curator} />');
  expect(page).toContain('<RelativeTime');
  expect(page).not.toContain('<time {...{ datetime: page.updatedAt }}>{page.updatedAt}</time>');
});

test('Collection members use shared cover tiles and ListRow with their own subject cover', () => {
  expect(page).toContain('<CoverGrid');
  expect(page).toContain('<CoverCard');
  expect(page).toContain('<ListRow');
  expect(page).toContain('<ListRowLink');
  expect(page).toContain('<ListRowControl');
  expect(page).not.toContain('divide-y divide-border/60 border-y border-border/60');
  expect(row).toContain('cover={subject?.cover ?? null}');
  expect(row).not.toMatch(/Avatar|initials\(/);
});

test('member subject titles use localized page title helpers', () => {
  expect(page).toMatch(/subjectPageTitle|pageText/);
});
