import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { PresentationPreview, PresentationPreviewInput } from '../src/features/pages/presentation-preview';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/curate/presentation' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement,
  Element: window.Element,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('cloudflare:workers', () => ({ env: {} }));
const [{ createRoot }, { PresentationPreviewPanel }] = await Promise.all([
  import('react-dom/client'),
  import('../src/features/pages/presentation-preview-view'),
]);
const profile = `sha256:${'c'.repeat(64)}`;
const published = {
  ok: true,
  target: { route: '/published' },
  locale: 'en',
  head: 1,
  page: {
    subject: null,
    profile,
    template: { scope: 'route', key: '/published' },
    document: { root: { props: {} }, content: [] },
    reads: {},
  },
} as PresentationPreview;
type Call = {
  adapter: string;
  input: PresentationPreviewInput;
  signal: AbortSignal;
  resolve: (value: PresentationPreview) => void;
  reject: (error: Error) => void;
};
const calls: Call[] = [];
const reader = (adapter: string) => (input: PresentationPreviewInput, signal: AbortSignal) =>
  new Promise<PresentationPreview>((resolve, reject) => calls.push({ adapter, input, signal, resolve, reject }));
const readA = reader('A'),
  readB = reader('B');
const host = window.document.createElement('main');
window.document.body.append(host);
const root = createRoot(host as unknown as HTMLElement);
const form = () => host.querySelector('form')!;
const render = (locale: string, read: typeof readA) =>
  act(async () => root.render(<PresentationPreviewPanel locale={locale} read={read} />));
const submit = () =>
  act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
const setAddress = (value: string) =>
  act(async () => {
    const input = host.querySelector('input') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });

test('retires preview results and pending reads when locale or adapter changes', async () => {
  try {
    await render('en', readA);
    await setAddress('first-subject');
    await submit();
    await render('fr', readA);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(form().getAttribute('aria-busy')).toBe('false');
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('first-subject');
    await act(async () => {
      calls[0]!.resolve(published);
      await Promise.resolve();
    });
    expect(form().getAttribute('aria-busy')).toBe('false');
    expect(host.textContent).not.toContain(profile);
    await submit();
    expect(calls[1]!.input.locale).toBe('fr');
    await act(async () => {
      calls[1]!.resolve({ ok: false, reason: 'missing' });
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await setAddress('second-subject');
    await submit();
    await render('fr', readB);
    expect(calls[2]!.signal.aborted).toBe(true);
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('second-subject');
    await submit();
    expect(calls[3]!.adapter).toBe('B');
    expect(calls[3]!.input.locale).toBe('fr');
    await act(async () => {
      calls[2]!.reject(new Error('retired'));
      await Promise.resolve();
    });
    expect(form().getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      calls[3]!.resolve({ ok: false, reason: 'invalid' });
      await Promise.resolve();
    });
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await submit();
  } finally {
    await act(async () => root.unmount());
    expect(calls.at(-1)!.signal.aborted).toBe(true);
    mock.restore();
    await window.happyDOM.close();
  }
});
