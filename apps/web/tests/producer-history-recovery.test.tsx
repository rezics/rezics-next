import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { producerRecoveryExample } from '../src/features/pages/producer-history-reading/examples';
import type { ProducerHistoryRead } from '../src/features/catalogue/producer-history';
import type { ProducerHistoryTransport } from '../src/features/pages/producer-history';
import type { RelationProposal, RelationProposalResult } from '../src/subject/relation-candidates';

mock.module('cloudflare:workers', () => ({ env: {} }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mounted() {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/subjects/studio/producer', width: 390 });
  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { ProducerHistoryPage } = await import('../src/features/pages/producer-history');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const show = async (
    transport: ProducerHistoryTransport,
    initial?: ProducerHistoryRead,
    locale = 'en',
    reader = 'original-reader',
  ) =>
    act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(
            CandidateReaderBoundary,
            {
              observed: { state: 'signed-in', subject: reader, csrfToken: `token-${reader}` },
              address: `${locale}:producer`,
            },
            h(ProducerHistoryPage, {
              id: producerRecoveryExample().fixture.id,
              locale,
              transport,
              initial,
              search: async () => [],
            }),
          ),
        ),
      ),
    );
  const button = (name: string, region: ParentNode = host) => {
    const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name);
    if (!found) throw new Error(`Missing button: ${name}`);
    return found;
  };
  const click = async (name: string, region: ParentNode = host) => act(async () => button(name, region).click());
  const change = async (value: string) =>
    act(async () => {
      const select = host.querySelector('select')!;
      select.value = value;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  return {
    host,
    window,
    clear: () => act(async () => root.render(null)),
    show,
    click,
    button,
    change,
    m,
    async close() {
      await act(async () => root.unmount());
      client.clear();
      await window.happyDOM.abort();
      for (const [key, value] of saved)
        value ? Object.defineProperty(globalThis, key, value) : Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('initial unavailable read has safe recovery; an empty admission and a concealed occurrence are distinct', async () => {
  const ui = await mounted();
  const example = producerRecoveryExample();
  try {
    const initial = deferred<ProducerHistoryRead>();
    let firstRead = true;
    await ui.show({
      ...example.transport,
      read: (...args) => (firstRead ? initial.promise : example.transport.read(...args)),
    });
    expect(ui.host.textContent).toContain(ui.m.candidate_loading());
    firstRead = false;
    await act(async () => initial.resolve({ ok: false, reason: 'unavailable' }));
    expect(ui.host.textContent).toContain(ui.m.producer_history_unavailable());
    expect(ui.host.textContent).not.toContain(ui.m.producer_history_concealed());
    expect(ui.host.querySelector('a')?.textContent).toBe(ui.m.producer_history_back());
    await ui.click(ui.m.producer_history_retry());
    expect(example.reads).toEqual([{ stream: undefined, cursor: undefined, session: undefined }]);
    expect(ui.host.querySelectorAll('li[data-slot="list-row"]').length).toBe(1);
    await ui.show(
      { ...example.transport, read: async () => ({ ...example.first, rows: [], next: null }) },
      example.first,
      'en',
      'empty-reader',
    );
    await ui.click(ui.m.candidate_reload());
    expect(ui.host.textContent).toContain(ui.m.producer_history_empty());
    const hidden = { ...example.first.rows[0]!, summary: null, statement: undefined };
    await ui.show(example.transport, { ...example.first, rows: [hidden] }, 'en', 'concealed-reader');
    await ui.click(ui.m.producer_history_inspect());
    expect(ui.host.textContent).toContain(ui.m.producer_history_concealed());
    expect(ui.host.innerHTML).not.toContain(hidden.statementId);
    expect([...ui.host.querySelectorAll('a')].some((a) => a.href.includes(example.fixture.parent.subject.id))).toBe(
      false,
    );
    expect([...ui.host.querySelectorAll('button')].some((b) => b.textContent === ui.m.producer_history_correct())).toBe(
      false,
    );
  } finally {
    await ui.close();
  }
});

test('failed continuation retries the exact page and session; reload keeps the page while Restart requests fresh admission', async () => {
  const ui = await mounted();
  const example = producerRecoveryExample('failed');
  try {
    await ui.show(example.transport, example.first);
    const next = ui.button(ui.m.producer_history_more());
    next.focus();
    await ui.click(ui.m.producer_history_more());
    expect(ui.host.textContent).toContain(ui.m.producer_history_unavailable());
    expect(ui.host.querySelector('ul')).toBeNull();
    expect(ui.host.querySelector('select')).toBeNull();
    expect(ui.window.document.activeElement?.getAttribute('role')).not.toBe('alert');
    ui.button(ui.m.producer_history_retry()).focus();
    await ui.click(ui.m.producer_history_retry());
    expect(ui.window.document.activeElement?.tagName).toBe('H2');
    expect(example.reads.slice(0, 2)).toEqual(
      Array(2).fill({ stream: example.first.stream!.key, cursor: 'native-next', session: 'producer-session' }),
    );
    expect(ui.host.textContent).toContain(ui.m.producer_history_later_page());
    expect(ui.host.textContent).toContain('Lantern Studio Inc');
    await ui.click(ui.m.candidate_reload());
    expect(example.reads[2]?.cursor).toBe('native-next');
    await ui.click(ui.m.producer_history_restart());
    expect(example.reads[3]).toEqual({ stream: example.first.stream!.key, cursor: undefined, session: undefined });
    expect(ui.host.textContent).toContain(ui.m.producer_history_first_page());
    await ui.show(
      { ...example.transport, read: async () => ({ ok: false, reason: 'stale' }) },
      example.first,
      'en',
      'stale-reader',
    );
    await ui.click(ui.m.producer_history_more());
    expect(ui.host.textContent).toContain(ui.m.producer_history_reader_stale());
    expect([...ui.host.querySelectorAll('button')].some((b) => b.textContent === ui.m.producer_history_retry())).toBe(
      false,
    );
    expect(ui.host.querySelector('ul')).toBeNull();
  } finally {
    await ui.close();
  }
});

test('A/B/A and equal-page replacement reject late slices; locale/account retirement and moved focus cannot be undone', async () => {
  const ui = await mounted();
  const example = producerRecoveryExample();
  const pending: ReturnType<typeof deferred<ProducerHistoryRead>>[] = [];
  const transport: ProducerHistoryTransport = {
    ...example.transport,
    read: () => {
      const request = deferred<ProducerHistoryRead>();
      pending.push(request);
      return request.promise;
    },
  };
  const result = (key: string, label: string): ProducerHistoryRead => ({
    ...example.first,
    stream: example.first.streams.find((s) => s.key === key)!,
    rows: [
      {
        ...example.first.rows[0]!,
        summary: { ...example.first.rows[0]!.summary!, label: { language: 'en', value: label } },
      },
    ],
  });
  try {
    await ui.show(transport, example.first);
    const a = example.first.stream!.key;
    const b = example.first.streams[1]!.key;
    await ui.change(b);
    await ui.change(a);
    expect(ui.host.querySelector('ul')).toBeNull();
    await act(async () => pending[1]!.resolve(result(a, 'Newest A')));
    await act(async () => pending[0]!.resolve(result(b, 'Older B')));
    expect(ui.host.textContent).toContain('Newest A');
    expect(ui.host.textContent).not.toContain('Older B');
    // Replace the same successful page with identical descriptors twice.
    await ui.click(ui.m.candidate_reload());
    await ui.change(b);
    await ui.change(a);
    const back = ui.host.querySelector('a')!;
    back.focus();
    await act(async () => pending[4]!.resolve(result(a, 'Latest equal A')));
    await act(async () => pending[2]!.resolve(result(a, 'Obsolete equal A')));
    await act(async () => pending[3]!.resolve(result(b, 'Obsolete B')));
    expect(ui.host.textContent).toContain('Latest equal A');
    expect(ui.host.textContent).not.toContain('Obsolete');
    expect(ui.window.document.activeElement).toBe(back);
    await ui.click(ui.m.candidate_reload());
    await ui.show(transport, example.first, 'ja');
    await ui.show(transport, example.first, 'en');
    await act(async () => pending[5]!.resolve(result(a, 'Retired locale')));
    expect(ui.host.textContent).not.toContain('Retired locale');
    await ui.click(ui.m.candidate_reload());
    await ui.show(transport, example.first, 'en', 'other-reader');
    await ui.show(transport, example.first);
    await act(async () => pending[6]!.resolve(result(a, 'Retired account')));
    expect(ui.host.textContent).not.toContain('Retired account');
    ui.button(ui.m.candidate_reload()).focus();
    await ui.click(ui.m.candidate_reload());
    const destination = ui.host.querySelector('a')!;
    destination.focus();
    await act(async () => pending[7]!.resolve(result(a, 'Deliberate reload')));
    expect(ui.window.document.activeElement).toBe(destination);
    await ui.click(ui.m.candidate_reload());
    await ui.clear();
    await act(async () => pending[8]!.resolve(result(a, 'After unmount')));
    expect(ui.host.textContent).toBe('');
  } finally {
    await ui.close();
  }
});

test('equal labels and repeated statement IDs keep correction admission on the selected inverse occurrence', async () => {
  const ui = await mounted();
  const example = producerRecoveryExample();
  const inverse = example.first.streams.find((stream) => stream.key === 'inverse:wdt:P749')!;
  const rows = [example.fixture.parent, example.fixture.similar].map((subject) => ({
    ...structuredClone(example.first.rows[0]!),
    holder: subject.subject.id,
    summary: {
      ...example.first.rows[0]!.summary!,
      id: subject.subject.id,
      label: { language: 'en', value: 'Same visible label' },
    },
    statement: { ...example.first.rows[0]!.statement!, value: { type: 'value' as const, content: example.fixture.id } },
  }));
  const holders: string[] = [];
  const reads: unknown[][] = [];
  try {
    await ui.show(
      {
        ...example.transport,
        relation: (holder) => {
          holders.push(holder);
          return {
            ...example.relation,
            read: async (...args) => {
              reads.push(args);
              return { ok: false, reason: 'unavailable' };
            },
          };
        },
      },
      { ...example.first, stream: inverse, rows },
    );
    const occurrences = ui.host.querySelectorAll('li[data-slot="list-row"]');
    await ui.click(ui.m.producer_history_correct(), occurrences[1]!);
    expect(holders.at(-1)).toBe(example.fixture.similar.subject.id);
    expect(ui.host.textContent).toContain(ui.m.producer_history_inverse());
    await ui.click(ui.m.relation_open());
    expect(reads).toEqual([[{ property: 'wdt:P749', target: example.fixture.id }, undefined, 'producer-session']]);
    expect(holders).not.toContain(example.fixture.parent.subject.id);
    expect(ui.button(ui.m.producer_history_inspect(), occurrences[0]!).disabled).toBe(true);
    expect(ui.host.querySelectorAll('section[id$="-detail"]').length).toBe(1);
    await ui.click(ui.m.producer_history_inspect(), occurrences[0]!);
    expect(ui.host.querySelectorAll('section[id$="-detail"]').length).toBe(1);
    expect(holders.at(-1)).toBe(example.fixture.similar.subject.id);
  } finally {
    await ui.close();
  }
});

test('uncertain retry retains the original command; failed reader retirement never replays a pending correction under new admission', async () => {
  const ui = await mounted();
  const example = producerRecoveryExample('retired');
  const commands: RelationProposal[] = [];
  const pending = deferred<RelationProposalResult>();
  const transport: ProducerHistoryTransport = {
    ...example.transport,
    relation: () => ({
      ...example.relation,
      propose: async (command) => {
        commands.push(structuredClone(command));
        return commands.length === 1 ? { ok: false, reason: 'unavailable' } : pending.promise;
      },
    }),
  };
  try {
    await ui.show(transport, example.first);
    await ui.click(ui.m.producer_history_correct());
    await ui.click(ui.m.relation_open());
    await ui.click(ui.m.relation_propose());
    const group = () =>
      [...ui.host.querySelectorAll('[role="group"]')].find(
        (node) => node.getAttribute('aria-label') === ui.m.candidate_confirm_title({ action: ui.m.relation_propose() }),
      )!;
    await ui.click(ui.m.relation_propose(), group());
    expect(commands.length).toBe(1);
    await ui.click(ui.m.relation_propose(), group());
    expect(commands[1]).toEqual({ ...commands[0]!, retry: true });
    const immutable = structuredClone(commands);
    await ui.click(ui.m.producer_history_more());
    expect(ui.host.textContent).toContain(ui.m.producer_history_correction_retired());
    expect(ui.host.textContent).toContain(ui.m.producer_history_retired_explanation());
    expect(ui.host.querySelector('[aria-label="' + ui.m.relation_title() + '"]')).toBeNull();
    await act(async () => pending.resolve({ ok: true, candidate: 'late-candidate', session: 'late-session' }));
    await ui.click(ui.m.producer_history_restart());
    expect(ui.host.textContent).toContain(ui.m.producer_history_correction_retired());
    expect(commands).toEqual(immutable);
    expect(example.reads.at(-1)?.session).toBeUndefined();
    await ui.click(ui.m.producer_history_retired_close());
    expect(ui.host.textContent).not.toContain(ui.m.producer_history_correction_retired());
    expect(commands).toEqual(immutable);
  } finally {
    await ui.close();
  }
});
