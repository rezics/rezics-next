import { afterAll, beforeAll, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import { createCurrentTextMatcher, CURRENT_TEXT_LIMITS } from '../../src/search/disclosure/current-text.ts';
import { analyzeInstalled, requireDevelopmentAnalyzer } from '../../src/search/engine-analysis.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { parseText } from '../../src/search/text.ts';
import type { HttpResponse, Subject } from '../../../../specs/semantic-driver.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../support/released-discovery.ts';

let fixture: ReleasedDiscoveryFixture;
let pool: Pool;
const search = createOpenSearch(process.env.OPENSEARCH_URL!);
const cap = CURRENT_TEXT_LIMITS.scanBytes;
const label = 'capanchor';
const late = 'zebralate quartzsignal';
const languages = ['de', 'en', 'es', 'fr', 'it'];

// Every alias is legal native text (under 250 characters, at most 32 per language).
// Multibyte filler makes the boundary a UTF-8 byte boundary rather than a character count.
function terms(field: 'alias' | 'description') {
  const aliases: Record<string, string[]> = {};
  for (let index = 0; index < 129; index++)
    (aliases[languages[Math.floor(index / 32)]!] ??= []).push(`${String(index).padStart(3, '0')}${'界'.repeat(82)}x`);
  const used =
    2 +
    Buffer.byteLength(label) +
    Object.entries(aliases).reduce(
      (sum, [language, values]) =>
        sum + values.reduce((bytes, value) => bytes + Buffer.byteLength(language + value), 0),
      0,
    );
  const tail = late + ' ' + 'x'.repeat(cap - used - 3 - late.length);
  if (field === 'alias') aliases.zh = [tail];
  return { labels: { en: label }, aliases, descriptions: field === 'description' ? { en: tail } : {}, tail };
}

beforeAll(async () => {
  fixture = await createReleasedDiscoveryFixture({
    version: 1,
    search: 'native',
    kernelPool(url) {
      pool = createPool(url);
      return pool;
    },
  });
  await fixture.setup.openFeatures(['search', 'search_advanced']);
  await requireDevelopmentAnalyzer(search);
}, 120_000);
afterAll(async () => {
  if (fixture) await fixture.close();
}, 180_000);

function status(response: HttpResponse, expected: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response;
}
async function ready(body: unknown): Promise<HttpResponse> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fixture.request('anonymous', 'POST', '/v1/subjects:search', body);
    if (response.status === 200) return response;
    status(response, 503);
    expect(['index_not_ready', 'semantic_not_ready']).toContain(response.body.code);
    if (Date.now() >= deadline) throw new Error(`Current Search never became ready: ${JSON.stringify(response.body)}`);
    await Bun.sleep(25);
  }
}

// A refusal before analysis is a failing witness, even if it has the expected HTTP status.
async function analyzedRefusal(index: string, request: () => Promise<HttpResponse>) {
  const gate = fixture.search!.barrier({ phase: 'request', method: 'POST', path: `/${index}/_analyze` });
  const response = request();
  try {
    await Promise.race([
      gate.reached,
      response.then(() => {
        throw new Error('Request returned before current analysis');
      }),
    ]);
  } finally {
    gate.release();
  }
  const result = status(await response, 503);
  expect(result.body.code).toBe('index_not_ready');
  for (const key of ['subjects', 'facets', 'kinds', 'next', 'total', 'count'])
    expect(result.body).not.toHaveProperty(key);
}

