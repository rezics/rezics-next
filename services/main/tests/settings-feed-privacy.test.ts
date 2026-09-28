import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { contentLanguageVisible, personFeedSourceVisible, readingActivityVisible } from '../src/modules/feed/read.ts';
import { PersonPreferencesStore } from '../src/modules/preferences/store.ts';

const author = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const other = 'https://rezics.com/id/00000000-0000-4000-8000-000000000002';

test('Home excludes another person’s review and collection when they hide reading activity', async () => {
  const reads: string[] = [];
  const client = { query: async (sql: string) => {
    reads.push(sql);
    if (sql.includes('FROM access.recovery_fence')) return { rows: [{ open: true }] };
    if (sql.includes('hide_reading_activity = true')) return { rows: [{ agent_id: author }] };
    return { rows: [] };
  }, release: () => {} };
  const store = new PersonPreferencesStore({ connect: async () => client } as unknown as Pool);
  const hidden = await store.hiddenReadingActors([author, other]);
  expect(readingActivityVisible({ kind: 'review', actor: author }, other, hidden)).toBe(false);
  expect(readingActivityVisible({ kind: 'collection', actor: author }, null, hidden)).toBe(false);
  expect(readingActivityVisible({ kind: 'review', actor: author }, author, hidden)).toBe(true);
  expect(readingActivityVisible({ kind: 'discussion', actor: author }, other, hidden)).toBe(true);
  expect(readingActivityVisible({ kind: 'review', actor: other }, author, hidden)).toBe(true);
  expect(reads.filter(sql => sql.includes('hide_reading_activity = true'))).toHaveLength(1);
});

test('Home applies blocks and saved content languages to post sources', () => {
  expect(personFeedSourceVisible({ kind: 'discussion', actor: author }, other,
    [author], new Set())).toBe(false);
  expect(personFeedSourceVisible({ kind: 'reply', actor: author }, other,
    [author], new Set())).toBe(false);
  expect(personFeedSourceVisible({ kind: 'discussion', actor: other }, author,
    [author], new Set())).toBe(true);
  expect(contentLanguageVisible('zh-Hans', [['zh-hans'], ['zh-Hans', 'en']])).toBe(true);
  expect(contentLanguageVisible('en', [['en'], ['zh-Hans']])).toBe(false);
  expect(contentLanguageVisible(null, [undefined, ['en']])).toBe(false);
});
