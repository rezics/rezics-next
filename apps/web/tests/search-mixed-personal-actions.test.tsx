import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DiscoveryState } from '../src/search/discovery';
import type { DiscoveryPersonalObservation } from '../src/search/discovery-personal-state';
import type { DiscoveryEntryCapability } from '../src/search/discovery-personal-actions';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DiscoveryBoundPage } from '../src/search/discovery-personal-server';

// Bun supplies the runtime binding; native transport assertions below use explicit ports.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { locales } = await import('../src/paraglide/runtime.js');
const { readDiscoveryMutationPage } = await import('../src/search/discovery');
const { createDiscoveryCommandRegistry, createDiscoveryPersonalPage } =
  await import('../src/search/discovery-personal-state');
const { changeDiscoveryEntry, discoveryEntryInput } = await import('../src/search/discovery-personal-actions');
const { DiscoveryPersonalControls, DiscoveryScoreControls } = await import('../src/search/discovery-personal-controls');
const { changeDiscoveryVote } = await import('../src/search/discovery-personal-actions');
const { discoveryExposureKey, discoveryMetadataFetch } = await import('../src/search/discovery-personal-capabilities');
const { QUESTION } = await import('../src/features/pages/subject-ratings');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { discoveryExample } = await import('../src/kernel/fake/search-discovery');
const { discoveryKey } = await import('../src/search/discovery');
const { DiscoveryResults } = await import('../src/search/discovery-results');
const { useDiscoveryPersonalResults } = await import('../src/search/discovery-personal-host');
const { readBoundDiscoveryPage } = await import('../src/search/discovery-personal-server');
const { writeQuestionBoundRatingForCurrentReader } = await import('../src/features/pages/rating-actions');
const { changePersonalLibraryEntry } = await import('../src/library/entries-read');
test('score zero and clear are independent native commands; another page incarnation sees contention', async () => {
  const registry = createDiscoveryCommandRegistry();
  const a = fixture(registry),
    b = fixture(registry);
  const waiting = deferred<'rejected'>();
  const commands: unknown[] = [];
  const run = changeDiscoveryVote({
    page: a.page,
    rowKey: 'row',
    capability: { state: 'ready', set: true, clear: true },
    units: 0,
    write: async (command) => {
      commands.push(command);
      return waiting.promise;
    },
  });
  expect(b.page.state('row', 'vote')).toBe('pending');
  expect(
    await b.page.execute('row', 'vote', async () => {
      throw new Error('duplicate dispatch');
    }),
  ).toBe('pending');
  expect(b.page.state('row', 'entry')).toBe('idle');
  a.page.dispose();
  waiting.resolve('rejected');
  expect(await run).toBe('retired');
  expect(b.page.state('row', 'vote')).toBe('idle');
  expect(
    await changeDiscoveryVote({
      page: b.page,
      rowKey: 'row',
      capability: { state: 'ready', set: true, clear: true },
      units: null,
      write: async (command) => {
        commands.push(command);
        return 'rejected';
      },
    }),
  ).toBe('rejected');
  expect(commands).toMatchObject([{ units: 0, question: { revision: 2 } }, { units: null }]);
  b.page.dispose();
});

