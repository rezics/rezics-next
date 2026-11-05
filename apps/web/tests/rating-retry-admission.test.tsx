import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { createKernelClient } from '@rezics/client';
import { admitPopulationEnvelope } from '../src/features/pages/population-envelope-admission';
import { admitRatingRetry, admitRatingRetryAfter, ratingRetryAt } from '../src/features/pages/rating-retry-admission';
import { GLOBAL, QUESTION, RATING_SOURCES, readRatings } from '../src/features/pages/subject-ratings';
import { readRatingPopulations, type PopulationInput } from '../src/features/pages/subject-rating-populations';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const subject = '00000000-0000-8000-8000-000000000001';
const realm = '00000000-0000-7000-8000-000000000002';
const question = {
  id: QUESTION,
  revision: 1,
  label: 'How much did you like this work?',
  grain: 'work' as const,
  scale: { min: 0, max: 20, displayStep: 1 },
};
const figure = {
  questionId: QUESTION,
  populationId: GLOBAL,
  scale: question.scale,
  count: 12,
  state: 'ready' as const,
  mean: 8,
  score: null,
};

function client(
  status: Partial<Record<(typeof RATING_SOURCES)[number] | 'directory' | 'realm', number>>,
  hint?: string,
) {
  const headers = hint ? { 'retry-after': hint } : undefined;
  return createKernelClient('https://kernel.invalid', {
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      const limited = (code: number) => Response.json({ code: 'rate_limited' }, { status: code, headers });
      if (url.pathname.startsWith('/v1/rating-questions/'))
        return status.question === 429 ? limited(429) : Response.json(question);
      if (url.pathname.endsWith('/figure')) return status.figure === 429 ? limited(429) : Response.json({ figure });
      if (url.pathname.endsWith('/source-statistics'))
        return status.statistics === 429 ? limited(429) : Response.json([]);
      if (url.pathname.endsWith('/ratings/populations'))
        return status.directory === 429
          ? limited(429)
          : Response.json({ populations: [{ population: realm, count: 4 }], next: null });
      if (url.pathname.startsWith('/v1/realms/'))
        return status.realm === 429 ? limited(429) : Response.json({ realm: { realmId: realm, title: 'Quiet Realm' } });
      if (url.pathname.endsWith('/ratings'))
        return status.global === 429
          ? limited(429)
          : Response.json({
              subject,
              question: QUESTION,
              figures: [
                {
                  population: url.searchParams.getAll('population')[0] ?? GLOBAL,
                  count: 4,
                  mean: 16,
                  histogram: [4],
                  freshness: { asOf: '2026-11-01T00:00:00.000Z', updating: false },
                },
              ],
            });
      throw new Error(url.pathname);
    },
  });
}

test('Native rating Retry-After is admitted once per source; siblings, malformed hints and Realm labels are not authority', async () => {
  const now = 1_000;
  expect(admitRatingRetryAfter({ 'retry-after': '30' }, now)).toBe('30');
  expect(ratingRetryAt('30', now)).toBe(31_000);
  expect(admitRatingRetryAfter({ 'Retry-After': 'Thu, 01 Jan 1970 00:00:03 GMT' }, 1_000)).toBe(
    'Thu, 01 Jan 1970 00:00:03 GMT',
  );
  expect(ratingRetryAt('Thu, 01 Jan 1970 00:00:03 GMT', 1_000)).toBe(3_000);
  expect(admitRatingRetryAfter({ 'retry-after': 'tomorrow' }, now)).toBeUndefined();
  expect(admitRatingRetryAfter({ 'retry-after': '0' }, now)).toBe('0');
  expect(admitRatingRetry(31_000, 30_999)).toBe(false);
  expect(admitRatingRetry(31_000, 31_000)).toBe(true);
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (const source of RATING_SOURCES) {
      const data = await readRatings(client({ [source]: 429 }, '30'), subject);
      expect(data[source]).toEqual({ kind: 'failed', retryAfter: '30', retryAt: 31_000 });
      for (const sibling of RATING_SOURCES.filter((item) => item !== source)) expect(data[sibling].kind).toBe('ready');
    }
    expect((await readRatings(client({ global: 429 }, 'tomorrow'), subject)).global).toEqual({ kind: 'failed' });
    expect((await readRatings(client({ global: 429 }), subject)).global).toEqual({ kind: 'failed' });
    const request = new Request('https://web.test');
    const directoryInput = {
      id: subject,
      question: QUESTION,
      expectedReader: null,
      locale: 'en',
    } satisfies PopulationInput;
    const directory = await readRatingPopulations(client({ directory: 429 }, '12'), request, {}, directoryInput);
    expect(directory.result).toEqual({ kind: 'failed', retryAfter: '12', retryAt: 13_000 });
    expect(admitPopulationEnvelope(directory, directoryInput)).toEqual(directory);
    const selectedInput = { ...directoryInput, selected: [realm] };
    const selected = await readRatingPopulations(client({ global: 429 }, '45'), request, {}, selectedInput);
    expect(selected.result).toEqual({
      kind: 'ready',
      value: {
        retryAfter: '45',
        retryAt: 46_000,
        items: [{ id: realm, name: 'Quiet Realm', figure: { kind: 'failed' } }],
        next: null,
        incomplete: false,
      },
    });
    expect(admitPopulationEnvelope(selected, selectedInput)).toEqual(selected);
    const concealed = await readRatingPopulations(client({ realm: 429 }, '99'), request, {}, selectedInput);
    expect(concealed.result).toEqual({ kind: 'ready', value: { items: [], next: null, incomplete: true } });
    expect(JSON.stringify(concealed)).not.toContain('99');
  } finally {
    clock.mockRestore();
  }
});

test('Retry waits for the captured instant, ignores rapid activation and source replacement, and keeps selected rows through aggregate failure', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/one' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { RatingSourceStatus } = await import('../src/features/pages/subject-ratings-view');
  let now = 1_000;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const recoveries: string[] = [];
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const renderStatus = async (source: string, retryAt: number) => {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(RatingSourceStatus, {
            outcome: { kind: 'failed', retryAfter: '30', retryAt },
            source,
            locale: 'en',
            retry: () => {
              if (!admitRatingRetry(retryAt)) return;
              recoveries.push(source);
            },
          }),
        ),
      );
    });
  };
  try {
    await renderStatus('figure', 31_000);
    const retry = () => host.querySelector<HTMLButtonElement>('button')!;
    expect(host.textContent).toContain(m.search_recovery_wait());
    expect(retry().textContent).toBe(m.subject_section_retry());
    expect(retry().getAttribute('aria-disabled')).toBe('true');
    expect(host.querySelector('[data-retry-after]')?.getAttribute('data-retry-after')).toBe('30');
    await act(async () => retry().click());
    expect(recoveries).toEqual([]);
    now = 31_000;
    await renderStatus('figure', 31_000);
    expect(host.textContent).not.toContain(m.search_recovery_wait());
    expect(retry().getAttribute('aria-disabled')).toBeNull();
    await act(async () => retry().click());
    expect(recoveries).toEqual(['figure']);
    now = 1_000;
    await renderStatus('directory', 31_000);
    await act(async () => retry().click());
    expect(recoveries).toEqual(['figure']);
  } finally {
    clock.mockRestore();
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
