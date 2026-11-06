import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type ImportedPreview, type KernelClient } from '../src/index.ts';

type ImportPost = KernelClient['definitions'] extends { imports: { post: infer Post } } ? Post : never;
expectTypeOf<ImportPost>().not.toBeNever();
expectTypeOf<Parameters<ImportPost>[0]>().toMatchTypeOf<{
  document: unknown;
  context?: string;
  expected_head?: number | null;
}>();
expectTypeOf<NonNullable<Awaited<ReturnType<ImportPost>>['data']>>().toEqualTypeOf<ImportedPreview>();
expectTypeOf<ImportedPreview>().toMatchTypeOf<{
  kind: 'release' | 'sources' | 'extension' | 'invalid';
  identity: { digest: string; version: string | null; format: string } | null;
  diagnostics: { pointer: string; code: string; file: string | null }[];
  comparison:
    | {
        addedTypes: string[];
        removedTypes: string[];
        changedTypes: string[];
        addedProperties: string[];
        removedProperties: string[];
        changedProperties: string[];
      }
    | { addedTerms: string[]; removedTerms: string[]; changedTerms: string[] }
    | null;
  types: { id: string }[];
  current: { digest: string; head: number } | null;
  reconciliation: { intended: string; current: { digest: string; head: number } | null; stale: boolean } | null;
  operations: {
    grant: 'definition_publication';
    admitted: boolean;
    publish: boolean;
    activate: boolean;
    build: boolean;
  };
  document: { types?: unknown } | { terms?: unknown } | null;
}>();

const preview = {
  kind: 'invalid' as const,
  identity: null,
  diagnostics: [] as ImportedPreview['diagnostics'],
  comparison: null,
  types: [] as ImportedPreview['types'],
  current: null,
  reconciliation: null,
  operations: {
    grant: 'definition_publication' as const,
    admitted: true,
    publish: true,
    activate: true,
    build: true,
  },
  document: null,
};

test('the installed client posts definitions.import to /v1/definitions/imports', async () => {
  const sent: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${init?.method ?? 'GET'} ${String(input instanceof Request ? input.url : input)}`);
    return Response.json(preview);
  }) as typeof globalThis.fetch;
  const client = createKernelClient('http://kernel.test', { fetch });
  const result = await client.definitions.imports.post({ document: { types: {} } });
  expect(sent).toEqual(['POST http://kernel.test/v1/definitions/imports']);
  expect(result.status).toBe(200);
  const data = result.data as ImportedPreview;
  expect(data.kind).toBe('invalid');
  expect(data.identity).toBeNull();
  expect(data.diagnostics).toEqual([]);
  expect(data.comparison).toBeNull();
  expect(data.types).toEqual([]);
  expect(data.current).toBeNull();
  expect(data.reconciliation).toBeNull();
  expect(data.document).toBeNull();
  expect(data.operations.grant).toBe('definition_publication');
  expect(data.operations.admitted).toBe(true);
});
