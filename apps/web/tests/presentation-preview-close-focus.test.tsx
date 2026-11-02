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
  HTMLButtonElement: window.HTMLButtonElement,
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
const published = {
  ok: true,
  target: { route: '/published' },
  locale: 'en',
  head: 1,
  page: {
    subject: null,
    profile: `sha256:${'c'.repeat(64)}`,
    template: { scope: 'route', key: '/published' },
    document: { root: { props: {} }, content: [] },
    reads: {},
  },
} as PresentationPreview;
type Call = { input: PresentationPreviewInput; resolve: (value: PresentationPreview) => void };
const calls: Call[] = [];
const reader = () => (input: PresentationPreviewInput) =>
  new Promise<PresentationPreview>((resolve) => calls.push({ input, resolve }));
const host = window.document.createElement('main');
window.document.body.append(host);
const root = createRoot(host as unknown as HTMLElement);
const inspect = () => host.querySelector('button[type="submit"]') as HTMLButtonElement;
const close = () => host.querySelector('button[type="button"]') as HTMLButtonElement;
const address = () => host.querySelector('input') as HTMLInputElement;
const render = (locale: string, read: ReturnType<typeof reader>) =>
  act(async () => root.render(<PresentationPreviewPanel locale={locale} read={read} />));
const setAddress = (value: string) =>
  act(async () => {
    const input = address();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const submit = () =>
  act(async () =>
    host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
  );
const activateClose = () => {
  const button = close();
  button.focus();
  button.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
};

test('explicit keyboard Close returns to Inspect without stealing focus on edits, stale owners or a moved reader', async () => {
  const readA = reader();
  const readB = reader();
  const outside = window.document.createElement('button');
  window.document.body.append(outside);
  let mounted = true;
  try {
    await render('en', readA);
    await setAddress('first-subject');
    await submit();
    expect(host.querySelector('form')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => activateClose());
    expect(window.document.activeElement).toBe(inspect());
    expect(inspect().disabled).toBe(false);
    await act(async () => {
      calls[0]!.resolve(published);
      await Promise.resolve();
    });
    expect(host.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
    expect(window.document.activeElement).toBe(inspect());

    await submit();
    await act(async () => {
      calls[1]!.resolve(published);
      await Promise.resolve();
    });
    expect(host.querySelector('[data-slot="published-presentation-preview"]')).not.toBeNull();
    await act(async () => activateClose());
    expect(window.document.activeElement).toBe(inspect());
    expect(host.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();

    await submit();
    await act(async () => {
      calls[2]!.resolve(published);
      await Promise.resolve();
    });
    expect(host.querySelector('[data-slot="published-presentation-preview"]')).not.toBeNull();
    await act(async () => address().focus());
    await setAddress('typed-subject');
    expect(window.document.activeElement).toBe(address());
    expect(host.querySelector('[data-slot="published-presentation-preview"]')).toBeNull();
    await submit();
    expect(window.document.activeElement).toBe(address());
    await act(async () => {
      calls[3]!.resolve(published);
      await Promise.resolve();
    });
    expect(window.document.activeElement).toBe(address());
    expect(host.querySelector('[data-slot="published-presentation-preview"]')).not.toBeNull();

    await submit();
    await act(async () => {
      activateClose();
      root.render(<PresentationPreviewPanel locale="fr" read={readA} />);
    });
    expect(window.document.activeElement).not.toBe(inspect());
    expect(host.querySelector('form')!.getAttribute('aria-busy')).toBe('false');

    await setAddress('kept-subject');
    await submit();
    await act(async () => {
      activateClose();
      root.render(<PresentationPreviewPanel locale="fr" read={readB} />);
    });
    expect(window.document.activeElement).not.toBe(inspect());

    await submit();
    await act(async () => {
      activateClose();
      outside.focus();
    });
    expect(window.document.activeElement).toBe(outside);

    await submit();
    await act(async () => {
      activateClose();
      root.unmount();
    });
    mounted = false;
    expect(host.querySelector('button[type="submit"]')).toBeNull();
  } finally {
    outside.remove();
    if (mounted) await act(async () => root.unmount());
    mock.restore();
    await window.happyDOM.close();
  }
});
