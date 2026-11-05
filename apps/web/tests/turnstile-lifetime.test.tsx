import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type RefObject } from 'react';
import type { VerificationConfig } from '../src/report/turnstile';

// UNRUN: the real lazy Verification component with only the configured script and vendor API supplied by the test.
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
  HTMLDivElement: window.HTMLDivElement,
  HTMLScriptElement: window.HTMLScriptElement,
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
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { Verification } = await import('../src/report/turnstile');

type Options = {
  sitekey: string;
  language: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
};
type Widget = { id: string; container: HTMLElement; options: Options; removed: boolean };
function fakeApi(prefix: string) {
  let nextId = 0;
  const widgets = new Map<string, Widget>();
  const resets: string[] = [];
  const removals: string[] = [];
  const api = {
    render(container: HTMLElement, options: Options) {
      const id = `${prefix}-${++nextId}`;
      const widget = { id, container, options, removed: false };
      widgets.set(id, widget);
      container.dataset.widgetId = id;
      return id;
    },
    reset(id: string) {
      resets.push(id);
      widgets.get(id)?.options['expired-callback']();
    },
    remove(id: string) {
      removals.push(id);
      const widget = widgets.get(id);
      if (!widget) return;
      widget.removed = true;
      widget.container.replaceChildren();
      widgets.delete(id);
    },
  };
  return { api, widgets, resets, removals };
}

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let roots: ReturnType<typeof createRoot>[] = [];
let mountedNodes: HTMLElement[] = [];
let scriptsLoaded: string[] = [];
const unmounted = new WeakSet<object>();
const originalAppendChild = window.document.head.appendChild;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function props(
  config: VerificationConfig,
  onToken: (token: string) => void,
  onStart: () => void,
  reset: RefObject<(() => void) | null>,
  locale = 'en',
) {
  return { config, locale, onToken, reset, onStart };
}

async function mount(
  config: VerificationConfig,
  callbacks: { onToken?: (token: string) => void; onStart?: () => void } = {},
  strict = false,
) {
  const node = window.document.createElement('section') as unknown as HTMLElement;
  host.append(node);
  const reset = { current: null } as RefObject<(() => void) | null>;
  const root = createRoot(node);
  roots.push(root);
  mountedNodes.push(node);
  const paint = async (
    nextConfig = config,
    nextCallbacks: { onToken?: (token: string) => void; onStart?: () => void } = callbacks,
    locale = 'en',
  ) => {
    await act(async () => {
      const child = (
        <Verification
          {...props(
            nextConfig,
            nextCallbacks.onToken ?? (() => {}),
            nextCallbacks.onStart ?? (() => {}),
            reset,
            locale,
          )}
        />
      );
      root.render(strict ? <StrictMode>{child}</StrictMode> : child);
    });
  };
  await paint();
  return { node, root, reset, paint };
}

async function deliver(script: HTMLScriptElement, api: ReturnType<typeof fakeApi>) {
  Object.defineProperty(window, 'turnstile', { configurable: true, writable: true, value: api.api });
  scriptsLoaded.push(script.src);
  await act(async () => {
    script.dispatchEvent(new window.Event('load'));
    await tick();
  });
}

function scriptList() {
  return [...window.document.querySelectorAll<HTMLScriptElement>('script[src]')];
}

beforeEach(() => {
  scriptsLoaded = [];
  const append = window.document.head.appendChild.bind(window.document.head);
  window.document.head.appendChild = ((node: Node) => {
    const result = append(node);
    return result;
  }) as typeof window.document.head.appendChild;
});

afterEach(async () => {
  for (const root of roots.splice(0)) await unmountRoot(root);
  for (const node of mountedNodes.splice(0)) node.remove();
  for (const script of scriptList()) script.remove();
  window.document.head.appendChild = originalAppendChild;
  delete (window as Window & { turnstile?: unknown }).turnstile;
});