test('native current text keeps cap-plus-one uncertainty through disclosure, Search continuation and prefix', async () => {
  const records: { subject: CreatedSubject; field: 'alias' | 'description'; input: ReturnType<typeof terms> }[] = [];
  for (const field of ['alias', 'description'] as const) {
    const input = terms(field);
    const created = status(
      await fixture.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Book',
          labels: input.labels,
          aliases: input.aliases,
          descriptions: input.descriptions,
        },
        discoveryKey(),
      ),
      201,
    ).body.subject as Subject;
    records.push({ subject: { id: created.id, release: created.release, revision: created.revision }, field, input });
  }
  await fixture.catchUp(records.map(({ subject }) => subject));
  const prefix = fixture.search!.indexPrefix;
  const { active } = await subjectGenerations(search, prefix);
  assert(active !== null);
  const index = subjectIndexName(prefix, active);
  const source = subjectSource(pool);
  const observed: string[] = [];
  const matcher = createCurrentTextMatcher(async (analyzer, text) => {
    observed.push(text);
    return analyzeInstalled(search, index, { analyzer, text });
  });
  const current = async (subject: CreatedSubject) => {
    const snapshot = await source.read(subjectPartition(subject.id), [subject.id]);
    assert(snapshot.subjects.length === 1);
    return snapshot.subjects[0]!;
  };
  for (const { subject } of records) {
    const native = await current(subject);
    const bytes = [...native.labels, ...native.aliases, ...native.descriptions].reduce(
      (sum, value) => sum + Buffer.byteLength(value.language + value.value),
      0,
    );
    expect(bytes).toBe(cap);
    expect(await matcher.matchesText(native, parseText('zebralate'))).toBe(true);
    expect(await matcher.matchesText(native, parseText('"zebralate quartzsignal"'))).toBe(true);
    expect(await matcher.matchesText(native, parseText('neverpresent'))).toBe(false);
  }
  expect(await matcher.matchesPrefix(await current(records[0]!.subject), 'zebral')).toBe(true);
  const first = await ready({ text: 'zebralate', sort: 'id', limit: 1 });
  assert(typeof first.body.next === 'string');
  const suggested = status(await fixture.request('anonymous', 'GET', '/v1/subjects:suggest?q=zebral'), 200);
  expect(suggested.body.subjects).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: records[0]!.subject.id })]),
  );

  await fixture.search!.indexing('paused');
  for (const { subject, field, input } of records) {
    status(
      await fixture.request(
        'editor',
        'PATCH',
        `/v1/subjects/${subject.id}/terms`,
        field === 'alias' ? { aliases: { zh: [input.tail + 'x'] } } : { descriptions: { en: input.tail + 'x' } },
        { ...discoveryKey(), 'If-Match': `"${subject.revision}"` },
      ),
      200,
    );
    const native = await current(subject);
    expect(
      [...native.labels, ...native.aliases, ...native.descriptions].reduce(
        (sum, value) => sum + Buffer.byteLength(value.language + value.value),
        0,
      ),
    ).toBe(cap + 1);
    const hit = {
      id: native.id,
      partition: subjectPartition(native.id),
      securityRevision: native.securityRevision,
      matched: [],
    };
    observed.length = 0;
    for (const query of ['zebralate', '"zebralate quartzsignal"', '-zebralate']) {
      const checked = await checkHits(source, [hit], new Map(), {
        currentText: (value) => matcher.matchesText(value, parseText(query)),
      });
      expect(checked.passed).toEqual([]);
      expect(checked.textRejected).toBe(true);
    }
    expect(observed).not.toContain(input.tail + 'x');
    expect(await matcher.matchesText(native, parseText('capanchor | zebralate'))).toBe(true);
    expect(await matcher.matchesText(native, parseText('-capanchor zebralate'))).toBe(false);
    const checkedPrefix = await checkHits(source, [hit], new Map(), {
      currentText: (value) => matcher.matchesPrefix(value, 'zebral'),
    });
    expect(checkedPrefix.passed).toEqual([]);
    expect(checkedPrefix.textRejected === true).toBe(field === 'alias');
  }
  for (const body of [
    { text: 'zebralate' },
    { text: '"zebralate quartzsignal"' },
    { text: 'capanchor -neverpresent' },
    { text: 'zebralate', sort: 'id', limit: 1, cursor: first.body.next },
  ])
    await analyzedRefusal(index, () => fixture.request('anonymous', 'POST', '/v1/subjects:search', body));
  await analyzedRefusal(index, () => fixture.request('anonymous', 'GET', '/v1/subjects:suggest?q=zebral'));
}, 180_000);
