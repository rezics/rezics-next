import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { planChapterPosts, POST_BACKFILL_COST } from '../src/modules/post/backfill.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const chapter = () => ({ post: id(), main: id(), head: id(), publisher: id() });

test('Post migration preserves resource, revision and publisher identities in a bounded batch', () => {
  const rows = Array.from({ length: POST_BACKFILL_COST.batch }, chapter);
  const planned = planChapterPosts(rows);
  expect(planned).toEqual(rows);
  expect(planned[0]).not.toBe(rows[0]);
  expect(planChapterPosts(planned)).toEqual(planned);
});

test('Post migration rejects ambiguous identities and oversized batches before writing', () => {
  const row = chapter();
  expect(() => planChapterPosts([row, row])).toThrow('ambiguous');
  expect(() => planChapterPosts([{ ...row, publisher: '' }])).toThrow('ambiguous');
  expect(() => planChapterPosts([{ ...row, main: row.post }])).toThrow('ambiguous');
  expect(() => planChapterPosts(Array.from({ length: POST_BACKFILL_COST.batch + 1 }, chapter))).toThrow('ambiguous');
});
