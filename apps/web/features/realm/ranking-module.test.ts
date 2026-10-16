import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { resourceHref } from '../address/path.ts';
import { loadRankingsModule, rankingModuleReads } from './modules.ts';
import { rankingRealm } from './ranking-contract-states.ts';
import { rankingIntervals, rankingModule, rankingModuleContractCards, rankingModuleContractFetch,
  rankingModuleContractPage } from './ranking-module-contract-states.ts';
import { readRankingModuleAnswer } from './ranking-read.ts';
import { zoneWork } from './adapt.ts';

test('all displayed chart Works get cards beyond the first Realm window, in bounded target batches', async () => {
  const context = { realm: rankingRealm, ref: 'ranking-garden', locale: 'en' as const };
  const works = Array.from({ length: 30 }, (_, index) => {
    const sample = rankingModuleContractPage('day', 'populated').items[0]!;
    const id = `https://rezics.com/id/${String(index + 100).padStart(8, '0')}-1234-4123-8123-123456789abc`;
    return { ...sample, id, inZone: false, evidence: sample.revision, dataEpoch: 'epoch', sequence: '1', hub: null,
      primaryCredits: [{ agent: id, handle: null, displayName: `Author ${index}`, provider: null, key: null }] };
  });
  const batches: string[][] = [];
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);
    if (url.pathname.endsWith('/rankings')) {
      const interval = rankingIntervals.find(value => value === url.searchParams.get('interval'))!;
      const offset = rankingIntervals.indexOf(interval) * 10;
      const page = rankingModuleContractPage(interval, 'populated');
      return Response.json({ ...page, items: works.slice(offset, offset + 10).map(work => ({ ...page.items[0], id: work.id })) });
    }
    if (url.pathname.endsWith('/modules/new-adoptions')) {
      const encoded = url.searchParams.get('work');
      const targets: string[] = encoded?.startsWith('[') ? JSON.parse(encoded) : url.searchParams.getAll('work');
      batches.push(targets);
      return Response.json({ profile: 'zone-new-adoptions-v1', realm: rankingRealm,
        items: targets.length ? works.filter(work => targets.includes(work.id)) : works.slice(0, 20),
        nextCursor: targets.length ? null : 'realm:page-2', count: { value: targets.length || 20, kind: 'exact-page', total: null } });
    }
    throw new Error(`Unexpected card request: ${url.pathname}`);
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://contract.invalid', { fetcher, anonymous: true });
  const state = await loadRankingsModule(rankingModule, context, rankingModuleReads({ main, signedIn: false }));
  expect(state.state).toBe('ready');
  if (state.state !== 'ready') throw new Error('Expected populated module');
  expect(state.data.tabs.flatMap(tab => tab.items.map(item => item.work.author?.value)))
    .toEqual(works.map(work => zoneWork(work, context, work.evidence).author!.value));
  expect(batches.map(batch => batch.length)).toEqual([20, 10]);
  expect(batches.flat()).toEqual(works.map(work => work.id));
});

async function load(state: Parameters<typeof rankingModuleContractFetch>[0]) {
  const main = browserMainApi('https://contract.invalid', { fetcher: rankingModuleContractFetch(state), anonymous: true });
  return loadRankingsModule(rankingModule, { realm: rankingRealm, ref: 'ranking-garden', locale: 'en' }, {
    cards: async () => rankingModuleContractCards(),
    rankings: (realm, _locale, interval, metric) => readRankingModuleAnswer(main, realm, interval, metric),
  });
}

test('typed chart pages feed the existing ranking module without transferring original author credit', async () => {
  const state = await load('populated');
  expect(state.state).toBe('ready');
  if (state.state !== 'ready') throw new Error('Expected a populated module');
  expect(state.data.tabs.map(tab => tab.interval)).toEqual([...rankingIntervals]);
  for (const tab of state.data.tabs) {
    expect(tab.items[0]!.rank).toBe(1);
    expect(tab.items[0]!.work.author?.value).toBe('Ranking garden author');
    expect(tab.items[0]!.work.href).toBe(resourceHref('/w/', tab.items[0]!.work.id));
    expect(tab.items[0]!.work.decision).toBeNull();
    expect(tab.items[0]!.work.authorHref).toBe(rankingModuleContractCards().values().next().value!.authorHref);
  }
});

test('only a completed empty ranking becomes empty; missing, unavailable and underfilled pages remain failures', async () => {
  expect(await load('empty')).toEqual({ state: 'empty' });
  for (const state of ['missing', 'error', 'underfilled'] as const) expect(await load(state)).toEqual({ state: 'failed' });
});

test.each(['populated', 'underfilled'] as const)('missing auxiliary cards do not change a ranking window: %s', async window => {
  const main = browserMainApi('https://contract.invalid', { fetcher: rankingModuleContractFetch(window), anonymous: true });
  const state = await loadRankingsModule(rankingModule, { realm: rankingRealm, ref: 'ranking-garden', locale: 'en' }, {
    cards: async () => new Map(),
    rankings: (realm, _locale, interval, metric) => readRankingModuleAnswer(main, realm, interval, metric),
  });
  if (window === 'underfilled') {
    expect(state).toEqual({ state: 'failed' });
    return;
  }
  expect(state.state).toBe('ready');
  if (state.state !== 'ready') throw new Error('Expected ranking rows without auxiliary card matches');
  expect(state.data.tabs.map(tab => tab.items.map(item => item.work.id)))
    .toEqual(rankingIntervals.map(() => [...rankingModuleContractCards().keys()]));
});

test('loading chart reads stay unsettled until story teardown rather than inventing HTTP 202', async () => {
  const transport = rankingModuleContractFetch('loading');
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    started();
    return transport(input, init);
  }, { preconnect: fetch.preconnect });
  const main = browserMainApi('https://contract.invalid', { fetcher, anonymous: true });
  let settled = false;
  const page = readRankingModuleAnswer(main, rankingRealm, 'week', 'reads').then(answer => {
    settled = true;
    return answer;
  });
  await requestStarted;
  expect(settled).toBe(false);
  transport.dispose();
  expect(await page).toEqual({ ok: false, failure: 'unavailable' });
});
