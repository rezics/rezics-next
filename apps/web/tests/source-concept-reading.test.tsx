import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import type { KernelClient, SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import en from '../messages/en.json';
import type { ConceptRead } from '../src/features/catalogue/source-concept-explorer';
import type { ConceptInput } from '../src/features/pages/source-concept-reading/visit';

mock.module('cloudflare:workers', () => ({ env: {} }));
function paraglideMessages() {
  return {
    m: new Proxy(
      {},
      {
        get(_target, key) {
          return (values: Record<string, string> = {}) => {
            const message = en[String(key) as keyof typeof en];
            return String(message ?? '').replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '');
          };
        },
      },
    ),
  };
}
mock.module('../src/paraglide/messages.js', paraglideMessages);
mock.module('../src/paraglide/messages/_index.js', paraglideMessages);

const { readSourceConcept } = await import('../src/features/catalogue/source-concept-explorer');
const id = '00000000-0000-4000-8000-00000000c001';
const target = '00000000-0000-4000-8000-00000000c002';
const origin = `/en/subjects/${target}/classification/graph`;
const role = 'vndb:不明/المصدر/00-A';
const originalRelease = `sha256:${'a'.repeat(64)}`;
const replacementRelease = `sha256:${'b'.repeat(64)}`;

// Caller evidence uses the existing Subject and bounded inverse response, never an invented transport DTO.
async function response(
  input: ConceptInput = {},
  options: {
    role?: string;
    state?: 'available' | 'lagging' | 'preparing' | 'unavailable';
    id?: string;
    release?: string;
    receipt?: string;
    label?: string;
    advice?: boolean;
    empty?: boolean;
    next?: string | null;
    admitted?: boolean;
    hidden?: boolean;
    unsupported?: boolean;
  } = {},
): Promise<ConceptRead> {
  const subject: SubjectRead = {
    subject: {
      id: options.id ?? id,
      type: options.admitted === false ? 'schema:Book' : 'skos:Concept',
      revision: 1,
      release: options.release ?? originalRelease,
      context: target,
      labels: { en: 'Original concept' },
      aliases: { ja: ['元の概念'] },
      descriptions: { ja: '定義と原文 العربية Français '.repeat(30) },
      statements: {},
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    related: {},
    summary: null,
  };
  Object.assign(subject, {
    viewerActions: {
      state: 'available',
      actions: options.advice === false ? [] : [{ action: 'statement:propose', operations: ['subject.propose'] }],
    },
  });
  const state = options.state ?? 'available';
  const client = {
    subjects: () => ({
      get: async () => ({
        status: 200,
        data: subject,
        headers: { 'rezics-session-token': options.receipt ?? 'receipt-A' },
      }),
      links: {
        get: async ({ query }: { query?: { property?: string } } = {}) => {
          if (query?.property === 'schema:genre' || query?.property === 'schema:keywords')
            return {
              status: 200,
              data: { links: [], next: null, freshness: { caught_up: true }, count: { value: 0, exact: true } },
            };
          return state === 'preparing' || state === 'unavailable'
            ? { status: 503, data: { code: state === 'preparing' ? 'semantic_not_ready' : 'dependency_unavailable' } }
            : {
                status: 200,
                data: {
                  links: options.empty
                    ? []
                    : [
                        {
                          subject: target,
                          property: 'skos:broader',
                          statement: target,
                          related: {},
                          summary: {
                            id: target,
                            type: 'skos:Concept',
                            label: options.hidden
                              ? null
                              : {
                                  value: options.label ?? (input.cursor ? `Rows ${input.cursor}` : 'First rows'),
                                  language: 'en',
                                },
                            types: ['skos:Concept'],
                            creativeWork: false,
                            cover: null,
                          },
                        },
                      ],
                  next: options.next === undefined ? (input.cursor ? null : 'next:原文') : options.next,
                  freshness: { consistency: 'eventual', target_seconds: 10, caught_up: state !== 'lagging' },
                  ...(options.empty ? { count: { value: 0, exact: true } } : {}),
                },
              };
        },
      },
    }),
  } as unknown as KernelClient;
  const release = options.unsupported
    ? {
        ...bundledRelease,
        properties: {
          ...bundledRelease.properties,
          'skos:broader': { ...bundledRelease.properties['skos:broader']!, relation: undefined },
        },
      }
    : bundledRelease;
  return readSourceConcept(client, undefined, release, options.id ?? id, 'en', {
    ...input,
    role: options.role ?? role,
  });
}

async function mounted(
  run: (page: {
    host: HTMLElement;
    render: (node: ReactNode) => Promise<void>;
    click: (name: string) => Promise<void>;
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = {
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLButtonElement',
        'Node',
        'Element',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ShadowRoot',
      ].map((key) => [key, window[key]]),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await run({
      host,
      render: (node) => act(async () => root.render(node)),
      click: (name) =>
        act(async () => {
          const button = [...host.querySelectorAll('button')].find((node) => node.textContent === name)!;
          expect(button).toBeDefined();
          expect(button.disabled).toBe(false);
          button.focus();
          button.click();
        }),
    });
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function pendingReads() {
  const calls: { input: ConceptInput; resolve: (read: ConceptRead) => void; reject: () => void }[] = [];
  return {
    calls,
    read: (input: ConceptInput) =>
      new Promise<ConceptRead>((resolve, reject) =>
        calls.push({ input, resolve, reject: () => reject(Error('network unavailable')) }),
      ),
    complete: async (index: number, options: Parameters<typeof response>[1] = {}) => {
      const value = await response(calls[index]!.input, options);
      await act(async () => calls[index]!.resolve(value));
    },
  };
}

function hierarchy(host: HTMLElement) {
  return host.querySelector('#concept-narrower-heading')!.parentElement!;
}
function links(host: Element) {
  return [...host.querySelectorAll('a')].map((node) => node.textContent);
}

test('mounted native hierarchy retains a failed page, retries its original input, navigates back and leaves deliberately', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  await mounted(async ({ host, render, click }) => {
    const pending = pendingReads();
    await render(h(SourceConceptView, { id, locale: 'en', role, returnTo: origin, transport: pending }));
    expect(host.textContent).toContain('Reading the concept');
    expect(host.querySelector('a')).toBeTruthy(); // Origin is independently available while loading.
    await pending.complete(0);
    expect(links(hierarchy(host))).toEqual(['First rows']);
    expect(host.textContent).toContain(role);
    const correct = [...host.querySelectorAll('a')].find((node) => node.textContent === 'Correct this fact')!;
    const correction = new URL(correct.href);
    expect(correction.pathname).toEndWith('/edit');
    expect(correction.searchParams.get('returnTo')).toBe(origin);
    await click('More hierarchy');
    expect(pending.calls[1]!.input).toEqual({ cursor: 'next:原文', session: 'receipt-A' });
    await pending.complete(1, { state: 'unavailable', advice: false });
    expect(links(hierarchy(host))).toEqual(['First rows']);
    expect(hierarchy(host).textContent).toContain('Showing retained hierarchy page 1');
    expect(links(host)).not.toContain('Correct this fact'); // Fresh advice is independent of retained rows.
    expect(document.activeElement?.getAttribute('role')).toBe('status');
    await click('Retry this page');
    expect(pending.calls[2]!.input).toEqual(pending.calls[1]!.input);
    await pending.complete(2);
    expect(links(hierarchy(host))).toEqual(['Rows next:原文']);
    expect(hierarchy(host).textContent).toContain('Retained page 2 of 2');
    await click('Previous page');
    expect(pending.calls[3]!.input.cursor).toBeUndefined();
    await pending.complete(3);
    expect(links(hierarchy(host))).toEqual(['First rows']);
    await click('More hierarchy');
    const originLink = [...host.querySelectorAll('a')].find(
      (node) => node.textContent === 'Return to the selected fact',
    )!;
    await act(async () => originLink.focus());
    await pending.complete(4);
    expect(document.activeElement).toBe(originLink); // Later reader movement owns focus.
    expect(originLink.getAttribute('href')).toBe(origin);
    expect(pending.calls).toHaveLength(5); // No traversal or automatic retry.
  });
});

test('role, subject and reader ABA replacements fence reversed successful and failed completions', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  await mounted(async ({ host, render, click }) => {
    const pending = pendingReads();
    const show = (requested = role, reader = 'reader-A', subject = id, token = 'session-A') =>
      render(
        h(CandidateReaderBoundary, {
          observed: { state: 'signed-in', subject: reader, csrfToken: token },
          address: subject,
          children: h(SourceConceptView, { id: subject, locale: 'en', role: requested, transport: pending }),
        }),
      );
    await show();
    await pending.complete(0);
    await click('More hierarchy'); // Old role A completion waits.
    await show('role-B');
    expect(host.textContent).not.toContain('First rows');
    await show(); // Equal role must start afresh.
    await pending.complete(3, { label: 'Fresh role A' });
    await pending.complete(2, { role: 'role-B', state: 'preparing', label: 'Retired B' });
    await pending.complete(1, { label: 'Retired A' });
    expect(links(hierarchy(host))).toEqual(['Fresh role A']);
    await click('More hierarchy');
    await show(role, 'reader-B');
    await show(role, 'reader-A');
    await pending.complete(6, { label: 'Fresh reader A' });
    await pending.complete(5, { state: 'unavailable' });
    await pending.complete(4, { label: 'Old reader A' });
    expect(links(hierarchy(host))).toEqual(['Fresh reader A']);
    await show(role, 'reader-A', target);
    await show();
    await pending.complete(8, { label: 'Fresh address A' });
    await pending.complete(7, { id: target, state: 'preparing' });
    expect(links(hierarchy(host))).toEqual(['Fresh address A']);
    await show(role, 'reader-A', id, 'session-B');
    expect(host.textContent).not.toContain('Fresh address A');
    await pending.complete(9, { label: 'New session' });
    expect(links(hierarchy(host))).toEqual(['New session']);
  });
});

test('every failure path validates identity, withdraws advice, and retries without stale rows or focus', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  for (const state of ['preparing', 'unavailable', 'available'] as const)
    await mounted(async ({ host, render, click }) => {
      const pending = pendingReads();
      await render(h(SourceConceptView, { id, locale: 'en', role, transport: pending }));
      await pending.complete(0);
      await click('More hierarchy');
      await pending.complete(1, { id: target, state });
      expect(host.querySelector('#concept-narrower-heading')).toBeNull();
      expect(links(host)).not.toContain('Correct this fact');
      await click('Retry this page');
      expect(pending.calls[2]!.input).toEqual(pending.calls[1]!.input);
      await pending.complete(2);
      expect(links(hierarchy(host))).toEqual(['Rows next:原文']);
      await click('Refresh source and actions');
      await act(async () => pending.calls[3]!.reject());
      expect(host.querySelector('#concept-narrower-heading')).toBeNull();
      expect(links(host)).not.toContain('Correct this fact');
    });
});

test('partial refresh retains only the same native revision and receipt, while denied recovery stays explicit', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  await mounted(async ({ host, render, click }) => {
    const pending = pendingReads();
    await render(h(SourceConceptView, { id, locale: 'en', role, transport: pending }));
    await pending.complete(0);
    await click('Refresh source and actions');
    await pending.complete(1, { state: 'preparing' });
    expect(links(hierarchy(host))).toEqual(['First rows']);
    await click('Retry this page');
    await pending.complete(2, { state: 'unavailable', release: replacementRelease });
    expect(links(hierarchy(host))).toEqual([]);
    expect(host.textContent).not.toContain('Showing retained');
    await click('Retry this page');
    await pending.complete(3);
    await click('More hierarchy');
    await pending.complete(4, { state: 'unavailable', receipt: 'new-receipt' });
    expect(links(hierarchy(host))).toEqual([]);
    await click('Retry this page');
    await act(async () => pending.calls[5]!.resolve({ ok: false, reason: 'denied' }));
    expect(host.textContent).toContain('not available for the current session');
    expect(links(host)).toEqual([]);
    await click('Retry this page');
    await pending.complete(6);
    expect(links(hierarchy(host))).toEqual(['Rows next:原文']);
  });
});