test('private page final admission is terminal, bounded and retains ordinary public producer failures', async () => {
  const input = {
    expectedReader: 'reader',
    expectedCredential: 'credential',
    locale: 'en',
    request: { representation: 'discovery-v1' as const, text: 'title', limit: 100 },
  };
  let authorization = 'Bearer reader';
  let reads = 0;
  const ports = {
    authorize: async () => authorization,
    prepareCapabilities: async () => () => null,
    read: async () => {
      reads++;
      return empty;
    },
  };
  expect(await readBoundDiscoveryPage(input, ports)).toEqual({ state: empty, capabilities: null });
  const unavailable = {
    status: 'ready' as const,
    page: {
      ...empty.page,
      viewerFacts: { state: 'unavailable' as const, reason: 'identity' as const, retryable: true },
    },
  };
  expect((await readBoundDiscoveryPage(input, { ...ports, read: async () => unavailable })).state).toEqual(unavailable);
  const pending = deferred<DiscoveryState>();
  const reading = readBoundDiscoveryPage(input, {
    ...ports,
    read: () => {
      reads++;
      return pending.promise;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  authorization = 'Bearer other';
  pending.resolve(empty);
  expect((await reading).state).toEqual({ status: 'restart' });
  expect(reads).toBe(2);
  const caps = { release: 'x'.repeat(65536), exposure: '[]', entries: {}, vote: false };
  const bounded = await readBoundDiscoveryPage(input, { ...ports, prepareCapabilities: async () => () => caps });
  expect(bounded).toMatchObject({
    state: { page: { viewerFacts: { reason: 'response_limit' }, next: null, hits: [] } },
    capabilities: null,
  });
});

test('capability metadata shares one finite transport byte allowance across native reads', async () => {
  const fetcher = discoveryMetadataFetch(new AbortController().signal)(
    (async () => new Response('x'.repeat(600000))) as typeof fetch,
  );
  expect((await fetcher('https://kernel.invalid/release')).status).toBe(200);
  await expect(fetcher('https://kernel.invalid/exposure')).rejects.toThrow('byte bound');
});

test('guarded native BFF ports refuse credentials changed during session await and bind score question/zero/clear', async () => {
  const reader = '018f0000-0000-7000-8000-00a000000001';
  const token = 'A'.repeat(22);
  let session = { status: 'active' as const, subject: reader, csrfToken: token, accessToken: 'reader' };
  let pause: ReturnType<typeof deferred<typeof session>> | undefined;
  const env = {
    SITE_ORIGINS: 'https://site.invalid',
    AUTH_ISSUER: 'https://auth.invalid',
    API_RESOURCE: 'api',
    WEBSITE_SCOPES: 'scopes',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'key',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ credentialIfFresh: () => pause?.promise ?? Promise.resolve(session) }),
    },
  } as never;
  const request = () =>
    new Request('https://site.invalid/en/search', {
      method: 'POST',
      headers: {
        cookie: `__Host-rezics_session=${'A'.repeat(43)}`,
        origin: 'https://site.invalid',
        'x-csrf-token': token,
      },
    });
  const sent: unknown[] = [];
  const client = {
    subjects: ({ id }: { id: string }) => ({
      ratings: ({ questionId }: { questionId: string }) => ({
        vote: {
          put: async (body: unknown, options: unknown) => {
            sent.push({ id, questionId, body, options });
            return { status: 200 };
          },
          delete: async (options: unknown) => {
            sent.push({ id, questionId, options });
            return { status: 204 };
          },
        },
      }),
    }),
  } as never;
  const input = {
    subjectId: reader,
    units: 0,
    idempotencyKey: crypto.randomUUID(),
    expectedReader: reader,
    expectedCredential: token,
    question: {
      id: QUESTION,
      revision: 1,
      grain: 'work',
      meaning: 'score',
      scale: { min: 0, max: 20, displayStep: 1 },
    },
  };
  expect(await writeQuestionBoundRatingForCurrentReader(client, request(), env, input)).toBe('successful');
  expect(await writeQuestionBoundRatingForCurrentReader(client, request(), env, { ...input, units: null })).toBe(
    'successful',
  );
  expect(sent).toMatchObject([
    { questionId: QUESTION, body: { units: 0 }, options: { headers: { authorization: 'Bearer reader' } } },
    { questionId: QUESTION },
  ]);
  const wire = sent[0] as { options: { headers: Record<string, string> } };
  expect(JSON.parse(wire.options.headers['x-rating-observation']!)).toEqual({
    subjectId: reader,
    question: input.question,
  });
  pause = deferred<typeof session>();
  const stale = writeQuestionBoundRatingForCurrentReader(client, request(), env, input);
  session = { ...session, subject: 'another-reader' };
  pause.resolve(session);
  expect(await stale).toBe('rejected');
  expect(sent).toHaveLength(2);
  pause = deferred<typeof session>();
  const staleCredential = writeQuestionBoundRatingForCurrentReader(client, request(), env, input);
  pause.resolve({ ...session, subject: reader, csrfToken: 'B'.repeat(22) });
  await expect(staleCredential).rejects.toThrow();
  expect(sent).toHaveLength(2);
  pause = undefined;
  const entry = await changePersonalLibraryEntry(client, request(), env, {
    subjectId: reader,
    state: 'planned',
    expectedReader: reader,
    expectedCredential: token,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(entry).toEqual({ ok: false, reason: 'signed-out' });
  expect(sent).toHaveLength(2);
});

const empty: DiscoveryState = {
  status: 'ready',
  page: {
    hits: [],
    kinds: { values: [], next: null },
    next: null,
    as_of: '2026-11-04T00:00:00Z',
    viewerFacts: { state: 'current', question: null, rows: [] },
  },
};
const capability: DiscoveryEntryCapability = {
  state: 'ready',
  save: true,
  remove: true,
  states: [
    { id: 'planned', label: { text: 'Planned', lang: 'en' } },
    { id: 'completed', label: { text: 'Completed', lang: 'en' } },
  ],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(registry = createDiscoveryCommandRegistry()) {
  const observation: DiscoveryPersonalObservation = {
    scope: {
      viewer: 'reader',
      credential: 'credential',
      locale: 'en',
      page: 'page',
      request: 'request',
      registry: 'registry',
      generation: 'generation',
      admission: 'admission',
    },
    targets: [
      {
        rowKey: 'row',
        originalSubjectId: 'original',
        subjectId: 'resolved',
        entry: { state: 'present', entryState: 'planned', revision: 7, incarnationId: 'incarnation' },
        vote: { state: 'present', questionId: 'question', questionRevision: 2, units: 0, revision: 4 },
        question: {
          id: 'question',
          revision: 2,
          grain: 'work',
          meaning: 'score',
          scale: { min: 0, max: 100, displayStep: 1 },
        },
      },
    ],
  };
  const published: DiscoveryState[] = [];
  let refreshes = 0;
  let retirements = 0;
  const refresh = deferred<DiscoveryState>();
  const page = createDiscoveryPersonalPage({
    observation,
    observe: () => observation,
    registry,
    retirePrivate: () => {
      retirements++;
    },
    refresh: async (signal) => {
      refreshes++;
      const next = await refresh.promise;
      if (!signal.aborted) published.push(next);
    },
  });
  return { observation, page, published, refresh, counts: () => [refreshes, retirements] };
}

test('native entry inputs preserve incarnation/revision, absent entries and independent profile restrictions', () => {
  const target = structuredClone(fixture().observation.targets[0]!);
  expect(discoveryEntryInput(target, capability, { remove: true }, 'key')).toEqual({
    intent: 'entry',
    subjectId: 'resolved',
    action: 'clear',
    revision: 7,
    incarnationId: 'incarnation',
    idempotencyKey: 'key',
  });
  target.entry = { state: 'absent' };
  expect(discoveryEntryInput(target, capability, { state: 'completed' }, 'key')).toEqual({
    intent: 'entry',
    subjectId: 'resolved',
    action: 'save',
    state: 'completed',
    idempotencyKey: 'key',
  });
  expect(discoveryEntryInput(target, capability, { remove: true }, 'key')).toBeUndefined();
  expect(discoveryEntryInput(target, capability, { state: 'foreign-profile' }, 'key')).toBeUndefined();
  for (const state of ['unknown', 'signed-out', 'unsupported', 'concealed', 'unavailable'] as const)
    expect(discoveryEntryInput(target, { state }, { state: 'planned' }, 'key')).toBeUndefined();
  expect(discoveryEntryInput(target, { ...capability, save: false }, { state: 'planned' }, 'key')).toBeUndefined();
});

test('known rejection preserves facts; uncertainty retires them once and never resends', async () => {
  const f = fixture();
  const before = structuredClone(f.observation);
  const run = (result: 'conflict' | 'unavailable') =>
    changeDiscoveryEntry({
      page: f.page,
      rowKey: 'row',
      capability,
      action: { state: 'completed' },
      write: async () => ({ result }),
    });
  expect(await run('conflict')).toBe('rejected');
  expect(f.page.current()).toBe(true);
  expect(f.counts()).toEqual([0, 0]);
  const uncertain = run('unavailable');
  await Promise.resolve();
  await Promise.resolve();
  expect(f.page.current()).toBe(false);
  expect(f.counts()).toEqual([1, 1]);
  f.refresh.resolve(empty);
  expect(await uncertain).toBe('uncertain');
  expect(f.published).toEqual([empty]);
  expect(f.observation).toEqual(before);
  expect(await run('unavailable')).toBe('retired');
  expect(f.counts()).toEqual([1, 1]);
});

test('duplicate native identities serialize; independent entry/vote writes settle before one refresh', async () => {
  const f = fixture();
  // Build a new admitted page containing two kinds/routes of the same native identity.
  const observation = structuredClone(f.observation);
  observation.targets = [observation.targets[0]!, { ...observation.targets[0]!, rowKey: 'other-kind' }];
  const first = deferred<'successful'>();
  const vote = deferred<'rejected'>();
  let refreshes = 0;
  let sends = 0;
  const page = createDiscoveryPersonalPage({
    observation,
    observe: () => observation,
    registry: createDiscoveryCommandRegistry(),
    retirePrivate: () => {},
    refresh: async () => {
      refreshes++;
      return;
    },
  });
  const entryRun = page.execute('row', 'entry', async () => {
    sends++;
    return first.promise;
  });
  expect(page.state('other-kind', 'entry')).toBe('pending');
  expect(
    await page.execute('other-kind', 'entry', async () => {
      sends++;
      return 'successful';
    }),
  ).toBe('pending');
  const voteRun = page.execute('row', 'vote', async (target) => {
    expect(target.vote).toMatchObject({ units: 0 });
    expect(target.question?.revision).toBe(2);
    return vote.promise;
  });
  first.resolve('successful');
  await entryRun;
  expect(refreshes).toBe(0);
  vote.resolve('rejected');
  await voteRun;
  expect([refreshes, sends]).toEqual([1, 1]);
  expect(page.state('other-kind', 'entry')).toBe('successful');
});

test('every scope and row/question observation retires before dispatch and after an await, including ABA', async () => {
  const mutations: ((value: DiscoveryPersonalObservation) => void)[] = [
    ...Object.keys(fixture().observation.scope).map((key) => (value: DiscoveryPersonalObservation) => {
      value.scope[key as keyof typeof value.scope] += '-changed';
    }),
    (value) => {
      value.targets[0]!.rowKey += '-changed';
    },
    (value) => {
      value.targets[0]!.originalSubjectId += '-changed';
    },
    (value) => {
      value.targets[0]!.subjectId += '-changed';
    },
    (value) => {
      value.targets[0]!.question!.revision++;
    },
    (value) => {
      value.targets[0]!.question!.scale.displayStep++;
    },
    (value) => {
      value.targets[0]!.entry = { state: 'absent' };
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    const original = structuredClone(f.observation);
    const result = deferred<'successful'>();
    const running = f.page.execute('row', 'entry', async () => result.promise);
    mutate(f.observation);
    result.resolve('successful');
    expect(await running).toBe('retired');
    Object.assign(f.observation, original);
    expect(
      await f.page.execute('row', 'entry', async () => {
        throw new Error('must not dispatch');
      }),
    ).toBe('retired');
    expect(f.counts()).toEqual([0, 0]);
    expect(f.published).toEqual([]);
  }
});

test('retired refreshes abort without publication and transport failure refreshes only once', async () => {
  const f = fixture();
  const command = f.page.execute('row', 'vote', async () => {
    throw new TypeError('lost response');
  });
  await Promise.resolve();
  expect(f.page.state('row', 'vote')).toBe('uncertain');
  f.page.dispose();
  f.refresh.resolve(empty);
  expect(await command).toBe('retired');
  expect(f.published).toEqual([]);
  expect(f.counts()).toEqual([1, 1]);
});

test('post-command reads retain ordinary unavailable public pages and empty final pages, and never retry retirement', async () => {
  const request = { representation: 'discovery-v1' as const, sort: 'rating' as const, languages: ['en'] };
  const signal = new AbortController().signal;
  for (const response of [
    { status: 409, error: { code: 'search_restart_required' } },
    { status: 200, data: empty.status === 'ready' ? empty.page : null },
    {
      status: 200,
      data: {
        ...(empty.status === 'ready' ? empty.page : {}),
        viewerFacts: { state: 'unavailable', reason: 'currentness', retryable: true },
      },
    },
  ]) {
    let reads = 0;
    const result = await readDiscoveryMutationPage(
      request,
      async (_request, passedSignal) => {
        reads++;
        expect(passedSignal).toBe(signal);
        return response;
      },
      signal,
    );
    expect(reads).toBe(1);
    expect(result.status).toBe(response.status === 409 ? 'restart' : 'ready');
  }
});

test('identity and byte limits refuse whole observations, including duplicate row keys', () => {
  const base = fixture().observation;
  const make = (observation: DiscoveryPersonalObservation) =>
    createDiscoveryPersonalPage({
      observation,
      observe: () => observation,
      registry: createDiscoveryCommandRegistry(),
      refresh: async () => {},
      retirePrivate: () => {},
    });
  for (const observation of [
    { ...base, targets: Array.from({ length: 101 }, (_, i) => ({ ...base.targets[0]!, rowKey: String(i) })) },
    { ...base, targets: [{ ...base.targets[0]!, rowKey: '界'.repeat(5500) }] },
    {
      ...base,
      targets: [{ ...base.targets[0]!, question: { ...base.targets[0]!.question!, meaning: 'x'.repeat(65536) } }],
    },
  ])
    expect(() => make(observation)).toThrow(RangeError);
  expect(() => make({ ...base, targets: [base.targets[0]!, base.targets[0]!] })).toThrow(TypeError);
  expect(make({ ...base, targets: [] }).current()).toBe(true);
});

test('controlled native form preserves focus, draft and URL through rejection, with localized statuses', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/search?q=title&sort=name&kind=book#context' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const f = fixture();
  const props = {
    page: f.page,
    target: f.observation.targets[0]!,
    capability,
    locale: 'en',
    title: 'Title',
    returnTo: window.location.href,
    write: async () => ({ result: 'conflict' as const }),
  };
  try {
    await act(async () => root.render(<DiscoveryPersonalControls {...props} />));
    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = 'completed';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const submit = host.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.focus();
    await act(async () => host.querySelector('form')!.requestSubmit());
    expect(window.document.activeElement).toBe(submit);
    expect(select.value).toBe('completed');
    expect(host.querySelector('[role=status]')?.textContent).toContain('rejected');
    expect(window.location.search).toBe('?q=title&sort=name&kind=book');
    expect(window.location.hash).toBe('#context');
    for (const locale of locales) {
      const html = renderToStaticMarkup(<DiscoveryPersonalControls {...props} locale={locale} />);
      expect(html).not.toContain('discovery_personal_');
      expect(html).toContain('role="status"');
      const outcomes = ['unknown', 'signed-out', 'unsupported', 'concealed', 'unavailable'] as const;
      const messages = outcomes.map((state) =>
        renderToStaticMarkup(
          <DiscoveryScoreControls
            page={f.page}
            target={props.target}
            capability={{ state }}
            locale={locale}
            returnTo="/search"
            write={async () => 'rejected'}
          />,
        ),
      );
      expect(new Set(messages).size).toBe(5);
      expect(messages.join('')).not.toContain('discovery_score_');
    }
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test.each(['restart', 'throw', 'unavailable', 'empty', 'denied', 'ready'] as const)(
  'live mixed host settles %s, retries only the aggregate read, and retires late completion',
  async (outcome) => {
    const require = createRequire(import.meta.url);
    const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
    const window = new Window({ url: 'https://site.invalid/en/search?q=title&sort=name&kind=book#context' });
    let scroll = 0;
    Object.defineProperty(window, 'scrollY', { get: () => scroll });
    window.scrollTo = (_x: number, y: number) => {
      scroll = y;
    };
    const keys = [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'HTMLSelectElement',
      'HTMLInputElement',
      'HTMLButtonElement',
      'Element',
      'Node',
      'Document',
      'DocumentFragment',
      'MutationObserver',
      'ResizeObserver',
      'getComputedStyle',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
    ];
    const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of keys)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value:
          key === 'window'
            ? window
            : key === 'IS_REACT_ACT_ENVIRONMENT'
              ? true
              : typeof window[key] === 'function' &&
                  ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key)
                ? window[key].bind(window)
                : window[key],
      });
    const { createRoot } = await import('react-dom/client');
    const host = window.document.createElement('main') as HTMLElement;
    window.document.body.append(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reader = 'reader',
      credential = 'credential';
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: credential });
    const admitted = ['personal_library', 'library_entry.delete'];
    client.setQueryData(viewerExposureQuery({ subject: reader, id: 1 }).queryKey, { subject: reader, admitted });
    const page = structuredClone(discoveryExample);
    const book = page.hits[3]!;
    if (book.summary.kind !== 'subject') throw new Error('Expected the native Subject example');
    page.hits = [
      book,
      {
        ...book,
        key: { ...book.key, kind: 'schema:CreativeWork' },
        summary: { kind: 'subject', value: { ...book.summary.value, type: 'schema:CreativeWork' } },
      },
    ];
    const incarnationId = crypto.randomUUID();
    page.viewerFacts = {
      state: 'current',
      question: {
        id: QUESTION,
        revision: 1,
        grain: 'work',
        meaning: 'score',
        scale: { min: 0, max: 20, displayStep: 1 },
      },
      rows: page.hits.map((hit) => ({
        rowKey: discoveryKey(hit),
        subjectId: hit.key.id,
        resolvedSubjectId: hit.key.id,
        entry: { state: 'present', entryState: 'planned', revision: 7, incarnationId },
        vote: { state: 'present', questionId: QUESTION, questionRevision: 1, units: 0, revision: 4 },
      })),
    };
    const source: DiscoveryState = { status: 'ready', page };
    const bound: DiscoveryBoundPage = {
      state: source,
      capabilities: {
        release: 'release',
        exposure: discoveryExposureKey(admitted),
        entries: { 'schema:Book': capability, 'schema:CreativeWork': capability },
        vote: true,
      },
    };
    let refresh = deferred<DiscoveryBoundPage>();
    const entry = deferred<{ result: 'saved' }>(),
      vote = deferred<'rejected'>();
    let reads = 0;
    const writes: unknown[] = [];
    const signals: AbortSignal[] = [];
    function Live({ locale = 'en' }: { locale?: string }) {
      const personal = useDiscoveryPersonalResults({
        enabled: true,
        source,
        request: { representation: 'discovery-v1', text: 'title', limit: 100 },
        locale,
        returnTo: window.location.href,
        read: async ({ data, signal }) => {
          signals.push(signal);
          expect(data.expectedCredential).toBe(credential);
          reads++;
          return reads === 1 || reads === (outcome === 'throw' || outcome === 'unavailable' ? 4 : 3)
            ? bound
            : refresh.promise;
        },
        writeEntry: async (command) => {
          writes.push(command);
          return entry.promise as never;
        },
        writeVote: async (command) => {
          writes.push(command);
          return vote.promise;
        },
      });
      return (
        <section ref={personal.regionRef} tabIndex={-1}>
          {personal.recoveryView}
          <DiscoveryResults
            state={personal.state!}
            locale={locale}
            restartHref="/en/search?q=title&sort=name&kind=book"
            renderPersonal={personal.renderPersonal}
          />
        </section>
      );
    }
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Live />
          </QueryClientProvider>,
        ),
      );
      expect(host.querySelectorAll('select')).toHaveLength(2);
      expect(host.querySelector('[data-slot=rating-control-value]')?.textContent).toContain('0');
      const select = host.querySelector('select')!;
      await act(async () => {
        select.value = 'completed';
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      const submit = host.querySelector<HTMLButtonElement>('button[type=submit]')!;
      submit.focus();
      window.scrollTo(0, 210);
      await act(async () => host.querySelector('form')!.requestSubmit());
      expect(host.querySelectorAll('select')[1]!.getAttribute('aria-disabled')).toBe('true');
      const tab = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      select.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
      const clear = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.includes('Clear'),
      )!;
      await act(async () => clear.click());
      expect(writes).toMatchObject([
        { expectedReader: reader, expectedCredential: credential, state: 'completed', revision: 7 },
        {
          expectedReader: reader,
          expectedCredential: credential,
          units: null,
          question: { id: QUESTION, revision: 1 },
        },
      ]);
      await act(async () => entry.resolve({ result: 'saved' }));
      expect(reads).toBe(1);
      expect(host.querySelectorAll('select')).toHaveLength(0);
      expect(host.querySelector('[data-slot=rating-control-value]')).toBeNull();
      await act(async () => vote.resolve('rejected'));
      expect(reads).toBe(2);
      if (outcome === 'throw' || outcome === 'unavailable') {
        await act(async () => {
          if (outcome === 'throw') refresh.reject(new TypeError('aggregate response lost'));
          else refresh.resolve({ state: { status: 'unavailable' }, capabilities: null });
        });
        expect(host.querySelectorAll('select')).toHaveLength(0);
        expect(host.textContent).not.toContain('Planned');
        expect(host.querySelectorAll('[data-discovery-personal-row]')).toHaveLength(2);
        const retry = host.querySelector<HTMLButtonElement>('[data-discovery-read-retry]')!;
        expect(window.document.activeElement).toBe(retry);
        refresh = deferred<DiscoveryBoundPage>();
        await act(async () => {
          retry.click();
          retry.click();
        });
        expect(reads).toBe(3);
        expect(writes).toHaveLength(2);
      }
      const fresh = structuredClone(page);
      if (fresh.viewerFacts?.state === 'current')
        for (const row of fresh.viewerFacts.rows)
          row.entry = { state: 'present', entryState: 'completed', revision: 8, incarnationId };
      const settlement: DiscoveryBoundPage =
        outcome === 'ready'
          ? { state: { status: 'ready', page: fresh }, capabilities: bound.capabilities }
          : outcome === 'empty'
            ? { state: empty, capabilities: null }
            : { state: { status: outcome === 'denied' ? 'denied' : 'restart' }, capabilities: null };
      await act(async () => refresh.resolve(settlement));
      expect(window.document.activeElement).toBe(
        outcome === 'ready'
          ? host.querySelector('[data-discovery-personal-row] select')
          : outcome === 'empty'
            ? host.querySelector('section')
            : host.querySelector('[data-discovery-restart]'),
      );
      expect(window.scrollY).toBe(210);
      expect(window.location.search).toBe('?q=title&sort=name&kind=book');
      expect(window.location.hash).toBe('#context');
      expect(host.querySelectorAll('select')).toHaveLength(outcome === 'ready' ? 2 : 0);
      if (outcome === 'ready') expect(host.querySelector('select')?.value).toBe('completed');
      refresh = deferred<DiscoveryBoundPage>();
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <Live locale="fr" />
          </QueryClientProvider>,
        ),
      );
      const beforeCancel = outcome === 'throw' || outcome === 'unavailable' ? 4 : 3;
      expect(reads).toBe(beforeCancel);
      const cancelling = host.querySelector<HTMLButtonElement>('button[type=submit]')!;
      cancelling.focus();
      await act(async () => host.querySelector('form')!.requestSubmit());
      expect(reads).toBe(beforeCancel + 1);
      await act(async () =>
        client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null }),
      );
      expect(signals[beforeCancel]!.aborted).toBe(true);
      await act(async () => {
        if (outcome === 'throw') refresh.reject(new TypeError('retired aggregate failure'));
        else refresh.resolve(bound);
      });
      expect(host.querySelectorAll('select')).toHaveLength(0);
      expect(window.document.activeElement).not.toBe(cancelling);
      expect(window.scrollY).toBe(210);
      expect(host.textContent).not.toContain('Planned');
      expect(reads).toBe(beforeCancel + 1);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      await window.happyDOM.abort();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  },
);
