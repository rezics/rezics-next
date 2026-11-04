import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import {
  createReporterHistoryJourney,
  prepareReporterHistoryVisit,
  type ReporterHistoryNavigation,
  type ReporterHistoryRead,
  type ReporterHistoryReader,
} from '../src/moderation/reporter-history/journey';
import { privateReaderFingerprint } from '../src/moderation/private-reader-origin';

const id = '11111111-1111-8111-8111-123411111111';
async function setup(navigation?: ReporterHistoryNavigation) {
  const cache = new QueryClient();
  cache.setQueryData(['session'], { state: 'signed-in', subject: 'reporter', csrfToken: 'secret' });
  const readerOrigin = { subject: 'reporter', csrfFingerprint: await privateReaderFingerprint('secret') };
  const loaded: ReporterHistoryRead = {
    readerOrigin,
    result: {
      state: 'loaded',
      nativeSourceFingerprint: 'hash',
      page: {
        state: 'ready',
        entries: [],
        selectedReportId: null,
        nextCursor: 'opaque/+?next',
        retry: { cursor: 'original' },
        viewer: { kind: 'reporter' },
      },
    },
  };
  let response = loaded;
  const calls: unknown[] = [];
  const read: ReporterHistoryReader = async (query) => {
    calls.push(query);
    return response;
  };
  const initial = await prepareReporterHistoryVisit(cache, { cursor: 'original', reportId: id }, 'en', read);
  let locale = 'en';
  const journey = createReporterHistoryJourney(cache, initial, read, () => locale, navigation);
  const stop = journey.subscribe(() => {});
  return {
    cache,
    journey,
    calls,
    loaded,
    stop,
    respond: (value: ReporterHistoryRead) => {
      response = value;
    },
    locale: (value: string) => {
      locale = value;
    },
  };
}

test('sparse continuation replaces the page and retries the exact failed frontier and selection', async () => {
  const s = await setup();
  expect(s.journey.snapshot().state).toBe('loaded');
  s.respond({ readerOrigin: s.loaded.readerOrigin, result: { state: 'unavailable' } });
  await s.journey.next();
  expect(s.journey.snapshot()).toEqual({ state: 'unavailable' });
  await s.journey.retry();
  expect(s.calls).toEqual([
    { cursor: 'original', reportId: id },
    ...Array(2).fill({ cursor: 'opaque/+?next', reportId: id }),
  ]);
  s.respond({ readerOrigin: s.loaded.readerOrigin, result: { state: 'expired' } });
  await s.journey.retry();
  await s.journey.restart();
  expect(s.calls.at(-1)).toEqual({});
  s.stop();
});

test('account, credential, locale and native source replacement retire all old controls', async () => {
  for (const change of ['account', 'credentials', 'locale', 'source'] as const) {
    const s = await setup();
    if (change === 'account' || change === 'credentials')
      s.cache.setQueryData(['session'], {
        state: 'signed-in',
        subject: change === 'account' ? 'other' : 'reporter',
        csrfToken: 'replacement',
      });
    if (change === 'locale') s.locale('ja');
    if (change === 'source') {
      if (s.loaded.result.state !== 'loaded') throw new Error('fixture');
      s.respond({ ...s.loaded, result: { ...s.loaded.result, nativeSourceFingerprint: 'replacement' } });
      await s.journey.refresh();
    }
    expect(s.journey.snapshot()).toEqual({ state: 'retired' });
    const count = s.calls.length;
    await s.journey.next();
    await s.journey.select(id);
    expect(s.calls).toHaveLength(count);
    s.stop();
  }
});

test('an account change during preparation and an independent client cannot admit private rows', async () => {
  const s = await setup();
  const initial = await prepareReporterHistoryVisit(s.cache, {}, 'en', async () => {
    s.cache.setQueryData(['session'], { state: 'signed-in', subject: 'other', csrfToken: 'other' });
    return s.loaded;
  });
  for (const cache of [s.cache, new QueryClient()]) {
    const journey = createReporterHistoryJourney(
      cache,
      initial,
      async () => s.loaded,
      () => 'en',
    );
    const stop = journey.subscribe(() => {});
    expect(journey.snapshot()).toEqual({ state: 'retired' });
    stop();
  }
  s.stop();
});

test('an A/B/A successful session replacement cannot revive the prior private page', async () => {
  const s = await setup();
  s.cache.setQueryData(['session'], { state: 'signed-in', subject: 'another-account', csrfToken: 'other' });
  s.cache.setQueryData(['session'], { state: 'signed-in', subject: 'reporter', csrfToken: 'secret' });
  expect(s.journey.snapshot()).toEqual({ state: 'retired' });
  await s.journey.next();
  expect(s.calls).toHaveLength(1);
  s.stop();
});

test('navigation replacement retires the visit and its selected private state', async () => {
  let current = true;
  let replace = () => {};
  const navigation: ReporterHistoryNavigation = {
    isCurrent: () => current,
    subscribe: (retire) => {
      replace = retire;
      return () => undefined;
    },
  };
  const s = await setup(navigation);
  current = false;
  replace();
  expect(s.journey.snapshot()).toEqual({ state: 'retired' });
  await s.journey.select(id);
  expect(s.calls).toHaveLength(1);
  s.stop();
});

test('fetching and invalidation retire the shared browser incarnation even if the same successful session returns', async () => {
  for (const change of ['fetch', 'invalidate'] as const) {
    const s = await setup();
    const query = s.cache.getQueryCache().find({ queryKey: ['session'] })!;
    if (change === 'fetch') query.setState({ fetchStatus: 'fetching' });
    else query.invalidate();
    query.setState({ fetchStatus: 'idle', isInvalidated: false });
    expect(s.journey.snapshot()).toEqual({ state: 'retired' });
    await s.journey.next();
    expect(s.calls).toHaveLength(1);
    s.stop();
  }
});
