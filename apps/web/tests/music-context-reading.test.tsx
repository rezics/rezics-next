import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { MusicContextRead } from '../src/features/catalogue/music-context-profile';
import { bundledDigest } from '@rezics/definitions/bundled';
import type { MusicContextAddress } from '../src/features/catalogue/music-context-profile/navigation';
import {
  musicContextAddressHref,
  musicContextRouteSearch,
} from '../src/features/catalogue/music-context-profile/navigation';
import { MusicContextProfile } from '../src/features/pages/music-context-profile';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { candidateContext } from '../src/subject/candidates';

mock.module('cloudflare:workers', () => ({ env: {} }));

const anchor = '00000000-0000-4000-8000-00000000d101';
const endpoint = '00000000-0000-4000-8000-00000000d102';
const streams = [
  { id: 'schema:location', label: 'location' },
  { id: 'schema:performer', label: 'performer' },
];

function successful(
  stream: string,
  label: string,
  session: string,
  next: string | null = 'next-1',
  context = candidateContext,
) {
  return {
    ok: true,
    public: {
      subject: {
        id: anchor,
        type: 'schema:MusicEvent',
        revision: 4,
        release: bundledDigest,
        context,
        labels: { en: 'Harbor Stage' },
        descriptions: {},
        aliases: {},
        statements: {
          'schema:startDate': [
            {
              id: '00000000-0000-4000-8000-00000000d103',
              rank: 'normal',
              property: { id: 'schema:startDate', data_type: 'time' },
              value: {
                type: 'value',
                content: {
                  time: '+2001-05-00T00:00:00Z',
                  precision: 10,
                  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
                },
              },
              qualifiers: [],
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url', data_type: 'url' },
                      value: { type: 'value', content: 'https://music.example.test/source' },
                    },
                  ],
                  hash: 'source-reference',
                },
              ],
            },
          ],
        },
        resolution: {},
        relationCounts: {},
        sourceRecords: [],
      },
      account: null,
      related: {},
      summary: null,
    },
    kind: 'event',
    facts: [
      {
        property: 'schema:startDate',
        label: 'Opening date',
        text: 'May 2001 · month · Gregorian',
        time: {
          state: 'supported',
          text: 'May 2001 · month · Gregorian',
          date: '+2001-05',
          precision: 10,
          calendar: 'gregorian',
          structuredDate: '2001-05',
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
        ...(stream === 'schema:location' ? { targetKind: 'place' as const } : {}),
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
      if (!input.cursor && (!input.stream || (input.stream === 'schema:location' && initialAttempts === 1))) {
        initialAttempts += 1;
        return Promise.resolve(
          initialAttempts === 1
            ? {
                ...successful('schema:location', 'Initial row', 'initial-token', null),
                links: [],
                next: null,
                relationsUnavailable: true,
              }
            : successful('schema:location', 'Initial row', 'initial-token'),
        );
      }
      if (input.cursor === 'next-1') {
        pageAttempts += 1;
        return Promise.resolve(
          pageAttempts === 1
            ? {
                ...successful('schema:location', 'Current venue', 'current-token', null),
                links: [],
                next: null,
                relationsUnavailable: true,
              }
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
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('relation page could not be read');
    expect(host.textContent).toContain('May 2001 · month · Gregorian');
    expect([...host.querySelectorAll('button')].some((button) => button.textContent?.includes('Retry this page'))).toBe(
      true,
    );
    const initialRetry = host.querySelector<HTMLButtonElement>('button');
    if (!initialRetry) throw new Error('Initial retry action was not rendered');
    await settle(() => initialRetry.click());
    expect(host.textContent).toContain('Initial row');
    expect(calls.slice(0, 2)).toEqual([
      { context: candidateContext },
      { context: candidateContext, stream: 'schema:location', session: 'initial-token' },
    ]);

    await choose('schema:performer');
    await choose('schema:location');
    await settle(() => pending[0]!.reject(new Error('retired relation failure')));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await settle(() => pending[1]!.resolve(successful('schema:location', 'Current after failure', 'current-token')));
    expect(host.textContent).toContain('Current after failure');
    expect(host.querySelector('select')?.value).toBe('schema:location');

    await choose('schema:performer');
    await choose('schema:location');
    await settle(() => pending[2]!.resolve(successful('wdt:P8000', 'Retired success', 'stale-token')));
    expect(host.textContent).not.toContain('Retired success');
    await settle(() => pending[3]!.resolve(successful('schema:location', 'Current venue', 'current-token')));
    expect(host.textContent).toContain('Current venue');

    const next = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Next page'));
    if (!next) throw new Error('The current native continuation was not rendered');
    await settle(() => next.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('relation page could not be read');
    expect(host.textContent).toContain('last readable page');
    expect(host.textContent).toContain('Current venue');
    expect(host.querySelector('button')?.textContent).toContain('Retry this page');
    const retry = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Retry this page'),
    );
    if (!retry) throw new Error('The failed native address did not expose retry');
    await settle(() => retry.click());
    expect(calls.slice(-2)).toEqual([
      { context: candidateContext, stream: 'schema:location', cursor: 'next-1', session: 'current-token' },
      { context: candidateContext, stream: 'schema:location', cursor: 'next-1', session: 'current-token' },
    ]);
    expect(host.textContent).toContain('Second page endpoint');

    const previous = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Previous page'),
    );
    if (!previous) throw new Error('The bounded Previous address was not available');
    await settle(() => previous.click());
    expect(calls.at(-1)).toEqual({ context: candidateContext, stream: 'schema:location', session: 'page-token' });
    await settle(() => pending[4]!.resolve(successful('schema:location', 'Fresh Previous page', 'previous-token')));
    expect(host.textContent).toContain('Fresh Previous page');

    const related = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Fresh Previous page'),
    );
    if (!related) throw new Error('The disclosed endpoint did not become a Subject link');
    const visit = new URL(related.href);
    const via = visit.searchParams.get('via');
    expect(via).toBe(`/en/subjects/${anchor}/harbor-stage/music-context?stream=schema%3Alocation`);
    expect(subjectVisitReturn(via, 'en')).toBe(via);
    const correction = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) =>
      link.textContent?.includes('Propose a correction'),
    );
    if (!correction) throw new Error('The existing facts correction destination was not rendered');
    const correctionReturn = new URL(correction.href).searchParams.get('returnTo');
    expect(correctionReturn).toBe(via);
    expect(subjectVisitReturn(correctionReturn, 'en')).toBe(via);
    const returnLink = () =>
      [...host.querySelectorAll('a')].find((link) => link.textContent === 'Return to the source subject')!;
    expect(returnLink().getAttribute('href')).toBe(`/en/subjects/${anchor}/harbor-stage`); // Unsupported View keeps the general fallback.
    const { graphBrowserReturnHref } = await import('../src/features/pages/graph-browser/view');
    const { subjectGraphVisitReturn } = await import('../src/features/pages/subject-visit-navigation');
    const graphPath = `/en/subjects/${endpoint}/original-graph/graph`;
    const query = { property: ['schema:location'], direction: 'out' as const, depth: 2 as const };
    const graphVisit = { kind: 'global' as const, returnHref: graphPath.replace('/graph', '#subject-heading') };
    const addresses = [
      graphBrowserReturnHref(graphPath, query, { kind: 'node', id: anchor }, graphVisit)!,
      graphBrowserReturnHref(
        graphPath,
        query,
        { kind: 'edge', statement: endpoint, from: endpoint, to: anchor, property: 'schema:location' },
        graphVisit,
      )!,
    ];
    const companionTransport = { read: (input: Deferred['input']) => deferred(input).promise };
    const showCompanion = async (returnTo: string, key: string, address: MusicContextAddress = {}) => {
      const href = musicContextAddressHref(
        `/en/subjects/${anchor}/harbor-stage/music-context`,
        { ...address, returnTo },
        'en',
        anchor,
      )!;
      const url = new URL(href, 'https://site.test');
      const received = musicContextRouteSearch(Object.fromEntries(url.searchParams), 'en', {
        subjectId: anchor,
        pathname: url.pathname,
      });
      expect(received?.returnTo).toBe(returnTo);
      await act(async () =>
        root.render(
          <MusicContextProfile
            key={key}
            id={anchor}
            locale="en"
            context={received!.context}
            initialStream={received!.stream}
            initialCursor={received!.cursor}
            returnTo={received!.returnTo}
            transport={companionTransport}
          />,
        ),
      );
      expect(returnLink().getAttribute('href')).toBe(returnTo);
    };
    const selectedContext = '00000000-0000-4000-8000-000000000021';
    const { releaseReturnHref } = await import('../src/features/catalogue/release-fidelity/navigation');
    const selectedReturn = releaseReturnHref('Harbor Stage', 'en', {
      id: anchor,
      context: selectedContext,
      digest: bundledDigest,
      revision: 4,
      stream: 'forward:schema:location',
      cursor: 'release-window:2/selected',
      focus: 'related',
    })!;
    const selectedAddress = { context: selectedContext, stream: 'schema:location', cursor: 'selected-page-2' };
    const firstSelected = pending.length;
    await showCompanion(selectedReturn, 'selected', selectedAddress);
    await showCompanion(selectedReturn, 'selected', { ...selectedAddress, cursor: 'selected-page-3' });
    await settle(() =>
      pending[firstSelected + 1]!.resolve(
        successful('schema:location', 'Current selected page', 'selected-token', null, selectedContext),
      ),
    );
    returnLink().focus();
    const selectedFocus = document.activeElement;
    await settle(() =>
      pending[firstSelected]!.resolve(
        successful('schema:location', 'Retired selected page', 'retired-token', null, selectedContext),
      ),
    );
    expect(host.textContent).toContain('Current selected page');
    expect(host.textContent).not.toContain('Retired selected page');
    expect(returnLink().getAttribute('href')).toBe(selectedReturn);
    expect(document.activeElement).toBe(selectedFocus);
    // Same-tab Back delivers the earlier route coordinates to the mounted reader.
    await showCompanion(selectedReturn, 'selected', selectedAddress);
    await settle(() =>
      pending[firstSelected + 2]!.resolve(
        successful('schema:location', 'Reread selected page', 'back-token', null, selectedContext),
      ),
    );
    expect(host.textContent).toContain('Reread selected page');
    expect(returnLink().getAttribute('href')).toBe(selectedReturn);
    expect(pending.slice(firstSelected).map(({ input }) => input.cursor)).toEqual([
      'selected-page-2',
      'selected-page-3',
      'selected-page-2',
    ]);
    const beforeReturn = pending.length;
    returnLink().addEventListener('click', (event) => event.preventDefault(), { once: true });
    await settle(() => returnLink().click());
    expect(pending).toHaveLength(beforeReturn);
    const showGraph = async (returnTo: string, key = 'graph') => {
      await showCompanion(returnTo, key);
      expect(subjectGraphVisitReturn(returnLink().getAttribute('href'), 'en')).toBe(returnTo);
    };
    const firstGraph = pending.length;
    await showGraph(addresses[0]!);
    await showGraph(addresses[1]!);
    await settle(() =>
      pending[firstGraph + 1]!.resolve(successful('schema:location', 'Current edge companion', 'edge-token')),
    );
    returnLink().focus();
    const focused = document.activeElement;
    await settle(() =>
      pending[firstGraph]!.resolve(successful('schema:location', 'Retired node companion', 'node-token')),
    );
    expect(host.textContent).toContain('Current edge companion');
    expect(host.textContent).not.toContain('Retired node companion');
    expect(document.activeElement).toBe(focused);
    expect(returnLink().getAttribute('href')).toBe(addresses[1]);
    await showGraph(addresses[1]!, 'reload');
    await settle(() =>
      pending[firstGraph + 2]!.resolve(successful('schema:location', 'Reloaded companion', 'reload-token')),
    );
    expect(host.textContent).toContain('Reloaded companion');
    expect(returnLink().getAttribute('href')).toBe(addresses[1]);
    expect(pending.slice(firstGraph).map(({ input }) => input)).toEqual([
      { context: candidateContext },
      { context: candidateContext },
      { context: candidateContext },
    ]);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});

test('music-context addresses reject external, encoded and nested return intent', () => {
  const valid = `/en/subjects/${anchor}/harbor-stage`;
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
