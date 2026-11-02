import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/one/reading' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const writes: { url: string; resolve: () => void; reject: (error: Error) => void }[] = [];
Object.defineProperty(window.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText(url: string) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      writes.push({ url, resolve, reject });
      return promise;
    },
  },
});

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/report/actions', () => ({ sendReport: async () => { throw new Error('unexpected report'); } }));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { PostActions } = await import('../src/report/content-actions');
const { m } = await import('../src/paraglide/messages.js');
type Props = ComponentProps<typeof PostActions>;
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let props: Props;

function item(label: string) {
  const node = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
  );
  expect(node).toBeDefined();
  return node!;
}

async function click(label: string) {
  await act(async () => {
    item(label).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function copy() {
  await click(m.report_more());
  await click(m.report_copy());
}

async function paint(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <PostActions {...props} />
      </QueryClientProvider>,
    );
  });
}

beforeEach(async () => {
  writes.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  props = {
    target: { kind: 'post', id: 'post-one' },
    revisionId: 'revision-one',
    verification: { sitekey: 'copy-test-key', scriptUrl: 'https://turnstile.test/copy.js' },
  };
  root = createRoot(host);
  await paint();
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.replaceChildren();
});

afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the real report menu recovers denied copying, closes to its trigger, and confirms only success', async () => {
  const url = 'https://site.test/en/threads/one/reading#post-post-one';
  await copy();
  expect(writes[0]?.url).toBe(url);
  await act(async () => writes[0]!.reject(new Error('NotAllowedError')));
  await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  const field = host.querySelector<HTMLInputElement>('input')!;
  expect(field.value).toBe(url);
  expect(field.readOnly).toBe(true);
  expect(document.querySelector(`label[for="${field.id}"]`)?.textContent).toBe(m.report_copy_recovery_link_label());
  expect(document.activeElement).toBe(field);
  expect(field.selectionStart).toBe(0);
  expect(field.selectionEnd).toBe(url.length);
  await click(m.report_copy_recovery_close());
  expect(host.querySelector('input')).toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe(m.report_more());

  await copy();
  await act(async () => writes[1]!.resolve());
  expect(host.querySelector('[role="status"]')?.textContent).toBe(m.report_copy_success());
  expect(host.querySelector('input')).toBeNull();
});

test('session ABA and target replacement retire old and late denied destinations', async () => {
  await copy();
  await act(async () => writes[0]!.reject(new Error('Denied')));
  expect(host.querySelector('input')?.value).toBe('https://site.test/en/threads/one/reading#post-post-one');
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader-two', csrfToken: 'csrf-two' });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  });
  expect(host.querySelector('input')).toBeNull();

  await copy();
  await paint({ target: { kind: 'post', id: 'post-two' } });
  await act(async () => writes[1]!.reject(new Error('Late denial')));
  expect(host.querySelector('input, [role="status"]')).toBeNull();
});
