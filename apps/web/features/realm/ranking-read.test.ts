import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { rankingContractFetch, rankingContractState, rankingPersonas, rankingAuthor } from './ranking-contract-states.ts';
import { readRankingAnswer } from './ranking-read.ts';

for (const persona of rankingPersonas) {
  for (const sort of ['best', 'top'] as const) {
    for (const window of ['week', 'month', 'all'] as const) {
      test(`${persona}: ${sort}/${window} sends its exact identity and preserves the admitted answer`, async () => {
        for (const privateRealm of [false, true]) {
          const sample = rankingContractState({ persona, sort, window, privateRealm, state: 'populated' });
          const transport = rankingContractFetch(sample);
          const main = browserMainApi('https://contract.invalid', { fetcher: transport.fetcher, anonymous: persona === 'visitor' });
          const result = await readRankingAnswer(main, sample.request);
          if (sample.status === 404) expect(result).toEqual({ ok: false, failure: 'missing', status: sample.status, problem: sample.answer });
          else {
            if (!('items' in sample.answer)) throw new Error('Expected an admitted contract answer');
            expect(result).toEqual({ ok: true, data: sample.answer });
            if (!result.ok) throw new Error('Expected the admitted ranking answer');
            expect(result.data.items.every(item => item.author?.id === rankingAuthor)).toBe(true);
            expect(result.data.count).toEqual({ value: 20, kind: 'exact-page', total: null });
            expect(result.data.items[0]!.title).toContain(privateRealm ? persona === 'member' ? 'current' : 'retained' : 'public');
          }
          transport.dispose();
        }
      });
    }
  }
  test(`${persona}: final continuation and closed ranking retain their API meaning`, async () => {
    for (const state of ['continuation', 'missing'] as const) {
      const sample = rankingContractState({ persona, state, sort: 'top', window: 'month' });
      const transport = rankingContractFetch(sample);
      const result = await readRankingAnswer(browserMainApi('https://contract.invalid', { fetcher: transport.fetcher }), sample.request);
      if (state === 'missing') expect(result).toEqual({ ok: false, failure: 'missing', status: sample.status, problem: sample.answer });
      else {
        if (!('items' in sample.answer)) throw new Error('Expected a continuation contract answer');
        expect(result).toEqual({ ok: true, data: sample.answer });
      }
      transport.dispose();
    }
  });
}

test('a transferred continuation is sent as this viewer and its refusal cannot become an empty ranking', async () => {
  const sample = rankingContractState({ persona: 'stranger', state: 'invalid-cursor' });
  const transport = rankingContractFetch(sample);
  const main = browserMainApi('https://contract.invalid', { fetcher: transport.fetcher });
  expect(await readRankingAnswer(main, sample.request)).toEqual({ ok: false, failure: 'invalid', status: sample.status, problem: sample.answer });
  transport.dispose();
});

test('an expired ranking basis stays a restart; unavailable and network failures stay failures', async () => {
  for (const [state, failure] of [['moved', 'moved'], ['error', 'unavailable']] as const) {
    const sample = rankingContractState({ persona: 'member', state });
    const transport = rankingContractFetch(sample);
    expect(await readRankingAnswer(browserMainApi('https://contract.invalid', { fetcher: transport.fetcher }), sample.request))
      .toEqual({ ok: false, failure, status: sample.status, problem: sample.answer });
    transport.dispose();
  }
  const sample = rankingContractState({ persona: 'member', state: 'populated' });
  const fetcher = Object.assign(async () => { throw new TypeError('Failed to fetch'); }, { preconnect: fetch.preconnect });
  expect(await readRankingAnswer(browserMainApi('https://contract.invalid', { fetcher }), sample.request))
    .toEqual({ ok: false, failure: 'offline' });
});

test('an author withheld by Main remains withheld, while independent Work identity survives', async () => {
  const sample = rankingContractState({ persona: 'visitor', state: 'continuation' });
  if (!('items' in sample.answer)) throw new Error('Expected threads');
  sample.answer.items[0]!.author = null;
  const transport = rankingContractFetch(sample);
  const result = await readRankingAnswer(browserMainApi('https://contract.invalid', { fetcher: transport.fetcher }), sample.request);
  expect(result).toEqual({ ok: true, data: sample.answer });
  transport.dispose();
});