test('native paging history and UTF-8 continuations are bounded; origin validation never widens graph returns', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  const { originatingClassification } = await import('../src/features/pages/source-concept-reading/origin');
  expect(originatingClassification(origin)).toBe(origin);
  for (const value of [
    origin + '?selected=secret',
    origin + '#selection',
    '//evil.test/path',
    origin.replace('/classification/', '/%2f/'),
    origin.replace('/en/', '/unknown/'),
    origin + '/extra',
  ])
    expect(originatingClassification(value)).toBeUndefined();
  await mounted(async ({ host, render, click }) => {
    const pending = pendingReads();
    await render(
      h(SourceConceptView, { id, locale: 'en', role, returnTo: origin + '?selected=secret', transport: pending }),
    );
    await pending.complete(0, { state: 'preparing' });
    expect(host.textContent).not.toContain('page is ready');
    expect(links(host)).not.toContain('Return to the selected fact');
    await click('Retry this page');
    await pending.complete(1, { next: 'page-1', state: 'lagging' });
    expect(hierarchy(host).textContent).toContain('may be behind');
    for (let index = 1; index <= 9; index++) {
      await click('More hierarchy');
      await pending.complete(index + 1, { next: `page-${index + 1}` });
    }
    expect(hierarchy(host).textContent).toContain('Only the last 8 page addresses');
    expect(hierarchy(host).textContent).toContain('Retained page 8 of 8');
    for (let index = 0; index < 7; index++) {
      await click('Previous page');
      await pending.complete(11 + index, { next: 'later' });
    }
    expect(pending.calls[17]!.input.cursor).toBe('page-2');
    expect([...host.querySelectorAll('button')].find((node) => node.textContent === 'Previous page')!.disabled).toBe(
      true,
    );
    await click('More hierarchy');
    await pending.complete(18, { next: '界'.repeat(1366) });
    expect(hierarchy(host).textContent).toContain('exceeds the reader limit');
    expect([...host.querySelectorAll('button')].find((node) => node.textContent === 'More hierarchy')!.disabled).toBe(
      true,
    );
  });
});

