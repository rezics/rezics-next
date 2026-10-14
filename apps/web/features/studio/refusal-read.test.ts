import { expect, test } from 'bun:test';
import { settle, readStudioText } from './read.ts';
import type { MainClient } from './types.ts';

test.each([401, 403, 404, 409])('Studio retains complete HTTP %s problems with its presentation category', async status => {
  const problem = { type: 'about:blank', status, code: 'refused', title: 'Refused', detail: 'Exact reason', extra: { opaque: ['x', 7] } };
  let calls = 0;
  const actual = await settle(async () => { calls++; return { data: null, error: { status, value: problem } }; });
  expect(actual).toEqual({ ok: false, failure: status === 401 || status === 403 ? 'denied' : status === 404 ? 'missing' : 'unavailable', status, problem });
  expect(calls).toBe(status === 409 ? 2 : 1);
});

test('the second answer after the existing one-time 409 retry survives unchanged', async () => {
  const problem = { status: 403, code: 'authority_denied', title: 'Withdrawn', currentHead: null, extensions: [1, 'two'] };
  let calls = 0;
  const actual = await settle(async () => ({ data: null, error: ++calls === 1
    ? { status: 409, value: { code: 'read_moved' } } : { status: 403, value: problem } }));
  expect(actual).toEqual({ ok: false, failure: 'denied', status: 403, problem });
  expect(calls).toBe(2);
});

test('a text without a fallback head keeps the original read problem', async () => {
  const problem = { status: 404, title: 'Concealed', code: 'not_found', custom: 'retained' };
  const main = { v1: { contributions: () => ({ get: async () => ({ data: null, error: { status: 404, value: problem } }) }) } } as unknown as MainClient;
  expect((await readStudioText('actor', 'text', null, main)).draft).toEqual({ ok: false, failure: 'missing', status: 404, problem });
});

test('unchanged anonymous export and concealed draft refusals retain their complete recorded answers', async () => {
  const { default: exchangeJson } = await import('../../../../tests/qa/fixtures/outcomes/recipes/exchange-recipes.json');
  const { default: authoringJson } = await import('../../../../tests/qa/fixtures/outcomes/recipes/author-a-recipe.json');
  const { BFF_PREFIX, browserMainApi } = await import('../api/browser.ts');
  const { recordedFetch } = await import('../stories/recorded-fetch.ts');
  const cases = [
    { record: exchangeJson, persona: 'visitor' as const, label: 'export-authentication-required' },
    { record: authoringJson, persona: 'member' as const, label: 'draft-concealed' },
  ];
  for (const item of cases) {
    const record = item.record as import('../../../../scripts/api/answer-record.ts').AnswerRecord;
    const sample = record.personas[item.persona].find(row => row.label === item.label)!;
    const url = new URL(sample.path, 'https://recorded.invalid');
    const pieces = url.pathname.split('/');
    const actingSubject = url.searchParams.get('actingSubject')!;
    const replay = recordedFetch(record, item.persona, [{ label: item.label, state: 'error' }], { pathPrefix: BFF_PREFIX });
    const misses: unknown[] = [];
    const main = browserMainApi('https://recorded.invalid', { anonymous: item.persona === 'visitor', fetcher: (async (...args: Parameters<typeof fetch>) => {
      try { return await replay.fetcher(...args); } catch (error) { misses.push(error); throw error; }
    }) as typeof fetch });
    try {
      const result = item.persona === 'visitor'
        ? await settle(() => main.v1.recipes({ id: pieces[3]! }).exports['schema-org'].get({ query: {
          actingSubject, revision: url.searchParams.get('revision')!,
        } }))
        : await settle(() => main.v1.compositions({ id: pieces[3]! }).revisions({ revision: pieces[5]! }).get({ query: { actingSubject } }));
      expect(result).toEqual({ ok: false, failure: item.persona === 'visitor' ? 'denied' : 'missing',
        status: sample.status, problem: sample.answer });
      expect(misses).toEqual([]);
    } finally { replay.dispose(); }
  }
});
