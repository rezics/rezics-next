import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { locales } from '../src/paraglide/runtime.js';
import { readDiscoveryMutationPage, type DiscoveryState } from '../src/search/discovery';
import {
  createDiscoveryCommandRegistry,
  createDiscoveryPersonalPage,
  type DiscoveryPersonalObservation,
} from '../src/search/discovery-personal-state';
import {
  changeDiscoveryEntry,
  discoveryEntryInput,
  type DiscoveryEntryCapability,
} from '../src/search/discovery-personal-actions';
import { DiscoveryPersonalControls } from '../src/search/discovery-personal-controls';

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
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    publish: (state) => {
      published.push(state);
    },
    refresh: async () => {
      refreshes++;
      return refresh.promise;
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
    publish: () => {},
    refresh: async () => {
      refreshes++;
      return empty;
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
      refresh: async () => empty,
      publish: () => {},
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
