import { expect, test } from 'bun:test';
import { readSearchWriterPhysicalTarget } from '../../src/search/identity-epoch-participant-physical.ts';
import { createSubjectIndex } from '../../src/search/indices.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { writeIndexActions } from '../../src/search/write-actions.ts';

const index = 'guard-subjects-g1';
const alias = `${index}-writer-${'a'.repeat(32)}`;
function engine(body: unknown): OpenSearch {
  return {
    async request<T>() {
      return { status: 200, body: body as T };
    },
    async bulk<T>() {
      return body as T;
    },
  };
}

test('writer requires its native allocation alias and rejects legacy, ambiguous and routed aliases', async () => {
  const metadata = (aliases: unknown) => ({ [index]: { settings: { index: { uuid: 'uuid' } }, aliases } });
  expect(await readSearchWriterPhysicalTarget(engine(metadata({ [alias]: { is_write_index: true } })), index)).toEqual({
    incarnation: 'uuid',
    writeAlias: alias,
  });
  for (const aliases of [
    {},
    { [alias]: {} },
    { [alias]: { is_write_index: false } },
    { [alias]: { is_write_index: true, routing: 'other' } },
    { [alias]: { is_write_index: true }, [`${index}-writer-${'b'.repeat(32)}`]: { is_write_index: true } },
    { [`${alias}\n`]: { is_write_index: true } },
  ])
    await expect(readSearchWriterPhysicalTarget(engine(metadata(aliases)), index)).rejects.toThrow();
});

test('physical allocation installs a new write alias atomically on every creation attempt', async () => {
  const aliases: string[] = [];
  const search: OpenSearch = {
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body] = args;
      expect(method).toBe('PUT');
      expect(path).toBe(`/${index}`);
      const allocation = body as { aliases: Record<string, unknown>; mappings: unknown };
      expect(allocation.mappings).toBeDefined();
      const names = Object.keys(allocation.aliases);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^guard-subjects-g1-writer-[a-f0-9]{32}$/);
      expect(allocation.aliases[names[0]!]).toEqual({ is_write_index: true });
      aliases.push(names[0]!);
      return { status: 200, body: {} as T };
    },
    async bulk<T>() {
      throw new Error('No bulk during allocation');
    },
  };
  await createSubjectIndex(search, 'guard-', 1);
  await createSubjectIndex(search, 'guard-', 1);
  expect(aliases[0]).not.toBe(aliases[1]);
});

test('guarded bulk requires its allocation alias while validating the physical receipt and all shards', async () => {
  const search: OpenSearch = {
    async bulk<T>(lines: readonly unknown[], options?: Parameters<OpenSearch['bulk']>[1]) {
      expect(lines).toEqual([{ delete: { _index: alias, _id: 'key', version: 2, version_type: 'external' } }]);
      expect(options?.query).toEqual({ require_alias: true, wait_for_active_shards: 'all', refresh: 'wait_for' });
      return {
        errors: false,
        items: [
          {
            delete: {
              _index: index,
              _id: 'key',
              _version: 2,
              _seq_no: 1,
              _primary_term: 1,
              status: 200,
              result: 'deleted',
              _shards: { total: 1, successful: 1, failed: 0 },
            },
          },
        ],
      } as T;
    },
    async request<T>() {
      throw new Error('Successful visible writes do not need another engine request');
    },
  };
  await writeIndexActions(search, index, [{ op: 'delete', id: 'key', version: 2n }], {
    rejectConflicts: true,
    writeAlias: alias,
  });
});