test('unadmitted, unsupported, hidden and exact-empty pages keep their native meaning', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  await mounted(async ({ host, render }) => {
    for (const [key, options, message] of [
      ['not-concept', { admitted: false }, 'not an admitted concept'],
      ['unsupported', { unsupported: true }, 'does not provide a narrower inverse'],
      ['hidden', { hidden: true }, 'No readable entries were returned'],
      ['exact', { empty: true, next: null }, 'native read confirms no narrower concepts'],
    ] as const) {
      const initial = await response({}, options);
      let reads = 0;
      await render(
        h(SourceConceptView, {
          key,
          id,
          locale: 'en',
          role,
          initial,
          transport: {
            read: async () => {
              reads++;
              return initial;
            },
          },
        }),
      );
      expect(host.textContent).toContain(message);
      expect(host.textContent).toContain(role);
      expect(reads).toBe(0);
      if (key === 'not-concept') expect(host.querySelector('#concept-narrower-heading')).toBeNull();
      else {
        expect(links(hierarchy(host))).toEqual([]);
        expect(hierarchy(host).textContent).not.toContain(target);
      }
      if (key !== 'exact') expect(host.textContent).not.toContain('native read confirms no narrower concepts');
    }
  });
});

test('mounted membership pages genre and keywords independently, continues sparse windows, and retires replaced-reader addresses', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const genreWork = '00000000-0000-4000-8000-00000000c010';
  const keywordWork = '00000000-0000-4000-8000-00000000c011';
  await mounted(async ({ host, render }) => {
    const pending = pendingReads();
    const show = (reader = 'reader-A', token = 'session-A') =>
      render(
        h(CandidateReaderBoundary, {
          observed: { state: 'signed-in', subject: reader, csrfToken: token },
          address: id,
          children: h(SourceConceptView, { id, locale: 'en', role, transport: pending }),
        }),
      );
    await show();
    const first = await response(pending.calls[0]!.input);
    if (!first.ok) throw new Error('expected concept');
    first.membership = {
      ...first.membership,
      state: 'available',
      exactEmpty: false,
      streams: {
        'schema:genre': {
          property: 'schema:genre',
          state: 'available',
          rows: [
            {
              id: genreWork,
              label: 'Genre work',
              lang: 'en',
              type: 'schema:VideoGame',
              property: 'schema:genre',
              workPage: true,
              citations: [{ url: 'https://vndb.org/v17' }],
            },
          ],
          next: 'genre-next',
          exactEmpty: false,
          unknownTotal: false,
          withheld: 0,
        },
        'schema:keywords': {
          property: 'schema:keywords',
          state: 'available',
          rows: [],
          next: 'keyword-next',
          exactEmpty: false,
          unknownTotal: false,
          withheld: 0,
        },
      },
      rows: [
        {
          id: genreWork,
          label: 'Genre work',
          lang: 'en',
          type: 'schema:VideoGame',
          property: 'schema:genre',
          workPage: true,
          citations: [{ url: 'https://vndb.org/v17' }],
        },
      ],
    };
    await act(async () => pending.calls[0]!.resolve(first));
    expect(host.querySelector('[data-concept-membership-property="schema:genre"]')?.textContent).toContain(
      'Genre work',
    );
    expect(host.querySelector('[data-membership-state="sparse"]')).toBeTruthy();
    const genreNext = [...host.querySelectorAll('[data-slot="concept-membership-stream"]')]
      .find((node) => node.getAttribute('data-concept-membership-property') === 'schema:genre')!
      .querySelectorAll('button');
    await act(async () => {
      const button = [...genreNext].find((node) => node.textContent === 'Show more works')!;
      expect(button.disabled).toBe(false);
      button.click();
    });
    expect(pending.calls[1]!.input).toEqual({
      membership: { 'schema:genre': 'genre-next' },
      session: 'receipt-A',
    });
    const continued = await response(pending.calls[1]!.input);
    if (!continued.ok) throw new Error('expected continued concept');
    continued.membership = {
      ...continued.membership,
      state: 'available',
      streams: {
        'schema:genre': {
          property: 'schema:genre',
          state: 'available',
          rows: [],
          cursor: 'genre-next',
          next: null,
          exactEmpty: true,
          unknownTotal: false,
          withheld: 0,
        },
        'schema:keywords': {
          property: 'schema:keywords',
          state: 'available',
          rows: [
            {
              id: keywordWork,
              label: 'Keyword work',
              lang: 'en',
              type: 'schema:Book',
              property: 'schema:keywords',
              workPage: true,
              citations: [],
            },
          ],
          next: 'keyword-next',
          exactEmpty: false,
          unknownTotal: false,
          withheld: 0,
        },
      },
      rows: [
        {
          id: keywordWork,
          label: 'Keyword work',
          lang: 'en',
          type: 'schema:Book',
          property: 'schema:keywords',
          workPage: true,
          citations: [],
        },
      ],
    };
    await act(async () => pending.calls[1]!.resolve(continued));
    expect(host.querySelector('[data-membership-state="empty"]')).toBeTruthy();
    expect(host.textContent).toContain('Keyword work');
    expect(links(hierarchy(host))).toEqual(['First rows']);
    await show('reader-B', 'session-B');
    await pending.complete(2);
    expect(pending.calls[2]!.input.membership).toBeUndefined();
    expect(pending.calls[2]!.input.cursor).toBeUndefined();
  });
});