async function unmountRoot(root: ReturnType<typeof createRoot>) {
  if (unmounted.has(root)) return;
  await act(async () => root.unmount());
  unmounted.add(root);
}

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('StrictMode keeps one configured script and one live widget; fresh callbacks and reset ownership stay current', async () => {
  const tokens: string[] = [];
  let starts = 0;
  const config = { sitekey: 'same-key', scriptUrl: 'https://turnstile.test/shared.js' };
  const mounted = await mount(
    config,
    { onToken: (token) => tokens.push(`first:${token}`), onStart: () => starts++ },
    true,
  );
  expect(scriptList()).toHaveLength(1);
  const api = fakeApi('shared');
  await deliver(scriptList()[0]!, api);
  expect(api.widgets.size).toBe(1);
  const widget = [...api.widgets.values()][0]!;
  expect(widget.options.sitekey).toBe('same-key');
  expect(widget.options.language).toBe('en');

  await mounted.paint({ ...config }, { onToken: (token) => tokens.push(`fresh:${token}`), onStart: () => starts++ });
  expect(scriptList()).toHaveLength(1);
  expect(api.widgets.size).toBe(1);
  widget.options.callback('verified-one');
  expect(tokens).toContain('fresh:verified-one');
  const retainedReset = mounted.reset.current!;
  retainedReset();
  expect(api.resets).toEqual([widget.id]);
  expect(tokens.at(-1)).toBe('fresh:');

  await mounted.paint({ ...config }, { onToken: (token) => tokens.push(`locale:${token}`) }, 'ja');
  expect(api.widgets.size).toBe(1);
  const japaneseWidget = [...api.widgets.values()][0]!;
  expect(japaneseWidget.options.language).toBe('ja');
  expect(japaneseWidget.id).not.toBe(widget.id);
  widget.options.callback('late-old-locale');
  expect(tokens).not.toContain('locale:late-old-locale');

  await unmountRoot(mounted.root);
  retainedReset();
  japaneseWidget.options.callback('late-token');
  widget.options['expired-callback']();
  expect(api.resets).toHaveLength(1);
  expect(tokens).not.toContain('fresh:late-token');
  expect(api.widgets.size).toBe(0);
  expect(api.removals).toEqual([widget.id, japaneseWidget.id]);
  expect(starts).toBeGreaterThanOrEqual(1);
});

test('config replacement retires the old script, token and reset handle before a late callback can affect its successor', async () => {
  const tokens: string[] = [];
  const first = { sitekey: 'key-a', scriptUrl: 'https://turnstile.test/a.js' };
  const second = { sitekey: 'key-b', scriptUrl: 'https://turnstile.test/b.js' };
  const mounted = await mount(first, { onToken: (token) => tokens.push(token) });
  const scriptA = scriptList()[0]!;
  const apiA = fakeApi('a');
  await deliver(scriptA, apiA);
  const widgetA = [...apiA.widgets.values()][0]!;
  widgetA.options.callback('token-a');
  const retainedResetA = mounted.reset.current!;
  expect(tokens.at(-1)).toBe('token-a');

  await mounted.paint(second);
  expect(apiA.widgets.size).toBe(0);
  expect(apiA.removals).toEqual([widgetA.id]);
  const scriptB = scriptList().find((script) => script.src.endsWith('/b.js'))!;
  retainedResetA();
  widgetA.options.callback('late-a');
  widgetA.options['error-callback']();
  expect(apiA.resets).toEqual([]);
  expect(tokens).not.toContain('late-a');

  const apiB = fakeApi('b');
  await deliver(scriptB, apiB);
  const widgetB = [...apiB.widgets.values()][0]!;
  expect(widgetB.options.sitekey).toBe('key-b');
  expect(widgetB.options.language).toBe('en');
  expect(apiB.widgets.size).toBe(1);
  mounted.reset.current!();
  expect(apiB.resets).toEqual([widgetB.id]);
});

test('a delayed script from a retired configuration cannot create a widget after sitekey replacement', async () => {
  const configA = { sitekey: 'late-key-a', scriptUrl: 'https://turnstile.test/late-a.js' };
  const configB = { sitekey: 'late-key-b', scriptUrl: 'https://turnstile.test/late-b.js' };
  const mounted = await mount(configA);
  const scriptA = scriptList()[0]!;
  await mounted.paint(configB);
  const scriptB = scriptList().find((script) => script.src.endsWith('/late-b.js'))!;

  const oldApi = fakeApi('late-a');
  Object.defineProperty(window, 'turnstile', { configurable: true, writable: true, value: oldApi.api });
  await act(async () => {
    scriptA.dispatchEvent(new window.Event('load'));
    await tick();
  });
  expect(oldApi.widgets.size).toBe(0);

  const currentApi = fakeApi('late-b');
  await deliver(scriptB, currentApi);
  expect(currentApi.widgets.size).toBe(1);
  expect([...currentApi.widgets.values()][0]!.options.sitekey).toBe('late-key-b');
});

