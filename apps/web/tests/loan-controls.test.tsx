import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { LoanWriteResult } from '../src/library/loans-read';
import type { LoansOrigin } from '../src/library/loan-intent';
import { illustrativeLoan, illustrativeLoanPage, loanStoryBoundary } from '../src/kernel/fake/loans';

// Source-only acceptance. Execution, browser focus/geometry and native receipt proof are deferred.
const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/library/loans' });
const globals = {
  window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement, Element: window.Element, Node: window.Node,
  Document: window.Document, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
let respond: (input: { data: Record<string, unknown>; headers: HeadersInit }) => Promise<LoanWriteResult>;
const calls: { data: Record<string, unknown>; headers: HeadersInit }[] = [];
const send = (input: { data: Record<string, unknown>; headers: HeadersInit }) => { calls.push(input); return respond(input); };
mock.module('../src/library/loans-actions', () => ({ createLoan: send, updateLoanDue: send, completeLoan: send }));
// Admission and navigation have their own lifetime acceptance; exercise the actual loan consumers here.
mock.module('../src/kernel/exposure', () => ({ Exposure: ({ children }: { children: ReactNode }) => children }));
const { createRoot } = await import('react-dom/client');
const { createRootRoute, createRouter, createMemoryHistory, RouterContextProvider } = await import('@tanstack/react-router');
const { LoansPage } = await import('../src/library/loans-page');
const { LoanControls } = await import('../src/library/loan-controls');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const origin: LoansOrigin = { isCurrent: () => true, headers: () => ({ 'x-csrf-token': 'original' }) };
const address = { filter: 'open' as const, cursor: null, locale: 'en' };
const source = () => ({ ...illustrativeLoanPage('open'), signedIn: true, requestedCursor: null, next: null });

async function mount(children: ReactNode) {
  calls.length = 0;
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/library/loans'] }) });
  const render = async (next: ReactNode) => { await act(async () => root.render(<RouterContextProvider router={router}>{next}</RouterContextProvider>)); };
  await render(children);
  return { host, render, close: async () => {
    await act(async () => root.unmount()); host.remove(); router.history.destroy();
  } };
}
function button(host: Element, name: string, index = 0) {
  const found = [...host.querySelectorAll('button')].filter((item) => item.textContent === name)[index];
  if (!found) throw new Error(`Missing button: ${name}`);
  return found as HTMLButtonElement;
}
const click = async (node: HTMLElement) => { await act(async () => node.click()); };
const submit = async (host: Element) => {
  const form = host.querySelector('form');
  if (!form) throw new Error('Missing selected operation form');
  await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
};
afterAll(async () => {
  mock.restore(); await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});

test('supplied rows keep their order and mount fields only for the deliberately selected operation', async () => {
  const page = source();
  const view = await mount(<LoansPage page={page} address={address} originating={origin} onRefresh={() => {}} />);
  try {
    expect(view.host.querySelectorAll('form')).toHaveLength(0);
    expect([...view.host.querySelectorAll('li')].map((item) => item.textContent!.includes(page.items[0]!.loan.copyId))).toEqual([true, false, false]);
    const review = button(view.host, m.library_loans_inspect());
    await click(review);
    expect(view.host.querySelectorAll('form')).toHaveLength(0);
    const extend = button(view.host, m.library_loans_extend());
    await click(extend);
    expect(view.host.querySelectorAll('form')).toHaveLength(1);
    expect(document.activeElement?.textContent).toBe(m.library_loans_extend());
    await click(button(view.host, m.library_loans_back()));
    expect(document.activeElement).toBe(extend);
    await click(button(view.host, m.library_loans_close()));
    expect(document.activeElement).toBe(review);
    expect(calls).toHaveLength(0);
  } finally { await view.close(); }
});

test('uncertain return survives close/reopen and replays exact input beside the selected loan', async () => {
  const page = source();
  let attempts = 0;
  respond = async () => ++attempts === 1 ? { ok: false, reason: 'unavailable' }
    : { ok: true, loan: illustrativeLoan({ returnedOn: loanStoryBoundary.today, state: 'returned', revision: 4 }), boundary: loanStoryBoundary };
  const view = await mount(<LoansPage page={page} address={address} originating={origin} onRefresh={() => {}} />);
  try {
    const review = button(view.host, m.library_loans_inspect());
    await click(review); await click(button(view.host, m.library_loans_return())); await submit(view.host);
    const row = view.host.querySelector('li')!;
    expect(row.textContent).toContain(m.library_loans_unknown());
    expect(button(view.host, m.library_loans_inspect(), 1).disabled).toBe(true);
    await click(button(view.host, m.library_loans_close()));
    expect(document.activeElement).toBe(review);
    expect(row.querySelector('section')!.hidden).toBe(true);
    await click(review); await click(button(row, m.library_loans_retry_exact()));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data).toEqual(calls[0]!.data);
    expect(calls[0]!.data).toMatchObject({ loanId: page.items[0]!.loan.id, revision: 3, returnedOn: loanStoryBoundary.today });
    expect(new Headers(calls[1]!.headers).get('x-csrf-token')).toBe('original');
    expect(row.textContent).toContain(m.library_loans_receipt());
    expect(row.textContent).toContain(m.library_loans_read_distinct());
  } finally { await view.close(); }
});

