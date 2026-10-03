import { expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { positionPickerPage, readReadingPositionPage } from '../features/wiki/position-picker.ts';
import { EntityPickerSource } from '../../../packages/ui/src/components/entity-picker-state.ts';

test('G1022: an indexing page stays partial and refreshes from the current basis without an error or stale cursor', async () => {
  let attempts = 0;
  const queries: Array<{ cursor?: string }> = [];
  const main = { v1: { 'reading-positions': () => ({ get: async ({ query }: { query: { cursor?: string } }) => {
    queries.push(query);
    const pending = ++attempts === 1;
    return { data: { items: [], nextCursor: null, complete: !pending,
      search: { status: pending ? 'indexing' : 'current' } }, error: null };
  } }) } } as unknown as MainClient;
  const source = new EntityPickerSource(async ({ q, cursor }) => positionPickerPage(
    await readReadingPositionPage(main, { work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
      q, cursor: cursor ?? undefined }), '/wiki', 'en', null));
  await source.search('chapter');
  expect(source.getSnapshot()).toMatchObject({ items: [], complete: false, updating: true, error: false });
  await source.more();
  expect(queries.length).toBe(1);
  await source.retry();
  expect(queries.map(query => query.cursor)).toEqual([undefined, undefined]);
  expect(source.getSnapshot()).toMatchObject({ complete: true, updating: false, error: false });
});