test('independent dialogs share one URL load without one cleanup clearing the other reset owner', async () => {
  const config = { sitekey: 'shared-key', scriptUrl: 'https://turnstile.test/multi.js' };
  const first = await mount(config);
  const second = await mount({ ...config });
  expect(scriptList()).toHaveLength(1);
  const api = fakeApi('multi');
  await deliver(scriptList()[0]!, api);
  expect(api.widgets.size).toBe(2);
  const [widgetA, widgetB] = [...api.widgets.values()];
  expect(widgetA).toBeDefined();
  expect(widgetB).toBeDefined();
  const retainedResetA = first.reset.current!;

  await unmountRoot(first.root);
  retainedResetA();
  expect(api.resets).toEqual([]);
  expect(api.widgets.size).toBe(1);
  second.reset.current!();
  expect(api.resets).toEqual([widgetB!.id]);
  expect(api.removals).toEqual([widgetA!.id]);
});

test('a failed script clears only its current token and a later explicit mount can use the same configured URL', async () => {
  const tokens: string[] = [];
  const config = { sitekey: 'failure-key', scriptUrl: 'https://turnstile.test/fail.js' };
  const first = await mount(config, { onToken: (token) => tokens.push(`first:${token}`) });
  await act(async () => {
    scriptList()[0]!.dispatchEvent(new window.Event('error'));
    await tick();
  });
  expect(tokens.at(-1)).toBe('first:');

  await unmountRoot(first.root);
  await tick();
  expect(scriptList()).toHaveLength(0);
  const second = await mount(config, { onToken: (token) => tokens.push(`second:${token}`) });
  expect(scriptList()).toHaveLength(1);
  const api = fakeApi('retry-after-close');
  await deliver(scriptList()[0]!, api);
  expect(api.widgets.size).toBe(1);
  expect(tokens.some((token) => token === 'second:')).toBe(true);
  expect(scriptsLoaded).toHaveLength(1);
  await unmountRoot(second.root);
});

test('a successor sharing the reset ref owns token publication and cleanup even while the prior widget is mounted', async () => {
  const tokens: string[] = [];
  const reset = { current: null } as RefObject<(() => void) | null>;
  const config = { sitekey: 'shared-handle-key', scriptUrl: 'https://turnstile.test/shared-handle.js' };
  const firstNode = window.document.createElement('section') as unknown as HTMLElement;
  const secondNode = window.document.createElement('section') as unknown as HTMLElement;
  host.append(firstNode, secondNode);
  mountedNodes.push(firstNode, secondNode);
  const first = createRoot(firstNode);
  const second = createRoot(secondNode);
  roots.push(first, second);
  await act(async () => {
    first.render(
      <Verification
        {...props(
          config,
          (token) => tokens.push(`first:${token}`),
          () => {},
          reset,
        )}
      />,
    );
  });
  const api = fakeApi('shared-handle');
  await deliver(scriptList()[0]!, api);
  const firstWidget = [...api.widgets.values()][0]!;
  const resetFirst = reset.current!;
  await act(async () => {
    second.render(
      <Verification
        {...props(
          config,
          (token) => tokens.push(`second:${token}`),
          () => {},
          reset,
        )}
      />,
    );
    await tick();
  });
  const secondWidget = [...api.widgets.values()].at(-1)!;
  expect(secondWidget.id).not.toBe(firstWidget.id);
  secondWidget.options.callback('current-token');
  expect(tokens.at(-1)).toBe('second:current-token');
  const tokenCount = tokens.length;
  const resetSecond = reset.current;
  resetFirst();
  firstWidget.options.callback('retained-first-token');
  firstWidget.options['expired-callback']();
  firstWidget.options['error-callback']();
  await unmountRoot(first);
  expect(tokens).toHaveLength(tokenCount);
  expect(reset.current).toBe(resetSecond);
  expect(api.resets).toEqual([]);
  expect(api.removals).toEqual([firstWidget.id]);
  reset.current!();
  expect(api.resets).toEqual([secondWidget.id]);
  expect(tokens.at(-1)).toBe('second:');
});