test('first conflict offers an explicit fresh read; a changed source clears the selected draft', async () => {
  let refreshed = 0;
  respond = async () => ({ ok: false, reason: 'conflict' });
  const page = source();
  const view = await mount(<LoansPage page={page} address={address} originating={origin} onRefresh={() => { refreshed++; }} />);
  try {
    await click(button(view.host, m.library_loans_inspect())); await click(button(view.host, m.library_loans_return())); await submit(view.host);
    expect(view.host.querySelector('li')!.textContent).toContain(m.library_loans_conflict());
    expect(view.host.textContent).not.toContain(m.library_loans_retry_exact());
    await click(button(view.host, m.library_loans_refresh())); expect(refreshed).toBe(1);
    await view.render(<LoansPage page={source()} address={address} originating={origin} onRefresh={() => {}} />);
    expect(view.host.querySelectorAll('form')).toHaveLength(0);
    expect(view.host.textContent).not.toContain(m.library_loans_conflict());
  } finally { await view.close(); }
});

test('returned and concealed context use supplied facts without new commands or guessed identity', async () => {
  const page = { ...source(), ...illustrativeLoanPage('history') };
  const history = await mount(<LoansPage page={page} address={{ ...address, filter: 'history' }} originating={origin} onRefresh={() => {}} />);
  try {
    expect(history.host.textContent).toContain(m.library_loans_copy_deleted());
    expect(history.host.textContent).toContain(m.library_loans_copy_missing());
    await click(button(history.host, m.library_loans_inspect()));
    expect(history.host.querySelectorAll('form')).toHaveLength(0);
    expect([...history.host.querySelectorAll('button')].some((item) => item.textContent === m.library_loans_return())).toBe(false);
  } finally { await history.close(); }
  const concealed = await mount(<LoansPage page={{ ...source(), ...illustrativeLoanPage('concealed') }} address={address} originating={origin} onRefresh={() => {}} />);
  try {
    expect(concealed.host.textContent).toContain(m.library_loans_counterparty_concealed());
    expect(concealed.host.textContent).toContain(m.library_loans_context_withheld());
    expect(concealed.host.querySelector('a[href*="/people/"]')).toBeNull();
  } finally { await concealed.close(); }
});

test('create snapshots the supplied exact copy and response day without trimming the private name', async () => {
  respond = async () => ({ ok: false, reason: 'unavailable' });
  const view = await mount(<LoanControls copy={{ id: 'exact-copy', revision: 19 }} today="2026-11-14" originating={origin} onRefresh={() => {}} />);
  try {
    await click(button(view.host, m.library_loans_create()));
    const input = view.host.querySelector('input:not([type="hidden"])') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '  Private name 雪  ');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await submit(view.host); await click(button(view.host, m.library_loans_retry_exact()));
    expect(calls[0]!.data).toMatchObject({ copyId: 'exact-copy', copyRevision: 19, startedOn: '2026-11-14', counterparty: { kind: 'name', name: '  Private name 雪  ' } });
    expect(calls[1]!.data).toEqual(calls[0]!.data);
  } finally { await view.close(); }
});
