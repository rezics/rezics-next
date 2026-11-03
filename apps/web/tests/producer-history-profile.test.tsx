import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  producerHistoryCorrection,
  producerHistoryStreams,
  producerHistoryUnreleased,
  readProducerHistory,
} from '../src/features/catalogue/producer-history';
import {
  producerHistoryFixture,
  producerParentId,
  producerSimilarId,
  producerStudioId,
} from '../src/kernel/fake/producer-history';
import { catalogueEntries } from '../src/features/catalogue/catalogue-entry';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('producer history binds admitted direction and inverse, keeps similar names distinct, and continues a bounded native page', async () => {
  expect(producerHistoryStreams(bundledRelease, 'schema:Organization', 'en')).toEqual([]);
  expect(producerHistoryUnreleased(bundledRelease, 'schema:Organization').map((item) => item.meaning)).toEqual([
    'parent',
    'predecessor',
    'successor',
  ]);
  const fixture = producerHistoryFixture('partial');
  expect(producerHistoryStreams(fixture.release, 'schema:Organization', 'en').map((stream) => [stream.meaning, stream.direction, stream.property])).toEqual([
    ['parent', 'forward', 'wdt:P749'],
    ['subsidiary', 'inverse', 'wdt:P749'],
    ['predecessor', 'forward', 'wdt:P1365'],
    ['successor', 'inverse', 'wdt:P1365'],
    ['successor', 'forward', 'wdt:P1366'],
    ['predecessor', 'inverse', 'wdt:P1366'],
  ]);
  const first = await fixture.transport.read();
  if (!first.ok || !first.stream) throw new Error('Expected admitted parent stream');
  expect(first.rows.map((row) => row.summary?.id)).toEqual([producerParentId]);
  expect(first.next).toBe('native-next');
  expect(first.caughtUp).toBe(false);
  const next = await fixture.transport.read(first.stream.key, first.next!, first.session);
  expect(next.ok && next.rows.map((row) => [row.summary?.id, row.summary?.label?.value])).toEqual([
    [producerSimilarId, 'Lantern Studio Inc'],
  ]);
  expect(next.ok && next.rows[0]!.summary?.id).not.toBe(producerParentId);
  expect(fixture.calls.filter((call) => call.path.endsWith('/relations')).map((call) => call.query.cursor)).toEqual([
    undefined,
    'native-next',
  ]);
  expect(
    await readProducerHistory(fixture.client, 'Bearer contributor', fixture.release, producerStudioId, 'en', undefined, 'native-next'),
  ).toEqual({ ok: false, reason: 'invalid' });
  const inverse = await fixture.transport.read('inverse:wdt:P749');
  expect(inverse.ok && inverse.stream?.meaning).toBe('subsidiary');
  expect(inverse.ok && inverse.rows[0]?.summary?.id).toBe(producerSimilarId);
  const concealed = producerHistoryFixture('concealed');
  const hidden = await concealed.transport.read();
  expect(hidden.ok && hidden.rows[0]?.statement).toBeUndefined();
  expect(hidden.ok && producerHistoryCorrection(hidden.rows[0]!, hidden.stream!)).toBeUndefined();
  expect(await producerHistoryFixture('denied').transport.read()).toEqual({ ok: false, reason: 'denied' });
  expect(catalogueEntries.producerHistory({ id: producerStudioId, label: 'Lantern Studio', locale: 'en' }).href).toContain(
    '/producer',
  );
});

test('producer history page names unreleased fields, similar organizations, continuation and stale reselection', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/subjects/studio/lantern/producer' });
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Document',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { ProducerHistoryPage } = await import('../src/features/pages/producer-history');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  async function show(node: ReactNode) {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(
            CandidateReaderBoundary,
            {
              observed: { state: 'signed-in', subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', csrfToken: 'token' },
              address: 'producer-history',
            },
            node,
          ),
        ),
      ),
    );
  }
  try {
    const closed = producerHistoryFixture('empty');
    await show(
      h(ProducerHistoryPage, {
        id: closed.id,
        locale: 'en',
        search: async () => [],
        transport: closed.transport,
        initial: {
          ok: true,
          public: closed.studio,
          streams: [],
          unreleased: producerHistoryUnreleased(bundledRelease, 'schema:Organization'),
          rows: [],
          labels: {},
          next: null,
          caughtUp: true,
        },
      }),
    );
    expect(host.textContent).toContain(m.producer_history_unreleased());
    expect(host.textContent).toContain(m.producer_history_parent());
    expect(host.textContent).toContain(m.producer_history_no_stream());

    const current = producerHistoryFixture('current');
    const initial = current.snapshot();
    if (!initial.ok) throw new Error('Expected two similar organizations');
    initial.next = 'native-next';
    initial.caughtUp = false;
    await show(
      h(ProducerHistoryPage, {
        key: 'current',
        id: current.id,
        locale: 'en',
        search: async () => [],
        transport: current.transport,
        initial,
      }),
    );
    expect(host.textContent).toContain('Lantern Studio');
    expect(host.textContent).toContain('Lantern Studio Inc');
    expect(host.textContent).toContain(m.producer_history_incomplete());
    expect([...host.querySelectorAll('a')].some((link) => link.getAttribute('href')?.endsWith('/producer'))).toBe(true);
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === m.producer_history_more())).toBe(
      true,
    );
    expect([...host.querySelectorAll('a')].some((link) => link.textContent === m.producer_history_return())).toBe(true);
    const correct = [...host.querySelectorAll('button')].find((button) => button.textContent === m.producer_history_correct())!;
    await act(async () => correct.click());
    const buttons = [...host.querySelectorAll('button')].filter(
      (button) => button.textContent === m.producer_history_correct() || button.textContent === m.producer_history_stale(),
    );
    expect(buttons.some((button) => button.textContent === m.producer_history_stale() && button.disabled)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
