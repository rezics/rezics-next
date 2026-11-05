import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SubjectRead } from '@rezics/client';
import type { QuotationAssertion, QuotationRead } from '../src/features/catalogue/quotation';
import type { QuotationTransport } from '../src/features/pages/quotation-view';
import { QuotationView } from '../src/features/pages/quotation-view';
import { CandidateReaderBoundary } from '../src/subject/candidate-lifetime';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { browserObservation } from '../src/session/observation';
import recordedSubject from '../src/kernel/recorded/subject.json';

mock.module('cloudflare:workers', () => ({ env: {} }));

const work = '00000000-0000-4000-8000-000000000941';
const quote = '00000000-0000-4000-8000-000000000942';
const speaker = '00000000-0000-4000-8000-000000000943';
const contextA = '00000000-0000-4000-8000-000000000944';
const contextB = '00000000-0000-4000-8000-000000000945';

function assertion(context: string, id: string, property: string, target?: string): QuotationAssertion {
  const statement = {
    id,
    rank: 'normal' as const,
    property: { id: property, data_type: target ? 'wikibase-item' : 'monolingualtext' },
    value: target ? { type: 'value' as const, content: target } : { type: 'value' as const, content: { text: 'A cited line', language: 'en' } },
    qualifiers: [],
    references: [],
  } as QuotationAssertion['statement'];
  return { holder: quote, context, release: 'sha256:quotation-release', revision: 1, statement };
}

function reading(context: string, observation = 'current') {
  const publicRead = structuredClone(recordedSubject) as unknown as SubjectRead;
  publicRead.subject.id = work;
  publicRead.subject.context = context;
  const selected = {
    id: quote,
    state: 'current' as const,
    observation: `${quote}\u0000${context}\u0000${observation}`,
    contexts: [
      {
        kind: 'speaker' as const,
        status: 'current' as const,
        property: 'schema:spokenByCharacter',
        statementId: '00000000-0000-4000-8000-000000000946',
        assertion: assertion(context, '00000000-0000-4000-8000-000000000946', 'schema:spokenByCharacter', speaker),
        id: speaker,
        label: 'Shared person',
      },
      {
        kind: 'credited' as const,
        status: 'current' as const,
        property: 'schema:creator',
        statementId: '00000000-0000-4000-8000-000000000947',
        assertion: assertion(context, '00000000-0000-4000-8000-000000000947', 'schema:creator', speaker),
        id: speaker,
        label: 'Shared person',
      },
    ],
    statements: [
      {
        statementId: '00000000-0000-4000-8000-000000000948',
        property: 'schema:text',
        status: 'current' as const,
        assertion: assertion(context, '00000000-0000-4000-8000-000000000948', 'schema:text'),
        text: `A cited line ${observation}`,
        language: 'en',
        qualifiers: [],
        references: [],
        sourceStatus: 'unknown' as const,
        spoiler: false,
      },
    ],
  };
  return {
    ok: true,
    public: publicRead,
    admitted: true,
    rows: [selected],
    selected,
    next: null,
    observation: `work:${context}`,
    unsupportedCount: 0,
    actions: [{ action: 'statement:propose', operationId: 'subject.propose', state: 'unsupported' }],
    viewerActions: {
      subject: { state: 'available', actions: [{ action: 'statement:propose', operations: ['subject.propose'] }] },
      context: { state: 'available', actions: [] },
    },
  } as QuotationRead;
}

