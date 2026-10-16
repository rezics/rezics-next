import { expect, test } from 'bun:test';
import type { AnswerRecord } from '../../../../scripts/api/answer-record.ts';
import collectionJson from '../../../../tests/qa/fixtures/outcomes/visual-novels/collection-tracking-and-progress.json';
import devicesJson from '../../../../tests/qa/fixtures/outcomes/visual-novels/continue-progress-across-devices-two-device-progress.json';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { mainMediaApi } from './media-api.ts';

for (const record of [collectionJson, devicesJson] as AnswerRecord[]) {
  for (const persona of ['visitor', 'stranger', 'owner', 'moderator', 'operator'] as const) {
    const label = persona === 'visitor' ? 'primary-get-works-progress-0'
      : persona === 'owner' ? record.row.endsWith('two-device-progress')
        ? 'primary-get-works-progress-3' : 'primary-get-works-progress-6' : 'primary-get-works-progress-1';
    test(`${record.row}/${persona}/${label}: workStanding retains the actual foreign-person refusal without retry`, async () => {
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
        const api = mainMediaApi(url.searchParams.get('actingSubject')!, () => main);
        const work = url.pathname.split('/')[3]!;
        expect(await api.workStanding(work))
          .toEqual({ ok: false, failure: 'sign-in', status: sample.status, problem: sample.answer });
        expect(misses).toEqual([]);
        expect(calls).toBe(1);
      } finally { replay.dispose(); }
    });
  }
}