test('a terminal empty membership window with unknown or inexact count does not claim exact zero', async () => {
  const { SourceConceptView } = await import('../src/features/pages/source-concept-view');
  await mounted(async ({ host, render }) => {
    for (const [key, stream, state] of [
      [
        'unknown',
        {
          property: 'schema:genre' as const,
          state: 'available' as const,
          rows: [],
          next: null,
          exactEmpty: false,
          unknownTotal: true,
          withheld: 0,
        },
        'unknown',
      ],
      [
        'exact',
        {
          property: 'schema:genre' as const,
          state: 'available' as const,
          rows: [],
          next: null,
          exactEmpty: true,
          unknownTotal: false,
          withheld: 0,
        },
        'empty',
      ],
    ] as const) {
      const initial = await response({});
      if (!initial.ok) throw new Error('expected concept');
      const emptyKeywords = {
        property: 'schema:keywords' as const,
        state: 'available' as const,
        rows: [],
        next: null,
        exactEmpty: true,
        unknownTotal: false,
        withheld: 0,
      };
      initial.membership = {
        state: 'available',
        rows: [],
        next: null,
        exactEmpty: stream.exactEmpty && emptyKeywords.exactEmpty,
        withheld: 0,
        streams: { 'schema:genre': stream, 'schema:keywords': emptyKeywords },
      };
      await render(
        h(SourceConceptView, {
          key,
          id,
          locale: 'en',
          role,
          initial,
          transport: { read: async () => initial },
        }),
      );
      expect(
        host.querySelector(`[data-concept-membership-property="schema:genre"][data-membership-state="${state}"]`),
      ).toBeTruthy();
    }
  });
});
