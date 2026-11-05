import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import type { SubjectRead } from '@rezics/client';
import type { QuotationRead, QuotationRow } from '../src/features/catalogue/quotation';
import type { QuotationTransport } from '../src/features/pages/quotation-view';
import { candidateContext } from '../src/subject/candidates';
import recorded from '../src/kernel/recorded/subject.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const id = '00000000-0000-4000-8000-000000000001';
const first = '00000000-0000-4000-8000-000000000002';
const later = '00000000-0000-4000-8000-000000000003';
function row(id: string): QuotationRow {
  return {
    id,
    state: 'current',
    observation: id,
    contexts: [],
    statements: [
      {
        statementId: `text:${id}`,
        property: 'schema:text',
        status: 'current',
        text: `Exact ${id}`,
        language: 'en',
        qualifiers: [],
        references: [
          {
            statementId: `text:${id}`,
            hash: `hash:${id}`,
            status: 'current',
            parts: [
              {
                property: 'schema:url',
                label: 'Source URL',
                status: 'current',
                value: 'https://source.example.test/exact',
                href: 'https://source.example.test/exact',
              },
            ],
          },
        ],
        sourceStatus: 'current',
        spoiler: false,
      },
    ],
  };
}
function page(ids = [first], selected = ids[0], next: string | null = null): QuotationRead {
  return {
    ok: true,
    public: recorded as unknown as SubjectRead,
    admitted: true,
    rows: ids.map(row),
    selected: selected ? row(selected) : null,
    next,
    observation: 'work:1',
    unsupportedCount: 0,
    session: 'private-session',
    actions: [{ action: 'statement:propose', operationId: 'subject.propose', state: 'allowed' }],
    viewerActions: {
      subject: { state: 'available', actions: [{ action: 'statement:propose', operations: ['subject.propose'] }] },
      context: { state: 'available', actions: [{ action: 'statement:propose', operations: ['subject.propose'] }] },
    },
  };
}

test('mounted reader owns later-page selection, explicit recovery, return and retired work', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.invalid/en/subjects/${id}/work/quotations` });
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
  const { QuotationView } = await import('../src/features/pages/quotation-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const host = document.createElement('main');
  document.body.append(host);
  const unrelated = document.createElement('input');
  document.body.append(unrelated);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const calls: Parameters<QuotationTransport['read']>[0][] = [];
  let answer: QuotationTransport['read'] = async (input) =>
    input.cursor ? page([later, first], input.quote ?? later) : page([first], input.quote ?? first, 'native-page-two');
  const transport: QuotationTransport = {
    read: async (input) => {
      calls.push(input);
      return answer(input);
    },
  };
  let reader = 'one';
  async function mount(quote?: string, initial?: QuotationRead) {
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(
            CandidateReaderBoundary,
            { observed: { state: 'signed-out', csrfToken: reader }, address: id },
            h(QuotationView, { id, locale: 'en', quote, returnTo: '/en/origin', transport, initial }),
          ),
        ),
      ),
    );
  }
  async function click(label: string) {
    const button = [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
    expect(button).toBeTruthy();
    await act(async () => {
      button.focus();
      button.click();
    });
  }
  try {
    await mount(undefined, page([first], first, 'native-page-two'));
    expect(calls).toHaveLength(0); // Native initial data does not refetch on mount.
    await click(m.quotation_more());
    await click(m.quotation_open({ number: 2 }));
    expect(calls.at(-1)).toEqual({
      cursor: 'native-page-two',
      quote: first,
      session: 'private-session',
      context: candidateContext,
    });
    expect(host.querySelector('[data-quotation-id]')?.getAttribute('data-quotation-id')).toBe(first);
    expect(host.querySelector('[data-source-reference-hash]')?.getAttribute('data-statement-id')).toBe(`text:${first}`);
    expect(document.activeElement?.tagName).toBe('H2');
    const count = calls.length;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    expect(calls).toHaveLength(count);
    answer = async () => ({ ok: false, reason: 'unavailable' });
    await click(m.quotation_refresh());
    expect(host.querySelector('[data-quotation-id]')).toBeNull();
    expect(host.querySelector('a[href="/en/origin"]')).toBeTruthy();
    expect(host.textContent).toContain(m.quotation_retry());
    answer = async () => page([later, first], first);
    await click(m.quotation_retry());
    expect(calls.at(-1)?.cursor).toBe('native-page-two');
    expect(calls.at(-1)?.quote).toBe(first);
    const correction = [...host.querySelectorAll('a')].find((node) => node.textContent === m.quotation_correct())!;
    const destination = new URL(correction.href);
    expect(destination.pathname).toContain(first);
    const returnUrl = new URL(destination.searchParams.get('via')!, window.location.origin);
    expect(returnUrl.searchParams.get('quote')).toBe(first);
    expect(returnUrl.searchParams.get('returnTo')).toBe('/en/origin');
    expect(returnUrl.href).not.toContain('private-session');
    expect(returnUrl.href).not.toContain('native-page-two');
    await act(async () => {
      correction.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await act(async () => root.render(null));
    window.history.replaceState(null, '', returnUrl.href);
    await mount(first);
    expect(calls.at(-1)).toEqual({
      cursor: 'native-page-two',
      quote: first,
      session: 'private-session',
      context: candidateContext,
    });
    // A consumed/lost receipt does not guess which page held a quotation.
    await act(async () => root.render(null));
    const before = calls.length;
    await mount(first);
    expect(calls).toHaveLength(before);
    expect(host.textContent).toContain(m.quotation_reading_changed());
    await click(m.quotation_restart());
    expect(calls.at(-1)).toEqual({ context: candidateContext });
    // The standalone fixture mirrors the router's successful Restart URL transition.
    window.history.replaceState(null, '', `/en/subjects/${id}/work/quotations`);
    // Delayed selection cannot steal focus after the reader moves to an unrelated input.
    let resolve!: (read: QuotationRead) => void;
    answer = () =>
      new Promise((done) => {
        resolve = done;
      });
    await click(m.quotation_open({ number: 1 }));
    unrelated.focus();
    await act(async () => resolve(page([later, first], later)));
    expect(document.activeElement).toBe(unrelated);
    // Retirement rejects the same reader strings and old A/B/A results.
    let old!: (read: QuotationRead) => void;
    answer = () =>
      new Promise((done) => {
        old = done;
      });
    await click(m.quotation_refresh());
    reader = 'two';
    await mount(undefined, page([first]));
    reader = 'one';
    await mount(undefined, page([later]));
    await act(async () => old(page([first])));
    expect(host.querySelector('[data-quotation-id]')?.getAttribute('data-quotation-id')).toBe(later);
    await act(async () => root.render(null));
    window.history.replaceState(null, '', `/en/subjects/${id}/work/quotations`);
    answer = async () => page([first]);
    await mount(undefined, { ok: false, reason: 'unavailable' });
    const initialFailureCalls = calls.length;
    await click(m.quotation_retry());
    expect(calls.length).toBe(initialFailureCalls + 1);
    expect(host.textContent).toContain(`Exact ${first}`);
    const pending: ((read: QuotationRead) => void)[] = [];
    answer = () => new Promise((done) => pending.push(done));
    await mount(first);
    await mount(later);
    await mount(first);
    expect(pending).toHaveLength(3);
    await act(async () => pending[2]!(page([first])));
    await act(async () => {
      pending[1]!(page([later]));
      pending[0]!(page([later]));
    });
    expect(host.querySelector('[data-quotation-id]')?.getAttribute('data-quotation-id')).toBe(first);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
