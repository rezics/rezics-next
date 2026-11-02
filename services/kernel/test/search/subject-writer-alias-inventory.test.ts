import { expect, test } from 'bun:test';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { nativeSubjectResolveEnvelope } from './support/native-metadata.ts';

const prefix = 'probe-';
const first = subjectIndexName(prefix, 1);
const second = subjectIndexName(prefix, 2);
const writer1 = `${first}-writer-${'a'.repeat(32)}`;
const writer2 = `${second}-writer-${'b'.repeat(32)}`;

function engine(body: unknown, put?: (path: string, payload: unknown) => void): OpenSearch {
  return {
    async request<T>(method, path, payload) {
      if (method === 'PUT') {
        put?.(path, payload);
        return { status: 200, body: {} as T };
      }
      expect({ method, path }).toEqual({ method: 'GET', path: `/_resolve/index/${prefix}subjects*` });
      return { status: 200, body: body as T };
    },
    async bulk() {
      throw new Error('Inventory does not bulk');
    },
  };
}

test('a Subject generation allocated with its physical writer alias remains discoverable before and after public alias activation', async () => {
  const allocated = new Map<number, string>();
  let active: number | null = null;
  const search: OpenSearch = {
    async request<T>(method, path, payload) {
      if (method === 'PUT') {
        const generation = Number(/-g([1-9][0-9]*)$/.exec(path)?.[1]);
        const names = Object.keys((payload as { aliases: Record<string, unknown> }).aliases);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(new RegExp(`^${subjectIndexName(prefix, generation)}-writer-[a-f0-9]{32}$`));
        allocated.set(generation, names[0]!);
        return { status: 200, body: {} as T };
      }
      expect({ method, path }).toEqual({ method: 'GET', path: `/_resolve/index/${prefix}subjects*` });
      return {
        status: 200,
        body: nativeSubjectResolveEnvelope(
          prefix,
          [...allocated.entries()].map(([generation, writer]) => ({ generation, writer })),
          active,
        ) as T,
      };
    },
    async bulk() {
      throw new Error('Inventory does not bulk');
    },
  };

  await createSubjectIndex(search, prefix, 1);
  expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1], active: null });
  active = 1;
  expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1], active: 1 });
  await createSubjectIndex(search, prefix, 2);
  await createSubjectIndex(search, prefix, 3);
  expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2, 3], active: 1 });
});

test('malformed, foreign, duplicate and oversized writer inventories fail closed', async () => {
  const valid = nativeSubjectResolveEnvelope(
    prefix,
    [
      { generation: 1, writer: writer1 },
      { generation: 2, writer: writer2 },
    ],
    1,
  );
  const legacy = nativeSubjectResolveEnvelope(prefix, [{ generation: 1 }, { generation: 2, writer: writer2 }], 1);
  expect(await subjectGenerations(engine(legacy), prefix)).toEqual({ generations: [1, 2], active: 1 });
  expect(await subjectGenerations(engine(valid), prefix)).toEqual({ generations: [1, 2], active: 1 });

  const cases: [string, (body: typeof valid) => void][] = [
    ['duplicate physical writer', (body) => (body.indices[0]!.aliases = [writer1, writer1])],
    ['duplicate writer receipt', (body) => body.aliases.push(structuredClone(body.aliases[0]!))],
    ['uppercase writer id', (body) => (body.indices[0]!.aliases![0] = `${first}-writer-${'A'.repeat(32)}`)],
    ['foreign alias', (body) => body.aliases.push({ name: 'foreign-subjects', indices: [first] })],
    [
      'cross-generation writer',
      (body) => {
        body.indices[1]!.aliases = [writer1];
        body.aliases[0]!.indices = [second];
      },
    ],
    [
      'oversized generations',
      (body) =>
        body.indices.push(
          { name: subjectIndexName(prefix, 3), attributes: ['open'] },
          { name: subjectIndexName(prefix, 4), attributes: ['open'] },
        ),
    ],
    ['oversized physical aliases', (body) => body.indices[0]!.aliases!.push('extra-subjects')],
    ['writer receipt without physical membership', (body) => (body.indices[0]!.aliases = [subjectAlias(prefix)])],
  ];
  for (const [name, edit] of cases) {
    const body = structuredClone(valid);
    edit(body);
    await expect(subjectGenerations(engine(body), prefix), name).rejects.toBeInstanceOf(SearchUnavailableError);
  }
});
