import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { MusicContextRead } from '../src/features/catalogue/music-context-profile';
import type { MusicContextAddress } from '../src/features/catalogue/music-context-profile/navigation';
import { musicContextRouteSearch } from '../src/features/catalogue/music-context-profile/navigation';
import { MusicContextProfile } from '../src/features/pages/music-context-profile';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';

mock.module('cloudflare:workers', () => ({ env: {} }));

const anchor = '00000000-0000-4000-8000-00000000d101';
const endpoint = '00000000-0000-4000-8000-00000000d102';
const streams = [
  { id: 'schema:location', label: 'Recorded at' },
  { id: 'wdt:P8000', label: 'Related events' },
];

function successful(stream: string, label: string, session: string, next: string | null = 'next-1') {
  return {
    ok: true,
    public: {
      subject: {
        id: anchor,
        type: 'schema:Place',
        revision: 4,
        release: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        context: '00000000-0000-4000-8000-000000000001',
        labels: { en: 'Harbor Stage' },
        descriptions: {},
        aliases: {},
        statements: {},
        resolution: {},
        relationCounts: {},
        sourceRecords: [],
      },
      account: null,
      related: {},
      summary: null,
    },
    kind: 'place',
    facts: [
      {
        property: 'schema:startDate',
        label: 'Opening date',
        text: '2001 · year · Gregorian',
        time: {
          state: 'supported',
          text: '2001 · year · Gregorian',
          date: '+2001',
          precision: 9,
          calendar: 'gregorian',
          structuredDate: '2001',
        },
      },
    ],
    streams,
    links: [
      {
        id: endpoint,
        label,
        property: stream,
        position: 1,
        occurrence: `${stream}:${label}`,
        date: {
          property: 'schema:startDate',
          label: 'Start date',
          time: {
            state: 'supported',
            text: '2001 · year · Gregorian',
            date: '+2001',
            precision: 9,
            calendar: 'gregorian',
            structuredDate: '2001',
          },
        },
      },
    ],
    next,
    stream,
    session,
  } satisfies Extract<MusicContextRead, { ok: true }>;
}

type Deferred = {
  input: MusicContextAddress & { session?: string | undefined };
  promise: Promise<MusicContextRead>;
  resolve: (value: MusicContextRead) => void;
  reject: (error: Error) => void;
};

function deferred(input: Deferred['input']): Deferred {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<MusicContextRead>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  pending.push({ input, promise, resolve, reject });
  return pending[pending.length - 1]!;
}

const pending: Deferred[] = [];