test('equal callback/config allocation never clears a healthy token or starts another challenge', async () => {
  const tokens: string[] = [];
  let starts = 0;
  const config = { sitekey: 'stable-live-key', scriptUrl: 'https://turnstile.test/stable-live.js' };
  const mounted = await mount(config, { onToken: (token) => tokens.push(token), onStart: () => starts++ }, true);
  const api = fakeApi('stable-live');
  await deliver(scriptList()[0]!, api);
  const widget = [...api.widgets.values()][0]!;
  widget.options.callback('healthy-token');
  const tokenCount = tokens.length;
  const startCount = starts;
  const resetBefore = mounted.reset.current;
  for (let index = 0; index < 3; index++) {
    await mounted.paint({ ...config }, { onToken: (token) => tokens.push(token), onStart: () => starts++ });
  }
  expect(tokens).toHaveLength(tokenCount);
  expect(tokens.at(-1)).toBe('healthy-token');
  expect(starts).toBe(startCount);
  expect(mounted.reset.current).toBe(resetBefore);
  expect(api.removals).toEqual([]);
  expect(api.widgets.size).toBe(1);
  expect(scriptsLoaded).toEqual([config.scriptUrl]);
});

test('sitekey replacement on the same URL uses the captured API and retires every old vendor callback and reset', async () => {
  const tokens: string[] = [];
  const config = { sitekey: 'key-before', scriptUrl: 'https://turnstile.test/sitekey-only.js' };
  const mounted = await mount(config, { onToken: (token) => tokens.push(token) });
  const api = fakeApi('captured');
  await deliver(scriptList()[0]!, api);
  const oldWidget = [...api.widgets.values()][0]!;
  const oldReset = mounted.reset.current!;
  const unrelatedApi = fakeApi('unrelated-global');
  Object.defineProperty(window, 'turnstile', { configurable: true, writable: true, value: unrelatedApi.api });
  await mounted.paint({ ...config, sitekey: 'key-after' });
  const currentWidget = [...api.widgets.values()][0]!;
  expect(currentWidget.options.sitekey).toBe('key-after');
  expect(currentWidget.id).not.toBe(oldWidget.id);
  currentWidget.options.callback('new-sitekey-token');
  const tokenCount = tokens.length;
  oldReset();
  oldWidget.options.callback('old-sitekey-token');
  oldWidget.options['expired-callback']();
  oldWidget.options['error-callback']();
  expect(tokens).toHaveLength(tokenCount);
  expect(api.resets).toEqual([]);
  expect(api.removals).toEqual([oldWidget.id]);
  expect(unrelatedApi.widgets.size).toBe(0);
  expect(scriptsLoaded).toEqual([config.scriptUrl]);
});

test('unmount before script arrival retires the original load handler and reset without creating a widget', async () => {
  const tokens: string[] = [];
  const mounted = await mount(
    { sitekey: 'unmounted-loading', scriptUrl: 'https://turnstile.test/unmounted-loading.js' },
    { onToken: (token) => tokens.push(token) },
    true,
  );
  const script = scriptList()[0]!;
  const retainedLoad = script.onload!;
  const retainedError = script.onerror!;
  const retainedReset = mounted.reset.current!;
  await unmountRoot(mounted.root);
  const count = tokens.length;
  const api = fakeApi('too-late');
  Object.defineProperty(window, 'turnstile', { configurable: true, writable: true, value: api.api });
  await act(async () => {
    retainedReset();
    retainedLoad.call(script, new window.Event('load') as unknown as Event);
    retainedError.call(script, new window.Event('error') as unknown as Event);
    await tick();
  });
  expect(api.widgets.size).toBe(0);
  expect(api.resets).toEqual([]);
  expect(api.removals).toEqual([]);
  expect(mounted.reset.current).toBeNull();
  expect(tokens).toHaveLength(count);
  expect(scriptList()).toHaveLength(0);
});
