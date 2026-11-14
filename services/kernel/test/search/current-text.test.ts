import { expect, test } from 'bun:test';
import { createCurrentTextDisclosure, CURRENT_TEXT_LIMITS } from '../../src/search/current-text-adapter.ts';
import { CJK_ANALYZER, ENGINE_ANALYSIS_LIMITS, NAME_PREFIX_ANALYZER } from '../../src/search/engine-analysis.ts';
import { OpenSearchError, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { parseText } from '../../src/search/text.ts';
import { RELEASED_NAME_ID, releasedMultilingualSubject } from './support/released-names.ts';

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

function tokens(texts: readonly string[]) {
  const result: { token: string; position: number; start_offset: number; end_offset: number }[] = [];
  let position = 0;
  let offset = 0;
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    for (const match of text.matchAll(/\S+/gu)) {
      const start = match.index!;
      const value = match[0]!;
      result.push({
        token: value.normalize('NFKC').toLowerCase(),
        position: position++,
        start_offset: offset + start,
        end_offset: offset + start + value.length,
      });
    }
    offset += text.length + (i + 1 < texts.length ? 1 : 0);
  }
  return result;
}

function analyzing(onAnalyze?: (analyzer: string, texts: readonly string[]) => void): OpenSearch {
  return client(async (method, path, body) => {
    expect(method).toBe('POST');
    expect(path).toBe('/subjects-test-1/_analyze');
    const request = body as { analyzer: string; text: readonly string[] };
    onAnalyze?.(request.analyzer, request.text);
    return { status: 200, body: { tokens: tokens(request.text) } };
  });
}

test('current-text analyzer concurrency is the installed owner limit', () => {
  expect(CURRENT_TEXT_LIMITS.concurrency).toBe(ENGINE_ANALYSIS_LIMITS.concurrency);
});

test('current-text uses the queried generation analyzers for terms, phrases and prefixes', async () => {
  const seen: string[] = [];
  const disclosure = createCurrentTextDisclosure(
    analyzing((analyzer, texts) => seen.push(analyzer + ':' + texts.join('|'))),
    'subjects-test-1',
  );
  const subject = releasedMultilingualSubject({
    aliases: [{ language: 'und', value: 'Shutage' }],
    descriptions: [{ language: 'en', value: 'science adventure' }],
    statements: [],
  });
  expect(await disclosure.matchesText(subject, parseText('shutage'))).toBe(true);
  expect(await disclosure.matchesText(subject, parseText('"science adventure"'))).toBe(true);
  expect(await disclosure.matchesText(subject, parseText('shutage -shutage'))).toBe(false);
  expect(await disclosure.matchesText(subject, parseText('魔法禁書目錄外伝'))).toBe(false);
  expect(await disclosure.matchesPrefix(subject, 'Shut')).toBe(true);
  expect(await disclosure.matchesPrefix(subject, '命运')).toBe(false);
  expect(seen.some((entry) => entry.startsWith(`${CJK_ANALYZER}:`))).toBe(true);
  expect(seen.some((entry) => entry.startsWith(`${NAME_PREFIX_ANALYZER}:`))).toBe(true);
});

test('current names, descriptions and query leaves share bounded batches without crossing phrase values', async () => {
  const calls: { analyzer: string; texts: readonly string[] }[] = [];
  const aliases = [
    ...Array.from({ length: 2_500 }, (_, index) => ({
      language: 'und',
      value: 'alias' + String(index).padStart(4, '0'),
    })),
    { language: 'en', value: 'alias0000' },
    { language: 'en', value: 'red' },
    { language: 'fr', value: 'lantern' },
  ];
  const subject = releasedMultilingualSubject({
    labels: [],
    aliases,
    descriptions: [{ language: 'en', value: 'soft blue' }],
    statements: [],
  });
  const disclosure = createCurrentTextDisclosure(
    analyzing((analyzer, texts) => calls.push({ analyzer, texts })),
    'subjects-test-1',
  );

  expect(await disclosure.matchesText(subject, parseText('"red lantern"'))).toBe(false);
  expect(await disclosure.matchesText(subject, parseText('"soft blue"'))).toBe(true);
  expect(await disclosure.matchesText(subject, parseText('alias2499'))).toBe(true);
  expect(await disclosure.matchesPrefix(subject, 'alias2499')).toBe(true);

  const currentCalls = calls.filter(({ analyzer }) => analyzer === CJK_ANALYZER);
  const prefixCalls = calls.filter(({ analyzer }) => analyzer === NAME_PREFIX_ANALYZER);
  expect(currentCalls.length).toBeLessThanOrEqual(CURRENT_TEXT_LIMITS.batchesPerSubject);
  expect(prefixCalls.length).toBeLessThanOrEqual(CURRENT_TEXT_LIMITS.batchesPerSubject);
  for (const { texts } of [...currentCalls, ...prefixCalls]) {
    const bytes = texts.reduce((total, text) => total + Buffer.byteLength(text, 'utf8'), 0);
    expect(bytes <= CURRENT_TEXT_LIMITS.batchBytes || texts.length === 1).toBe(true);
  }
  const submitted = currentCalls.flatMap(({ texts }) => texts);
  expect(submitted).toContain('soft blue');
  expect(submitted).toContain('red lantern');
  expect(submitted.filter((text) => text === 'alias0000')).toHaveLength(1);
  expect(submitted.filter((text) => text.startsWith('alias'))).toHaveLength(2_500);
});

