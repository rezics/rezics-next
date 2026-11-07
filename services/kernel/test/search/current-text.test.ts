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

function tokens(text: string) {
  const folded = text.trim().toLowerCase();
  if (!folded) return [];
  return [{ token: folded, position: 0, start_offset: 0, end_offset: text.length }];
}

function analyzing(onAnalyze?: (analyzer: string, text: string) => void): OpenSearch {
  return client(async (method, path, body) => {
    expect(method).toBe('POST');
    expect(path).toBe('/subjects-test-1/_analyze');
    const request = body as { analyzer: string; text: string };
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
    analyzing((analyzer, text) => seen.push(`${analyzer}:${text}`)),
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

test('malformed analyzer replies stay unavailable, and native scan truncation keeps later names out', async () => {
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

  const analyzed: string[] = [];
  const bounded = createCurrentTextDisclosure(
    analyzing((_analyzer, text) => analyzed.push(text)),
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
  ).toBe(false);
  expect(analyzed).toContain('shutage');
  expect(analyzed).toContain(bulky);
  expect(analyzed).not.toContain('Shutage');
});
