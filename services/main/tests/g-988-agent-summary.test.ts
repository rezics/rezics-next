import { expect, test } from 'bun:test';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { readResourceSummaries } from '../src/modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../src/modules/media/store.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const literal = (value: string) => ({ type: 'literal', value });

async function summary(value: string, options: { language?: string; erased?: boolean } = {}) {
  const queries: string[] = [];
  const bindings: NonNullable<SparqlResult['results']>['bindings'] = [
    {
      epoch: literal('epoch'),
      sequence: literal('7'),
      r: { type: 'uri', value: agent },
      type: literal('agent'),
      public: literal('true'),
      label: { ...literal(value), ...(options.language ? { 'xml:lang': options.language } : {}) },
      ...(options.erased ? { erased: literal('true') } : {}),
    },
  ];
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    fuseki: {
      query: async (query: string) => {
        queries.push(query);
        return { results: { bindings } };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const result = await readResourceSummaries(
    env,
    undefined,
    {},
    {
      resources: [agent],
      context: DEFAULT_MEDIA_CONTEXT,
      language: 'zh-Hant',
    },
  );
  return { result, queries };
}

for (const [value, direction] of [
  ['Local author', 'ltr'],
  ['讀者', 'ltr'],
  ['قارئ', 'rtl'],
] as const) {
  test(`G-988: provisioned public Agent names without a language remain addressable (${value})`, async () => {
    const { result, queries } = await summary(value);
    expect(result.summaries[0]).toMatchObject({
      reference: agent,
      status: 'available',
      type: 'agent',
      disclosure: 'public',
      name: { value, language: '', direction, basis: 'fallback' },
      address: { prefix: '/a/', slugSource: value },
    });
    expect(queries).toHaveLength(1);
    expect(result.cost).toMatchObject({ graphQueries: 1, accessChecks: 0 });
    expect(queries[0]).toContain('rv:profileDisclosure rv:Private');
    expect(queries[0]).toContain('rv:protectionHead ?agentProtection');
  });
}

test('G-988: an explicitly tagged Agent name retains its stored language', async () => {
  const { result } = await summary('讀者', { language: 'zh-Hant' });
  expect(result.summaries[0]).toMatchObject({
    status: 'available',
    name: { value: '讀者', language: 'zh-Hant', basis: 'requested' },
  });
});

test('G-988: accepting an untagged Agent name does not revive an erased Agent', async () => {
  const { result } = await summary('Local author', { erased: true });
  expect(result.summaries).toEqual([{ reference: agent, status: 'unavailable' }]);
});
