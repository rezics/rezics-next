import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import membersRecording from '../src/kernel/recorded/library-collection-members.json';
import { answerFakeRoute } from '../src/kernel/fake-modules.ts';
import type { CollectionMember } from '../src/library/reads';

const page = await readFile(new URL('../src/library/collection-page.tsx', import.meta.url), 'utf8');
const row = await readFile(new URL('../src/library/subject-row.tsx', import.meta.url), 'utf8');
const reads = await readFile(new URL('../src/library/reads.ts', import.meta.url), 'utf8');

test('Collection page uses localized metadata and a localized relative time', () => {
  expect(page).toContain('<PageHeading>{page.title}</PageHeading>');
  expect(page).toContain('page.curator.displayName ?? page.curator.handle');
  expect(page).toContain('@{page.curator.handle}');
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
  expect(row).toContain("size = 'sm'");
  expect(row).toContain('cover={subject?.cover ?? null}');
  expect(row).not.toMatch(/Avatar|initials\(/);
});

test('member subject titles use localized page title helpers', () => {
  expect(page).toMatch(/subjectPageTitle|pageText/);
  expect(row).toContain('pageText(');
  expect(reads).toContain('labelLanguage:');
});

test('the Collection story gives each covered subject its own media and preserves uncovered members', async () => {
  const result = await answerFakeRoute(
    'story',
    new Request('https://rezics.local/v1/collections/01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2/members'),
    { 'library-collection-members': membersRecording },
  );
  const members = result?.members as CollectionMember[] | undefined;
  const genji = members?.find((member) => member.subject?.id === '01a17a3b-6bc3-764f-8727-7872d197bd93')?.subject
    ?.cover;
  const kokoro = members?.find((member) => member.subject?.id === '01a17a3b-6b89-748f-a486-33c354ef3c9a')?.subject
    ?.cover;
  const prince = members?.find((member) => member.subject?.id === '01a17a3b-0884-721b-91ef-d7ffd7bb58e4')?.subject
    ?.cover;
  expect(genji).toBeNull();
  expect(kokoro?.media).toBe('0192f3a0-6c1e-7b2a-9d4e-9a2b3c4d0003');
  expect(prince?.media).toBe('01a17a3b-0884-7c01-8a3f-c0de00000001');
  expect(prince?.media).not.toBe(kokoro?.media);
});