async function harness(url: string) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url });
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof typeof window],
    });
  const host = document.createElement('main');
  document.body.append(host);
  const root = (await import('react-dom/client')).createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stopObservation = browserObservation(client).subscribe(() => {});
  setLocale('en', { reload: false });
  const mount = async (context: string, transport: QuotationTransport, initial?: QuotationRead, reader?: string) =>
    act(async () => {
      const quote = new URL(window.location.href).searchParams.get('quote') ?? undefined;
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(
            CandidateReaderBoundary,
            {
              observed: reader
                ? { state: 'signed-in', subject: reader, csrfToken: `${reader}-csrf` }
                : { state: 'signed-out', csrfToken: 'reader' },
              address: `${work}:${context}`,
            },
            h(QuotationView, { id: work, locale: 'en', context, quote, transport, initial }),
          ),
        ),
      );
    });
  return {
    window,
    host,
    root,
    client,
    mount,
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
      stopObservation();
      await window.happyDOM.abort();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('an explicit Context survives a disclosed target return and duplicate targets keep both assertions', async () => {
  const ui = await harness(`https://site.invalid/en/subjects/${work}/work/quotations?context=${contextA}`);
  const calls: Parameters<QuotationTransport['read']>[0][] = [];
  const transport: QuotationTransport = {
    read: async (input) => {
      calls.push(input);
      return reading(contextA);
    },
  };
  try {
    await ui.mount(contextA, transport, reading(contextA));
    const links = [...ui.host.querySelectorAll(`a[href*="/subjects/${speaker}/"]`)];
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.parentElement?.getAttribute('data-statement-id'))).toEqual([
      '00000000-0000-4000-8000-000000000946',
      '00000000-0000-4000-8000-000000000947',
    ]);
    const target = new URL(links[0]!.getAttribute('href')!, ui.window.location.origin);
    expect(target.searchParams.get('context')).toBe(contextA);
    const via = target.searchParams.get('via')!;
    expect(via).toContain('quotationReturn=');
    await act(async () => links[0]!.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    await act(async () => ui.root.render(null));
    ui.window.history.replaceState(null, '', via);
    await ui.mount(contextA, transport);
    expect(calls.at(-1)?.context).toBe(contextA);
    expect(ui.host.textContent).toContain('A cited line current');
    expect(document.activeElement?.tagName).toBe('H2');
  } finally {
    await ui.cleanup();
  }
});

test('a changed assertion explains the replacement and Context A/B/A retires late readers', async () => {
  const ui = await harness(`https://site.invalid/en/subjects/${work}/work/quotations?context=${contextA}`);
  const pending: { context: string; resolve: (result: QuotationRead) => void }[] = [];
  const transport: QuotationTransport = {
    read: (input) =>
      new Promise((resolve) => {
        pending.push({ context: input.context!, resolve });
      }),
  };
  try {
    await ui.mount(contextA, transport, reading(contextA));
    const target = ui.host.querySelector(`a[href*="/subjects/${speaker}/"]`)!;
    const via = new URL(target.getAttribute('href')!, ui.window.location.origin).searchParams.get('via')!;
    await act(async () => target.dispatchEvent(new ui.window.MouseEvent('click', { bubbles: true, cancelable: true })));
    await act(async () => ui.root.render(null));
    ui.window.history.replaceState(null, '', via);
    pending.length = 0;
    const changed: QuotationTransport = {
      read: async () => reading(contextA, 'replacement'),
    };
    await ui.mount(contextA, changed);
    expect(ui.host.textContent).toContain(m.quotation_reading_changed());
    expect(ui.host.textContent).not.toContain('A cited line current');
    expect(document.activeElement?.getAttribute('role')).toBe('alert');

    const delayed: QuotationTransport = {
      read: (input) =>
        new Promise((resolve) => {
          pending.push({ context: input.context!, resolve });
        }),
    };
    ui.window.history.replaceState(null, '', `/en/subjects/${work}/work/quotations?context=${contextA}`);
    await act(async () => ui.root.render(null));
    await ui.mount(contextA, delayed);
    await ui.mount(contextB, delayed);
    await ui.mount(contextA, delayed);
    expect(pending.map((entry) => entry.context)).toEqual([contextA, contextB, contextA]);
    await act(async () => pending[2]!.resolve(reading(contextA, 'latest A')));
    await act(async () => {
      pending[0]!.resolve(reading(contextA, 'old A'));
      pending[1]!.resolve(reading(contextB, 'old B'));
    });
    expect(ui.host.textContent).toContain('A cited line latest A');
    expect(ui.host.textContent).not.toContain('A cited line old');

    pending.length = 0;
    await ui.mount(contextA, delayed, undefined, 'reader-two');
    await ui.mount(contextA, delayed, undefined, 'reader-three');
    expect(pending.map((entry) => entry.context)).toEqual([contextA, contextA]);
    await act(async () => pending[1]!.resolve(reading(contextA, 'current caller')));
    await act(async () => pending[0]!.resolve(reading(contextA, 'replaced caller')));
    expect(ui.host.textContent).toContain('A cited line current caller');
    expect(ui.host.textContent).not.toContain('A cited line replaced caller');
  } finally {
    await ui.cleanup();
  }
});

test('a response admitted under another Context is not rendered', async () => {
  const ui = await harness(`https://site.invalid/en/subjects/${work}/work/quotations?context=${contextA}`);
  try {
    await ui.mount(contextA, { read: async () => reading(contextB) });
    expect(ui.host.textContent).toContain(m.quotation_reading_changed());
    expect(ui.host.textContent).not.toContain('A cited line current');
    expect(document.activeElement?.getAttribute('role')).toBe('alert');
  } finally {
    await ui.cleanup();
  }
});
