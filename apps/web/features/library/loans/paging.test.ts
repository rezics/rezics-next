import { describe, expect, test } from 'bun:test';
import { loadRecordPages, recordContinuation, reduceRecordPage, type RecordList } from './paging.ts';
import type { RecordPage, ReleaseChoice } from './types.ts';

function edition(n: number): ReleaseChoice {
  return { id: `https://rezics.com/id/edition-${n}`, title: `Edition ${n}`, editionStatement: null,
    publicationYear: null, isbn13: null };
}

function ok<T>(items: T[], nextCursor: string | null): { ok: true; data: RecordPage<T> } {
  return { ok: true, data: { items, nextCursor, complete: nextCursor === null } };
}

const empty: RecordList<ReleaseChoice> = { items: [], nextCursor: null, failed: false };

describe('edition and copy pages', () => {
  test('a record past the first 20 is listed only after its cursor is followed', () => {
    const first = Array.from({ length: 20 }, (_, index) => edition(index + 1));
    const held = reduceRecordPage(empty, ok(first, 'page-2'));
    expect(held.items.map(item => item.title)).not.toContain('Edition 21');
    expect(recordContinuation(held)).toBe('more');
    const listed = reduceRecordPage(held, ok([edition(21)], null));
    expect(listed.items.map(item => item.title)).toContain('Edition 21');
    expect(recordContinuation(listed)).toBeNull();
  });

  test('a failed next page keeps the editions already listed', () => {
    const held = reduceRecordPage(empty, ok([edition(1)], 'page-2'));
    const kept = reduceRecordPage(held, { ok: false, failure: 'unavailable' });
    expect(kept.items).toEqual(held.items);
    expect(recordContinuation(kept)).toBe('retry');
  });

  test('loadRecordPages follows the cursor past the first page', async () => {
    const pages = [ok(Array.from({ length: 20 }, (_, index) => edition(index + 1)), 'page-2'), ok([edition(21)], null)];
    let calls = 0;
    const listed = await loadRecordPages(async cursor => {
      expect(cursor).toBe(calls === 0 ? null : 'page-2');
      return pages[calls++]!;
    });
    expect(listed.items).toHaveLength(21);
    expect(listed.items.at(-1)?.title).toBe('Edition 21');
  });
});
