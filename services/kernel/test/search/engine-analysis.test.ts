import { expect, test } from 'bun:test';
import {
  ANALYSIS_ICU_PLUGIN,
  analyzeInstalled,
  CJK_ANALYZER,
  ENGINE_ANALYSIS_LIMITS,
  NAME_KEY_NORMALIZER,
  NAME_PREFIX_ANALYZER,
  installedAnalysisPlugins,
  requireDevelopmentAnalyzer,
  sourceSpan,
} from '../../src/search/engine-analysis.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';

function client(
  request: (
    method: Parameters<OpenSearch['request']>[0],
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: unknown }>,
): OpenSearch {
  return {
    request: request as OpenSearch['request'],
    bulk: async () => {
      throw new Error('unused');
    },
  };
}

function token(patch: Record<string, unknown> = {}) {
  return { token: 'rust', position: 0, start_offset: 0, end_offset: 4, ...patch };
}

async function analyze(body: unknown, status = 200, text = 'Ｒｕｓｔ') {
  return analyzeInstalled(
    client(async () => ({ status, body })),
    'subjects-test-1',
    { analyzer: CJK_ANALYZER, text },
  );
}

async function unavailable(run: () => Promise<unknown>) {
  const error: unknown = await run().catch((value: unknown) => value);
  expect(error).toBeInstanceOf(SearchUnavailableError);
  expect(error).not.toBeInstanceOf(OpenSearchError);
  expect(error).not.toHaveProperty('body');
  return error as SearchUnavailableError;
}

test('malformed analyzer replies are unavailable without retaining engine bodies', async () => {
  const folded = { tokens: [token()] };
  expect(await analyze(folded)).toEqual([{ token: 'rust', position: 0, startOffset: 0, endOffset: 4 }]);
  expect(sourceSpan('Ｒｕｓｔ', (await analyze(folded))[0]!)).toBe('Ｒｕｓｔ');

  await unavailable(() => analyze({ tokens: 'rust' }));
  await unavailable(() => analyze({ tokens: Array.from({ length: ENGINE_ANALYSIS_LIMITS.tokens + 1 }, token) }));
  await unavailable(() => analyze({ tokens: [token({ token: 1 })] }));
  for (const analyzer of [CJK_ANALYZER, NAME_PREFIX_ANALYZER])
    await unavailable(() =>
      analyzeInstalled(
        client(async () => ({ status: 200, body: { tokens: [token({ token: '' })] } })),
        undefined,
        {
          analyzer,
          text: 'rust',
        },
      ),
    );
  expect(
    await analyzeInstalled(
      client(async () => ({ status: 200, body: { tokens: [token({ token: '' })] } })),
      undefined,
      {
        normalizer: NAME_KEY_NORMALIZER,
        text: '\u200B'.repeat(4),
      },
    ),
  ).toEqual([{ token: '', position: 0, startOffset: 0, endOffset: 4 }]);
  await unavailable(() => analyze({ tokens: [token({ token: '\uD800' })] }));
  await unavailable(() => analyze({ tokens: [token({ position: -1 })] }));
  await unavailable(() => analyze({ tokens: [token({ start_offset: 2, end_offset: 2 })] }));
  await unavailable(() => analyze({ tokens: [token({ start_offset: 0, end_offset: 99 })] }));
  await unavailable(() => analyze({ tokens: [token({ start_offset: 1, end_offset: 2 })] }, 200, '\uD83D\uDE00'));
  await unavailable(() => analyze(folded, 201));
  const secret = { error: { type: 'illegal_argument_exception', reason: 'index-internal' } };
  const wrapped = await unavailable(() =>
    analyzeInstalled(
      client(async () => {
        throw new OpenSearchError(400, secret);
      }),
      'subjects-test-1',
      { analyzer: CJK_ANALYZER, text: 'Ｒｕｓｔ' },
    ),
  );
  expect(wrapped.message).toBe('OpenSearch analysis returned HTTP 400');
  expect(JSON.stringify(wrapped)).not.toContain('index-internal');
});

test('plugin inventory and development analyzer refuse malformed third-party replies', async () => {
  await unavailable(() =>
    installedAnalysisPlugins(
      client(async () => ({ status: 200, body: [{ component: ANALYSIS_ICU_PLUGIN }, { component: 1 }] })),
    ),
  );
  await unavailable(() =>
    requireDevelopmentAnalyzer(client(async () => ({ status: 200, body: { version: { number: '2.19.0' } } }))),
  );
  const calls: string[] = [];
  const version = await requireDevelopmentAnalyzer(
    client(async (method, path, body) => {
      calls.push(`${method} ${path}`);
      if (path === '/') return { status: 200, body: { version: { number: '3.9.0' } } };
      if (path === '/_cat/plugins') return { status: 200, body: [{ component: ANALYSIS_ICU_PLUGIN }] };
      expect(method).toBe('POST');
      expect(path).toBe('/_analyze');
      expect(body).toMatchObject({ tokenizer: 'icu_tokenizer', filter: ['icu_folding'], text: 'Ｒｕｓｔ' });
      return { status: 200, body: { tokens: [token()] } };
    }),
  );
  expect(version).toEqual({ version: '3.9.0' });
  expect(calls).toEqual(['GET /', 'GET /_cat/plugins', 'POST /_analyze']);
});