test('the mounted music-context reader selects, pages, retries and returns through current local intent', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({
    url: `https://site.test/en/subjects/${anchor}/harbor-stage/music-context`,
    width: 390,
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const [{ createRoot }] = await Promise.all([import('react-dom/client')]);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  pending.length = 0;
  let initialAttempts = 0;
  let pageAttempts = 0;
  const calls: Array<MusicContextAddress & { session?: string | undefined }> = [];
  const transport = {
    read: (input: MusicContextAddress & { session?: string | undefined }): Promise<MusicContextRead> => {
      calls.push(input);
      if (!input.stream && !input.cursor) {
        initialAttempts += 1;
        return Promise.resolve(
          initialAttempts === 1
            ? { ok: false, reason: 'unavailable' }
            : successful('schema:location', 'Initial row', 'initial-token'),
        );
      }
      if (input.cursor === 'next-1') {
        pageAttempts += 1;
        return Promise.resolve(
          pageAttempts === 1
            ? { ok: false, reason: 'unavailable' }
            : successful('schema:location', 'Second page endpoint', 'page-token', null),
        );
      }
      return deferred(input).promise;
    },
  };

  const render = async () =>
    act(async () =>
      root.render(
        <MusicContextProfile
          id={anchor}
          locale="en"
          returnTo={`/en/subjects/${anchor}/harbor-stage/album`}
          transport={transport}
        />,
      ),
    );
  const choose = async (stream: string) => {
    const select = host.querySelector<HTMLSelectElement>('#music-context-stream');
    if (!select) throw new Error('Music-context stream selector was not mounted');
    await act(async () => {
      select.value = stream;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      await Promise.resolve();
    });
  };
  const settle = async (operation: () => void) =>
    act(async () => {
      operation();
      await Promise.resolve();
      await Promise.resolve();
    });

  try {
    await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('unavailable');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Retry this page'))).toBe(
      true,
    );
    const initialRetry = host.querySelector<HTMLButtonElement>('button');
    if (!initialRetry) throw new Error('Initial retry action was not rendered');
    await settle(() => initialRetry.click());
    expect(host.textContent).toContain('Initial row');

    await choose('wdt:P8000');
    await choose('schema:location');
    await settle(() => pending[0]!.reject(new Error('retired relation failure')));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await settle(() => pending[1]!.resolve(successful('schema:location', 'Current after failure', 'current-token')));
    expect(host.textContent).toContain('Current after failure');
    expect(host.querySelector('select')?.value).toBe('schema:location');

    await choose('wdt:P8000');
    await choose('schema:location');
    await settle(() => pending[2]!.resolve(successful('wdt:P8000', 'Retired success', 'stale-token')));
    expect(host.textContent).not.toContain('Retired success');
    await settle(() => pending[3]!.resolve(successful('schema:location', 'Current venue', 'current-token')));
    expect(host.textContent).toContain('Current venue');

    const next = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Next page'));
    if (!next) throw new Error('The current native continuation was not rendered');
    await settle(() => next.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('unavailable');
    expect(host.textContent).toContain('last readable page');
    expect(host.textContent).toContain('Current venue');
    expect(host.querySelector('button')?.textContent).toContain('Retry this page');
    const retry = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry this page'),
    );
    if (!retry) throw new Error('The failed native address did not expose retry');
    await settle(() => retry.click());
    expect(calls.slice(-2)).toEqual([
      { stream: 'schema:location', cursor: 'next-1', session: 'current-token' },
      { stream: 'schema:location', cursor: 'next-1', session: 'current-token' },
    ]);
    expect(host.textContent).toContain('Second page endpoint');

    const related = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Second page endpoint'),
    );
    if (!related) throw new Error('The disclosed endpoint did not become a Subject link');
    const visit = new URL(related.href);
    const via = visit.searchParams.get('via');
    expect(via).toBe(`/en/subjects/${anchor}/harbor-stage/music-context?stream=schema%3Alocation&cursor=next-1`);
    expect(subjectVisitReturn(via, 'en')).toBe(via);
    const correction = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Propose a correction'),
    );
    if (!correction) throw new Error('The existing facts correction destination was not rendered');
    const correctionReturn = new URL(correction.href).searchParams.get('returnTo');
    expect(correctionReturn).toBe(via);
    expect(musicContextRouteSearch({ returnTo: correctionReturn }, 'en')?.returnTo).toBe(via);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});

test('music-context addresses reject external, encoded and nested return intent', () => {
  const valid = `/en/subjects/${anchor}/harbor-stage/music-context?stream=schema%3Alocation&cursor=next-1`;
  expect(musicContextRouteSearch({ stream: 'schema:location', cursor: 'next-1', returnTo: valid }, 'en')).toEqual({
    stream: 'schema:location',
    cursor: 'next-1',
    returnTo: valid,
  });
  for (const returnTo of [
    '//outside.test/subjects/return',
    'https://outside.test/subjects/return',
    `/en/subjects/${anchor}/%2e%2e/music-context`,
    `/en/subjects/${anchor}/harbor%2fstage/music-context`,
    `/en/subjects/${anchor}/harbor%00stage/music-context`,
    `${valid}&returnTo=${encodeURIComponent(valid)}`,
  ])
    expect(musicContextRouteSearch({ returnTo }, 'en')).toBeUndefined();
  expect(musicContextRouteSearch({ session: 'reader-token' }, 'en')).toBeUndefined();
  expect(musicContextRouteSearch({ stream: 'schema:location', cursor: 'bad\u0000cursor' }, 'en')).toBeUndefined();
});
