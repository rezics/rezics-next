import { expect, test } from 'bun:test';
import { readIdentityIndexIncarnation } from '../../src/search/identity-epoch-participant-physical.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { IndexWriteError, writeIndexActions } from '../../src/search/write-actions.ts';

// Transport-boundary controls only; these do not stand in for native custody or Source truth.
function engine(body: unknown, status = 200): OpenSearch {
  return {
    async request<T>() {
      return { status, body: body as T };
    },
    async bulk<T>() {
      return body as T;
    },
  };
}

test('writer admission needs the exact physical name and a native UUID, including on recreation', async () => {
  const index = 'guard-subjects-g1';
  const metadata = (uuid: string) => ({ [index]: { settings: { index: { uuid } } } });
  expect(await readIdentityIndexIncarnation(engine(metadata('first')), index)).toBe('first');
  expect(await readIdentityIndexIncarnation(engine(metadata('second')), index)).toBe('second');
  for (const body of [
    {},
    { alias: { settings: { index: { uuid: 'first' } } } },
    { ...metadata('first'), other: {} },
    metadata(''),
    metadata('first\n'),
    { [index]: { settings: { index: { uuid: 1 } } } },
  ])
    await expect(readIdentityIndexIncarnation(engine(body), index)).rejects.toThrow();
  await expect(readIdentityIndexIncarnation(engine(metadata('first'), 206), index)).rejects.toThrow();
});

test('a guarded external-version conflict cannot settle an enrolled writer by refresh alone', async () => {
  const index = 'guard-subjects-g1';
  let refreshed = false;
  const search: OpenSearch = {
    async bulk<T>() {
      return {
        errors: true,
        items: [
          {
            delete: {
              _index: index,
              _id: 'original',
              status: 409,
              error: {
                type: 'version_conflict_engine_exception',
                reason: 'a different native write won',
                index,
                index_uuid: 'first',
                shard: '0',
              },
            },
          },
        ],
      } as T;
    },
    async request<T>() {
      refreshed = true;
      return { status: 200, body: { _shards: { total: 1, successful: 1, failed: 0 } } as T };
    },
  };
  await expect(
    writeIndexActions(search, index, [{ op: 'delete', id: 'original', version: 2n }], { rejectConflicts: true }),
  ).rejects.toBeInstanceOf(IndexWriteError);
  expect(refreshed).toBe(false);
});
