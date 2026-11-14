import { expect, mock, spyOn, test } from 'bun:test';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
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

// Source-authored acceptance: execution belongs to the mounted/native verifier.
test('lost score save and clear replay the original envelope and sender; fresh answers never acknowledge them', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/one' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { SubjectRatingControl } = await import('../src/features/pages/rating-control');
  const actions = await import('../src/features/pages/rating-actions');
  type Request = import('../src/features/pages/rating-actions').QuestionBoundRatingInput;
  type Outcome = import('../src/library/score-write').PersonalScoreWriteResult;
  type Lease = import('../src/features/pages/subject-personal-reader').SubjectPersonalLease;
  type Own = import('../src/features/pages/subject-ratings').SubjectOwnRating;
  function deferred() {
    let resolve!: (result: Outcome) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Outcome>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  const deliveries: Array<ReturnType<typeof deferred> & { request: Request }> = [];
  const sender = spyOn(actions, 'changeQuestionBoundRating').mockImplementation(({ data }) => {
    const delivery = { ...deferred(), request: data as Request };
    deliveries.push(delivery);
    return delivery.promise;
  });
  try {
    for (const units of [0, null]) {
      deliveries.length = 0;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-a', csrfToken: 'credential-a' });
      let live = true;
      const operation = () => ({
        id: 1,
        sequence: 1,
        ownsCache: () => live,
        commit: () => {},
        rollback: () => null,
        preserveUncertainty: () => {},
      });
      let binding = {
        key: 'reader-a:first-visit',
        reader: 'reader-a',
        subjectId: subject,
        locale: 'en',
        view: 'overview',
        scope: {
          reader: 'reader-a',
          admission: 1,
          view: 'overview',
          cacheEpoch: 0,
          errorEpoch: 0,
          incarnation: 1,
          scopeKey: 'first-visit',
          isCurrent: () => live,
          hasLiveObserver: () => live,
        },
        isCurrent: () => live,
        retire: () => {
          live = false;
        },
        beginRatingWrite: operation,
      } satisfies Lease;
      let own: Own = { reader: 'reader-a', kind: 'ready', units: 8 };
      let currentQuestion = structuredClone(question);
      const replacements: Array<ReturnType<typeof deferred> & { request: Request }> = [];
      let replacement: import('../src/features/pages/rating-control').RatingWrite | undefined;
      const host = window.document.createElement('main');
      window.document.body.append(host);
      const root = createRoot(host as unknown as HTMLElement);
      const render = () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              StrictMode,
              null,
              createElement(SubjectRatingControl, {
                question: currentQuestion,
                subjectId: subject,
                locale: 'en',
                returnTo: '/en/subjects/one',
                session: 'signed-in',
                own,
                binding,
                ...(replacement ? { write: replacement } : {}),
              }),
            ),
          ),
        );
      const flush = async (action: () => void = () => {}) => {
        await act(async () => {
          action();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      const button = (name: string) =>
        Array.from(host.querySelectorAll('button')).find((node) => node.textContent === name) as HTMLButtonElement;
      const chooseZero = () =>
        host
          .querySelector('input[type="range"]')!
          .dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      const replayName =
        units === null ? m.subject_rating_control_retry_clear() : m.subject_rating_control_retry_save();
      const read = spyOn(client, 'fetchQuery').mockResolvedValue({ reader: 'reader-a', kind: 'ready', units });
      try {
        await flush(render);
        if (units !== null) await flush(chooseZero);
        await flush(() => {
          button(units === null ? m.subject_rating_control_clear() : m.subject_rating_control_save()).click();
          // Replace mutable sources before the lazy sender resumes, without retiring this owning lease.
          currentQuestion = { ...currentQuestion, revision: 2, label: 'A newer question caption' };
          currentQuestion.scale = { ...currentQuestion.scale };
          client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-a', csrfToken: 'credential-new' });
          replacement = (input) => {
            const delivery = { ...deferred(), request: input as Request };
            replacements.push(delivery);
            return delivery.promise;
          };
          render();
        });
        expect(deliveries).toHaveLength(1);
        const original = deliveries[0]!.request;
        expect(original).toMatchObject({
          subjectId: subject,
          units,
          expectedReader: 'reader-a',
          expectedCredential: 'credential-a',
          question: { id: QUESTION, revision: 1, meaning: question.label, scale: question.scale },
        });
        expect(Object.isFrozen(original)).toBe(true);
        expect(Object.isFrozen(original.question.scale)).toBe(true);
        await flush(() => deliveries[0]!.reject(new Error('response lost')));
        expect(host.textContent).toContain(m.subject_rating_control_uncertain());
        // A newer current observation, including an exact matching clear/zero, is not command proof.
        own = { reader: 'reader-a', kind: 'ready', units };
        await flush(render);
        expect(button(replayName).disabled).toBe(false);
        own = { reader: 'reader-a', kind: 'ready', units: 12 };
        await flush(render);
        const draft = host.querySelector('[data-slot="rating-control-value"]')!.textContent;
        expect(draft).toContain(units === null ? m.subject_rating_control_unrated() : '0 / 20');
        read.mockResolvedValueOnce({ reader: 'reader-a', kind: 'unavailable' });
        await flush(() => button(m.subject_rating_control_read_current()).click());
        expect(host.textContent).toContain(m.subject_rating_control_read_failed());
        expect(host.querySelector('[data-slot="rating-control-value"]')!.textContent).toBe(draft);
        await flush(() => button(m.subject_rating_control_read_current()).click());
        expect(read).toHaveBeenCalledTimes(2);
        expect(read.mock.calls[0]![0].queryKey.slice(0, 4)).toEqual(['subject-own-rating', subject, 'en', 'reader-a']);
        expect(host.querySelector('[data-slot="rating-current-answer"]')!.textContent).toContain(
          m.subject_rating_control_read_separate(),
        );
        expect(host.textContent).toContain(m.subject_rating_control_uncertain());
        expect(deliveries).toHaveLength(1);
        await flush(() => {
          button(replayName).click();
          button(replayName).click();
        });
        expect(deliveries).toHaveLength(2);
        expect(deliveries[1]!.request).toBe(original);
        expect(replacements).toHaveLength(0);
        await flush(() => deliveries[1]!.resolve('uncertain'));
        // A deliberate different choice is a new intent using the current envelope and sender.
        own = { reader: 'reader-a', kind: 'ready', units };
        await flush(render);
        if (units === null) await flush(chooseZero);
        await flush(() =>
          button(units === null ? m.subject_rating_control_save() : m.subject_rating_control_clear()).click(),
        );
        expect(replacements).toHaveLength(1);
        expect(replacements[0]!.request).toMatchObject({
          units: units === null ? 0 : null,
          expectedCredential: 'credential-new',
          question: { revision: 2 },
        });
        expect(replacements[0]!.request.idempotencyKey).not.toBe(original.idempotencyKey);
        // Two observer leases can share a scope key. Replacing the actual owner still retires private intent.
        live = false;
        binding = {
          ...binding,
          isCurrent: () => true,
          scope: { ...binding.scope, isCurrent: () => true, hasLiveObserver: () => true },
        };
        own = { reader: 'reader-a', kind: 'ready', units: 12 };
        await flush(render);
        expect(host.querySelector('[data-slot="rating-recovery"]')).toBeNull();
        await flush(() => button(m.subject_rating_control_clear()).click());
        expect(replacements).toHaveLength(2);
        await flush(() => replacements[1]!.resolve('uncertain'));
        await flush(() => replacements[0]!.resolve('successful'));
        expect(host.textContent).toContain(m.subject_rating_control_uncertain());
        expect(button(m.subject_rating_control_retry_clear()).disabled).toBe(false);
      } finally {
        read.mockRestore();
        await act(async () => root.unmount());
        host.remove();
        client.clear();
      }
    }
  } finally {
    sender.mockRestore();
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