test('malformed analyzer replies stay unavailable, and omitted names remain unproven', async () => {
  const disclosure = createCurrentTextDisclosure(
    client(async () => {
      throw new OpenSearchError(400, { error: { reason: 'generation-internal' } });
    }),
    'subjects-test-1',
  );
  const error: unknown = await disclosure
    .matchesText(releasedMultilingualSubject({ id: RELEASED_NAME_ID }), parseText('shutage'))
    .catch((value: unknown) => value);
  expect(error).toBeInstanceOf(SearchUnavailableError);
  expect(error).not.toHaveProperty('body');
  expect(JSON.stringify(error)).not.toContain('generation-internal');

  const emptyToken = createCurrentTextDisclosure(
    client(async () => ({
      status: 200,
      body: { tokens: [{ token: '', position: 0, start_offset: 0, end_offset: 1 }] },
    })),
    'subjects-test-1',
  );
  await expect(emptyToken.matchesPrefix(releasedMultilingualSubject(), 'absent')).rejects.toBeInstanceOf(
    SearchUnavailableError,
  );
  await expect(emptyToken.matchesText(releasedMultilingualSubject(), parseText('absent'))).rejects.toBeInstanceOf(
    SearchUnavailableError,
  );

  const analyzed: string[] = [];
  const bounded = createCurrentTextDisclosure(
    analyzing((_analyzer, texts) => analyzed.push(...texts)),
    'subjects-test-1',
  );
  const bulky = 'x'.repeat(CURRENT_TEXT_LIMITS.scanBytes - 4);
  expect(
    await bounded.matchesText(
      releasedMultilingualSubject({
        labels: [],
        aliases: [
          { language: 'und', value: bulky },
          { language: 'und', value: 'Shutage' },
        ],
        descriptions: [],
        statements: [],
      }),
      parseText('shutage'),
    ),
  ).toBe('not_proven');
  expect(analyzed).toContain('shutage');
  expect(analyzed).toContain(bulky);
  expect(analyzed).not.toContain('Shutage');
});

test('coverage preserves witnesses and decisive Boolean operands without certifying capped absence', async () => {
  const matcher = createCurrentTextDisclosure(analyzing(), 'subjects-test-1');
  const complete = releasedMultilingualSubject({
    labels: [{ language: 'en', value: 'Shutage' }],
    aliases: [],
    descriptions: [],
    statements: [],
  });
  const capped = { ...complete, aliases: [{ language: 'en', value: 'x'.repeat(CURRENT_TEXT_LIMITS.scanBytes) }] };
  for (const [query, expected] of [
    ['shutage', true],
    ['absent', 'not_proven'],
    ['"late phrase"', 'not_proven'],
    ['-absent', 'not_proven'],
    ['shutage absent', 'not_proven'],
    ['-shutage absent', false],
    ['shutage | absent', true],
    ['-shutage | absent', 'not_proven'],
    ['-(shutage | absent)', false],
    ['-(-shutage absent)', true],
  ] as const)
    expect(await matcher.matchesText(capped, parseText(query))).toBe(expected);
  expect(await matcher.matchesText(complete, parseText('absent'))).toBe(false);
  expect(await matcher.matchesText(complete, parseText('-absent'))).toBe(true);
  expect(await matcher.matchesPrefix(capped, 'Shut')).toBe(true);
  expect(await matcher.matchesPrefix(capped, 'absent')).toBe('not_proven');
  expect(await matcher.matchesPrefix(complete, 'absent')).toBe(false);
  const descriptionsOnly = { ...complete, descriptions: capped.aliases };
  expect(await matcher.matchesText(descriptionsOnly, parseText('absent'))).toBe('not_proven');
  expect(await matcher.matchesPrefix(descriptionsOnly, 'absent')).toBe(false);
});
