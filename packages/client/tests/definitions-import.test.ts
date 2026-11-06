import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '../src/index.ts';

type ImportPost = KernelClient['definitions'] extends { imports: { post: infer Post } } ? Post : never;
expectTypeOf<ImportPost>().not.toBeNever();
expectTypeOf<Parameters<ImportPost>[0]>().toMatchTypeOf<{
  document: unknown;
  context?: string;
  expected_head?: number | null;
}>();

test('the installed client posts definitions.import to /v1/definitions/imports', async () => {
  const sent: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(`${init?.method ?? 'GET'} ${String(input instanceof Request ? input.url : input)}`);
    return Response.json({
      kind: 'invalid',
      identity: null,
      diagnostics: [],
      comparison: null,
      types: [],
      current: null,
      reconciliation: null,
      operations: {
        grant: 'definition_publication',
        admitted: true,
        publish: true,
        activate: true,
        build: true,
      },
      document: null,
    });
  }) as typeof globalThis.fetch;
  const client = createKernelClient('http://kernel.test', { fetch });
  const result = await client.definitions.imports.post({ document: { types: {} } });
  expect(sent).toEqual(['POST http://kernel.test/v1/definitions/imports']);
  expect(result.status).toBe(200);
  expect(result.data?.operations.grant).toBe('definition_publication');
});
