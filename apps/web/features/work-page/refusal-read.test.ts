import { expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionJson from '../../../../tests/qa/fixtures/outcomes/visual-novels/collection-tracking-and-progress.json';
import devicesJson from '../../../../tests/qa/fixtures/outcomes/visual-novels/continue-progress-across-devices-two-device-progress.json';
import rankingJson from '../../../../tests/qa/fixtures/outcomes/realm/ranking.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { settle as discovery } from '../discover/read.ts';
import { settle as studio } from '../studio/read.ts';
import { settle as feed } from '../feed/types.ts';
import { booksEditionReads, settle as work, settleNullable } from './books-edition-page.read.ts';
import { booksLanguageReading } from './books-language-recorded-page.ts';

const adapters = [
  { name: 'Work', settle: work, denied: 'sign-in', moved: 'moved' },
  { name: 'nullable Work', settle: settleNullable, denied: 'sign-in', moved: 'moved' },
  { name: 'Discovery', settle: discovery, denied: 'sign-in', moved: 'moved' },
  { name: 'Studio', settle: studio, denied: 'denied', moved: 'unavailable' },
  { name: 'Feed', settle: feed, denied: 'sign-in', moved: 'moved' },
] as const;

for (const adapter of adapters) {
  for (const record of [collectionJson, devicesJson] as AnswerRecord[]) {
    for (const persona of ['visitor', 'stranger', 'owner', 'moderator', 'operator'] as const) {
      const label = persona === 'visitor' ? 'primary-get-works-progress-0'
        : persona === 'owner' ? record.row.endsWith('two-device-progress')
          ? 'primary-get-works-progress-3' : 'primary-get-works-progress-6' : 'primary-get-works-progress-1';
      test(`${adapter.name}: ${record.row}/${persona}/${label} keeps the actual refusal`, async () => {
        const sample = record.personas[persona].find(row => row.label === label)!;
        expect(sample.status).toBe(persona === 'visitor' ? 401 : 403);
        const url = new URL(sample.path, 'https://recorded.invalid');
        const replay = recordedFetch(record, persona, [{ label, state: 'error' }], { pathPrefix: BFF_PREFIX });
        const misses: unknown[] = [];
        let calls = 0;
        const main = browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor',
          fetcher: (async (...args: Parameters<typeof fetch>) => {
            calls++;
            try { return await replay.fetcher(...args); } catch (error) { misses.push(error); throw error; }
          }) as typeof fetch });
        try {
          const result = await adapter.settle(() => main.v1.works({ id: url.pathname.split('/')[3]! }).progress
            .get({ query: { actingSubject: url.searchParams.get('actingSubject')! } }));
          expect(result).toEqual({ ok: false, failure: adapter.denied, status: sample.status, problem: sample.answer });
          expect(misses).toEqual([]);
          expect(calls).toBe(1);
        } finally { replay.dispose(); }
      });
    }
  }

  for (const item of [
    { record: devicesJson as AnswerRecord, persona: 'member' as AnswerPersona, label: 'continue-contents' },
    { record: rankingJson as AnswerRecord, persona: 'owner' as AnswerPersona, label: 'moved' },
  ]) test(`${adapter.name}: recorded ${item.label} keeps the complete 404/409 answer`, async () => {
    const sample = item.record.personas[item.persona].find(row => row.label === item.label)!;
    const url = new URL(sample.path, 'https://recorded.invalid');
    const query = url.searchParams;
    const replay = recordedFetch(item.record, item.persona, [{ label: item.label, state: 'error' }], { pathPrefix: BFF_PREFIX });
    const misses: unknown[] = [];
    let calls = 0;
    const main = browserMainApi('https://recorded.invalid', { fetcher: (async (...args: Parameters<typeof fetch>) => {
      calls++;
      try { return await replay.fetcher(...args); } catch (error) { misses.push(error); throw error; }
    }) as typeof fetch });
    try {
      const result = item.label === 'continue-contents'
        ? await adapter.settle(() => main.v1.works({ id: url.pathname.split('/')[3]! }).contents.get({ query: { actingSubject: query.get('actingSubject')! } }))
        : await adapter.settle(() => main.v1.realms({ realm: url.pathname.split('/')[3]! }).threads.get({ query: {
          actingSubject: query.get('actingSubject')!, sort: 'best', window: 'all', cursor: query.get('cursor')!,
        } }));
      expect(result).toEqual({ ok: false, failure: sample.status === 404 ? 'missing' : adapter.moved,
        status: sample.status, problem: sample.answer });
      expect(misses).toEqual([]);
      expect(calls).toBe(sample.status === 409 && (adapter.name === 'Work' || adapter.name === 'Studio') ? 2 : 1);
    } finally { replay.dispose(); }
  });

  test(`${adapter.name}: transport failures and absent responses invent no HTTP problem`, async () => {
    for (const value of [new Error('transport failed'), new TypeError('Failed to fetch'), new DOMException('Aborted', 'AbortError')]) {
      const result = await adapter.settle(async () => ({ data: null, error: { status: 503, value } }));
      expect(result).toEqual({ ok: false, failure: adapter.name === 'Feed' && value instanceof TypeError ? 'offline' : 'unavailable' });
    }
    expect(await adapter.settle(async () => { throw new Error('transport failed'); }))
      .toEqual({ ok: false, failure: 'unavailable' });
    expect(await adapter.settle(async () => ({ data: null, error: null })))
      .toEqual(adapter.name === 'nullable Work' ? { ok: true, data: null } : { ok: false, failure: 'unavailable' });
    expect(await adapter.settle(async () => ({ data: { retained: 'success' }, error: null })))
      .toEqual({ ok: true, data: { retained: 'success' } });
  });
}

test('local Work sign-in prerequisites do not invent an HTTP answer', async () => {
  const main = browserMainApi('https://recorded.invalid', { fetcher: Object.assign(
    async () => { throw new Error('Unexpected request'); }, { preconnect: fetch.preconnect }) });
  const reads = booksEditionReads({ main });
  expect(await reads.readProgressSummary('work')).toEqual({ ok: false, failure: 'sign-in' });
  expect(await reads.readEditionPreference('work')).toEqual({ ok: false, failure: 'sign-in' });
});

test('the text presentation preserves a complete problem without manufacturing body fields', () => {
  const problem = { title: 'Unavailable', code: 'opaque', status: 404, detail: 'Exact detail', extension: { values: [1, null] } };
  expect(booksLanguageReading({ text: { ok: false, failure: 'missing', status: 410, problem } }))
    .toEqual({ kind: 'refused', failure: 'missing', status: 410, problem });
  const unstructured = { extension: 'opaque' };
  expect(booksLanguageReading({ text: { ok: false, failure: 'missing', status: 404, problem: unstructured } }))
    .toEqual({ kind: 'missing', status: 404, problem: unstructured });
});
