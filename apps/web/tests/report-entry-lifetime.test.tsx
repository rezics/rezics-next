import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { ReportDraft, ReportResult } from '../src/report/submit.server';

// UNRUN: real PostActions, ContentActions, ReportDialog, QueryClient session cache and Verification are mounted together.
// Only the external report action and configured Turnstile script/API are supplied by the test.
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
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLScriptElement: window.HTMLScriptElement,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type SendCall = {
  promise: Promise<ReportResult>;
  resolve: (value: ReportResult) => void;
  reject: (error: Error) => void;
  data: ReportDraft;
  headers: Headers;
};
const calls: SendCall[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/report/actions', () => ({
  sendReport: ({ data, headers }: { data: ReportDraft; headers: HeadersInit }) => {
    const call = { ...deferred<ReportResult>(), data, headers: new Headers(headers) };
    calls.push(call);
    return call.promise;
  },
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { PostActions } = await import('../src/report/content-actions');
const { m } = await import('../src/paraglide/messages.js');

type Props = ComponentProps<typeof PostActions>;
type WidgetOptions = {
  sitekey: string;
  language: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': () => void;
};
type Widget = { id: string; container: HTMLElement; options: WidgetOptions; removed: boolean };
type MockTurnstile = ReturnType<typeof makeTurnstile>;

function makeTurnstile() {
  let index = 0;
  let tokenIndex = 0;
  const widgets = new Map<string, Widget>();
  const resets: string[] = [];
  const removals: string[] = [];
  const api = {
    render(container: HTMLElement, options: WidgetOptions) {
      const id = `report-widget-${++index}`;
      const widget = { id, container, options, removed: false };
      widgets.set(id, widget);
      container.dataset.widgetId = id;
      container.dataset.sitekey = options.sitekey;
      container.dataset.language = options.language;
      const verify = window.document.createElement('button');
      verify.type = 'button';
      verify.textContent = 'Verify test challenge';
      verify.addEventListener('click', () => options.callback(`challenge-token-${id}-${++tokenIndex}`));
      const expire = window.document.createElement('button');
      expire.type = 'button';
      expire.textContent = 'Expire test challenge';
      expire.addEventListener('click', () => options['expired-callback']());
      const fail = window.document.createElement('button');
      fail.type = 'button';
      fail.textContent = 'Fail test challenge';
      fail.addEventListener('click', () => options['error-callback']());
      container.append(verify, expire, fail);
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
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let replacementClient: InstanceType<typeof QueryClient> | undefined;
let clients: InstanceType<typeof QueryClient>[] = [];
let props: Props;
let scriptSequence = 0;
let scriptLoads = 0;
let currentTurnstile: MockTurnstile | undefined;
const oldRoots = new WeakSet<object>();
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const visitor = (subject = 'reader-one', csrfToken = 'csrf-one') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const anonymous = () => ({ state: 'signed-out' as const, subject: null, csrfToken: null });
const baseline = (): Props => ({
  target: { kind: 'post', id: 'post-one' },
  revisionId: 'revision-one',
  verification: { sitekey: 'report-test-key', scriptUrl: `https://turnstile.test/report-${++scriptSequence}.js` },
});

async function paint(patch: Partial<Props> = {}, strict = true) {
  props = { ...props, ...patch };
  await act(async () => {
    const view = (
      <QueryClientProvider client={client}>
        {strict ? (
          <StrictMode>
            <PostActions {...props} />
          </StrictMode>
        ) : (
          <PostActions {...props} />
        )}
      </QueryClientProvider>
    );
    root.render(view);
  });
}

async function paintProvider(nextClient: InstanceType<typeof QueryClient>) {
  client = nextClient;
  clients.push(nextClient);
  await paint();
}

async function unmount() {
  if (oldRoots.has(root)) return;
  await act(async () => root.unmount());
  oldRoots.add(root);
}

function buttons(rootNode: ParentNode = window.document.body) {
  return [...rootNode.querySelectorAll<HTMLButtonElement>('button')];
}

function button(label: string, rootNode: ParentNode = window.document.body, index = 0) {
  const matches = buttons(rootNode).filter(
    (candidate) => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
  );
  expect(matches[index]).toBeDefined();
  return matches[index]!;
}

function menuItem(label: string, index = 0) {
  const items = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter(
    (item) => item.textContent?.trim() === label,
  );
  expect(items[index]).toBeDefined();
  return items[index]!;
}

function dialog() {
  const result = window.document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  expect(result).toBeDefined();
  return result!;
}

function radio(label: string, rootNode: ParentNode = dialog()) {
  const result = [...rootNode.querySelectorAll<HTMLElement>('[role="radio"]')].find((item) => {
    const labelledBy = item.getAttribute('aria-labelledby');
    return labelledBy ? window.document.getElementById(labelledBy)?.textContent?.trim() === label : false;
  });
  expect(result).toBeDefined();
  return result!;
}

function detailField(rootNode: ParentNode = dialog()) {
  const result = rootNode.querySelector<HTMLTextAreaElement>('textarea');
  expect(result).toBeDefined();
  return result!;
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.click();
    await tick();
  });
}

async function fillDetails(value: string) {
  const field = detailField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
    await tick();
  });
}

async function openReport(index = 0, keyboard = false) {
  const trigger = button(m.report_more());
  if (keyboard) {
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await tick();
    });
    const item = menuItem(m.report_action(), index);
    await act(async () => {
      item.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await tick();
    });
  } else {
    await click(trigger);
    await click(menuItem(m.report_action(), index));
  }
  await tick();
  return dialog();
}

async function loadLatestScript(api: MockTurnstile) {
  const scripts = [...window.document.querySelectorAll<HTMLScriptElement>('script[src]')];
  expect(scripts).not.toHaveLength(0);
  currentTurnstile = api;
  Object.defineProperty(window, 'turnstile', { configurable: true, writable: true, value: api.api });
  scriptLoads += scripts.length;
  await act(async () => {
    for (const script of scripts) script.dispatchEvent(new window.Event('load'));
    await tick();
  });
}

function activeWidget(api = currentTurnstile) {
  expect(api).toBeDefined();
  const widget = [...api!.widgets.values()].at(-1);
  expect(widget).toBeDefined();
  return widget!;
}

async function verify(widget = activeWidget()) {
  await click(button('Verify test challenge', widget.container));
}

async function settle(index: number, result: ReportResult | Error) {
  await act(async () => {
    if (result instanceof Error) calls[index]!.reject(result);
    else calls[index]!.resolve(result);
    await tick();
  });
}

function statusLink() {
  return window.document.querySelector<HTMLAnchorElement>('a[href*="/moderation/reports/"]');
}

beforeEach(async () => {
  calls.length = 0;
  currentTurnstile = undefined;
  props = baseline();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients = [client];
  client.setQueryData(sessionQuery.queryKey, visitor());
  replacementClient = undefined;
  root = createRoot(host);
  await paint();
});

afterEach(async () => {
  await unmount();
  for (const activeClient of clients) activeClient.clear();
  host.replaceChildren();
  for (const script of window.document.querySelectorAll('script[src]')) script.remove();
  delete (window as Window & { turnstile?: unknown }).turnstile;
});

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('the connected report visit lazily verifies, preserves the refused draft and retries with the same key', async () => {
  expect(window.document.querySelectorAll('script[src]')).toHaveLength(0);
  await openReport();
  expect(window.document.querySelectorAll('script[src]')).toHaveLength(1);
  expect(currentTurnstile).toBeUndefined();

  const api = makeTurnstile();
  await loadLatestScript(api);
  const widget = activeWidget(api);
  expect(widget.container.dataset.sitekey).toBe('report-test-key');
  expect(widget.container.dataset.language).toBe('en');
  expect(widget.options.sitekey).toBe('report-test-key');
  expect(widget.options.language).toBe('en');

  await click(radio(m.report_other()));
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
  await fillDetails('   ');
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
  expect(detailField().getAttribute('maxlength')).toBe('4096');
  await fillDetails('x'.repeat(4097));
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
  await fillDetails('Keep this exact report draft');
  await verify(widget);
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);

  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.data).toMatchObject({
    target: { kind: 'post', id: 'post-one' },
    revisionId: 'revision-one',
    reason: 'other',
    evidence: 'Keep this exact report draft',
    botToken: expect.any(String),
  });
  expect(calls[0]!.data.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-one');

  await settle(0, { ok: false, reason: 'forbidden' });
  expect(window.document.querySelector('[role="alert"]')?.textContent).toBe(m.report_forbidden());
  expect(detailField().value).toBe('Keep this exact report draft');
  expect(radio(m.report_other()).getAttribute('aria-checked')).toBe('true');
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
  expect(api.resets).toEqual([widget.id]);

  await verify(widget);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.data.idempotencyKey).toBe(calls[0]!.data.idempotencyKey);
  expect(calls[1]!.data.botToken).not.toBe(calls[0]!.data.botToken);
  expect(calls[1]!.data).toEqual({ ...calls[0]!.data, botToken: calls[1]!.data.botToken });
  expect(calls[1]!.headers.get('x-csrf-token')).toBe('csrf-one');

  await settle(1, { ok: true, reportId: 'report-current' });
  expect(window.document.querySelector('[role="status"]')?.textContent).toContain(m.report_success());
  expect(statusLink()?.getAttribute('href')).toContain('/moderation/reports/report-current');
  expect(scriptLoads).toBe(1);
});

test('keyboard menu entry and anonymous credentials use the real form and retain the empty anonymous CSRF header', async () => {
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, anonymous());
    await tick();
  });
  await paint();
  await openReport(0, true);
  const api = makeTurnstile();
  await loadLatestScript(api);
  const widget = activeWidget(api);
  await click(radio(m.report_spam()));
  await verify(widget);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.get('x-csrf-token')).toBe('');
  expect(calls[0]!.data).toMatchObject({ target: { kind: 'post', id: 'post-one' }, reason: 'spam' });
  await settle(0, { ok: true, reportId: 'anonymous-report' });
  expect(statusLink()).toBeNull();
});

test('expiry during a pending request cannot turn a refusal into success or reset a newer token', async () => {
  await openReport();
  const api = makeTurnstile();
  await loadLatestScript(api);
  const widget = activeWidget(api);
  await click(radio(m.report_spam()));
  await verify(widget);
  await click(button(m.report_submit(), dialog()));
  const first = calls[0]!;

  await click(button('Expire test challenge', widget.container));
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
  await verify(widget);
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);

  await settle(0, { ok: false, reason: 'rate-limited', retryAfter: 2 });
  expect(window.document.querySelector('[role="alert"]')?.textContent).toBe(m.report_rate_limited({ seconds: 2 }));
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);
  expect(api.resets).toEqual([]);

  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.data.idempotencyKey).toBe(first.data.idempotencyKey);
  expect(calls[1]!.data.botToken).not.toBe(first.data.botToken);
  await settle(1, { ok: true, reportId: 'expired-in-flight-report' });
  expect(statusLink()?.getAttribute('href')).toContain('/moderation/reports/expired-in-flight-report');
});

type Boundary =
  | 'target-id'
  | 'target-kind'
  | 'revision'
  | 'account'
  | 'token'
  | 'equal-success'
  | 'away-back'
  | 'remove'
  | 'clear'
  | 'provider'
  | 'unmount';
const boundaries: Boundary[] = [
  'target-id',
  'target-kind',
  'revision',
  'account',
  'token',
  'equal-success',
  'away-back',
  'remove',
  'clear',
  'provider',
  'unmount',
];

for (const [index, boundary] of boundaries.entries()) {
  const outcome = (['success', 'refusal', 'rejection'] as const)[index % 3]!;
  test(`${boundary} retires the in-flight ${outcome} without lending it to a fresh report visit`, async () => {
    await openReport();
    const api = makeTurnstile();
    await loadLatestScript(api);
    const oldWidget = activeWidget(api);
    await click(radio(m.report_spam()));
    await verify(oldWidget);
    await click(button(m.report_submit(), dialog()));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data.target).toEqual({ kind: 'post', id: 'post-one' });
    expect(calls[0]!.data.revisionId).toBe('revision-one');
    expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-one');

    if (boundary === 'target-id') await paint({ target: { kind: 'post', id: 'post-two' } });
    if (boundary === 'target-kind') await paint({ target: { kind: 'thread', id: 'thread-two' } });
    if (boundary === 'revision') await paint({ revisionId: 'revision-two' });
    if (boundary === 'account') {
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, visitor('reader-two', 'csrf-two'));
        await tick();
      });
    }
    if (boundary === 'token') {
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, visitor('reader-one', 'csrf-two'));
        await tick();
      });
    }
    if (boundary === 'equal-success') {
      const same = client.getQueryData(sessionQuery.queryKey);
      const timestamp = client.getQueryState(sessionQuery.queryKey)!.dataUpdatedAt;
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, same, { updatedAt: timestamp });
        await tick();
      });
    }
    if (boundary === 'away-back') {
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, visitor('reader-two', 'csrf-two'));
        client.setQueryData(sessionQuery.queryKey, visitor());
        await tick();
      });
    }
    if (boundary === 'remove') {
      await act(async () => {
        client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
        await tick();
        client.setQueryData(sessionQuery.queryKey, visitor());
        await tick();
      });
    }
    if (boundary === 'clear') {
      await act(async () => {
        client.clear();
        await tick();
        client.setQueryData(sessionQuery.queryKey, visitor());
        await tick();
      });
    }
    if (boundary === 'provider') {
      replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      replacementClient.setQueryData(sessionQuery.queryKey, visitor());
      await paintProvider(replacementClient);
    }
    if (boundary === 'unmount') {
      await unmount();
      root = createRoot(host);
      await paint();
    }

    expect(api.resets).toEqual([]);
    expect(window.document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(statusLink()).toBeNull();

    if (boundary === 'target-id') expect(props.target).toEqual({ kind: 'post', id: 'post-two' });
    if (boundary === 'target-kind') expect(props.target).toEqual({ kind: 'thread', id: 'thread-two' });
    if (boundary === 'revision') expect(props.revisionId).toBe('revision-two');
    if (boundary === 'account')
      expect(client.getQueryData<{ csrfToken: string }>(sessionQuery.queryKey)?.csrfToken).toBe('csrf-two');
    if (boundary === 'token')
      expect(client.getQueryData<{ csrfToken: string }>(sessionQuery.queryKey)?.csrfToken).toBe('csrf-two');

    await openReport();
    expect(detailField().value).toBe('');
    const freshWidget = activeWidget(api);
    await click(radio(m.report_spam()));
    await verify(freshWidget);
    const freshFocus = window.document.activeElement;

    oldWidget.options.callback('retained-old-token');
    oldWidget.options['expired-callback']();
    oldWidget.options['error-callback']();
    expect(api.resets).toEqual([]);
    expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);

    if (outcome === 'success') await settle(0, { ok: true, reportId: 'stale-private-report' });
    if (outcome === 'refusal') await settle(0, { ok: false, reason: 'forbidden' });
    if (outcome === 'rejection') await settle(0, new Error('transport failed'));
    expect(calls).toHaveLength(1);
    expect(window.document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
    expect(window.document.activeElement).toBe(freshFocus);
    expect(statusLink()).toBeNull();
    expect(window.document.querySelector('[role="alert"]')).toBeNull();
    expect(api.resets).toEqual([]);

    await click(button(m.report_submit(), dialog()));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data.target).toEqual(props.target);
    expect(calls[1]!.data.revisionId).toBe(props.revisionId);
    const currentSession = client.getQueryData<{ state: string; csrfToken: string | null }>(sessionQuery.queryKey);
    expect(calls[1]!.headers.get('x-csrf-token')).toBe(
      currentSession?.state === 'signed-out' ? '' : currentSession?.csrfToken,
    );
    await settle(1, { ok: true, reportId: `fresh-${boundary}` });
    if (currentSession?.state === 'signed-in')
      expect(statusLink()?.getAttribute('href')).toContain(`/moderation/reports/fresh-${boundary}`);
    else expect(statusLink()).toBeNull();
  });
}

test('A/B/A target replacement is monotonic even when the final target returns to the first value', async () => {
  await openReport();
  const api = makeTurnstile();
  await loadLatestScript(api);
  const oldWidget = activeWidget(api);
  await click(radio(m.report_spam()));
  await verify(oldWidget);
  await click(button(m.report_submit(), dialog()));

  await paint({ target: { kind: 'thread', id: 'temporary-thread' } });
  await paint({ target: { kind: 'post', id: 'post-one' } });
  oldWidget.options.callback('late-after-away-back');
  await settle(0, { ok: true, reportId: 'stale-away-back' });
  expect(statusLink()).toBeNull();
  expect(calls).toHaveLength(1);

  await openReport();
  const freshWidget = activeWidget(api);
  await click(radio(m.report_spam()));
  await verify(freshWidget);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.data.target).toEqual({ kind: 'post', id: 'post-one' });
  await settle(1, { ok: true, reportId: 'current-after-away-back' });
  expect(statusLink()?.getAttribute('href')).toContain('/moderation/reports/current-after-away-back');
});

test('close and reopen starts a new ceremony, removes old private status and ignores the prior success timer and token', async () => {
  await openReport();
  const api = makeTurnstile();
  await loadLatestScript(api);
  const oldWidget = activeWidget(api);
  await click(radio(m.report_spam()));
  await verify(oldWidget);
  await click(button(m.report_submit(), dialog()));
  await settle(0, { ok: true, reportId: 'first-private-report' });
  expect(statusLink()).not.toBeNull();

  await act(async () => {
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick();
  });
  expect(window.document.querySelector('[data-slot="dialog-content"]')).toBeNull();
  expect(statusLink()).not.toBeNull();
  await openReport();
  expect(statusLink()).toBeNull();
  const newWidget = activeWidget(api);
  oldWidget.options.callback('late-first-token');
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 950));
  expect(window.document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
  await click(radio(m.report_spam()));
  await verify(newWidget);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(2);
  expect(calls[1]!.data.idempotencyKey).not.toBe(calls[0]!.data.idempotencyKey);
  expect(calls[1]!.data.botToken).not.toBe('late-first-token');
  await settle(1, { ok: true, reportId: 'second-private-report' });
  expect(statusLink()?.getAttribute('href')).toContain('/moderation/reports/second-private-report');
});

test('session removal fences the retained real form submit before a later signed-in result can upgrade it', async () => {
  await openReport();
  const api = makeTurnstile();
  await loadLatestScript(api);
  const oldWidget = activeWidget(api);
  await click(radio(m.report_spam()));
  await verify(oldWidget);
  const retainedSubmit = button(m.report_submit(), dialog());

  await act(async () => {
    client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
    retainedSubmit.click();
    await tick();
  });
  expect(calls).toHaveLength(0);
  expect(window.document.querySelector('[data-slot="dialog-content"]')).toBeNull();

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, visitor('reader-two', 'csrf-two'));
    retainedSubmit.click();
    await tick();
  });
  expect(calls).toHaveLength(0);
  oldWidget.options.callback('retained-token-after-sign-in');
  expect(window.document.querySelector('[data-slot="dialog-content"]')).toBeNull();

  await openReport();
  const freshWidget = activeWidget(api);
  await click(radio(m.report_spam()));
  await verify(freshWidget);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-two');
  expect(calls[0]!.data.botToken).not.toBe('retained-token-after-sign-in');
  await settle(0, { ok: true, reportId: 'replacement-session-report' });
});

test('independent report dialogs share one script while each retains only its own current verification owner', async () => {
  const config = { sitekey: 'shared-report-key', scriptUrl: `https://turnstile.test/shared-${++scriptSequence}.js` };
  const firstTarget: Props = { target: { kind: 'post', id: 'post-one' }, verification: config };
  const secondTarget: Props = { target: { kind: 'thread', id: 'thread-two' }, verification: config };
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <StrictMode>
          <PostActions {...firstTarget} />
          <PostActions {...secondTarget} />
        </StrictMode>
      </QueryClientProvider>,
    );
  });
  await click(button(m.report_more(), host, 0));
  await click(menuItem(m.report_action()));
  await tick();
  expect(window.document.querySelectorAll('script[src]')).toHaveLength(1);
  const api = makeTurnstile();
  await loadLatestScript(api);
  expect(api.widgets.size).toBe(1);
  const widgetA = activeWidget(api);
  const retainedA = widgetA.options.callback;
  await click(button(m.report_cancel(), dialog()));
  expect(api.widgets.size).toBe(0);

  await click(button(m.report_more(), host, 1));
  await click(menuItem(m.report_action()));
  await tick();
  expect(window.document.querySelectorAll('script[src]')).toHaveLength(0);
  const widgetB = activeWidget(api);
  retainedA('old-first-dialog-token');
  await click(radio(m.report_spam()));
  await verify(widgetB);
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.data.target).toEqual({ kind: 'thread', id: 'thread-two' });
  await settle(0, { ok: true, reportId: 'second-dialog-report' });
});

// Capture the installed handlers on mounted React elements; no controller or shared component is replaced.
function retainedFormSubmit() {
  const form = dialog().querySelector('form')!;
  const key = Object.keys(form).find((candidate) => candidate.startsWith('__reactProps$'));
  expect(key).toBeDefined();
  const props = (form as unknown as Record<string, unknown>)[key!] as {
    onSubmit: (event: { preventDefault(): void }) => Promise<void>;
  };
  return () => props.onSubmit({ preventDefault() {} });
}

async function retainedVerificationHandlers() {
  const { Verification } = await import('../src/report/turnstile');
  const container = dialog().querySelector('[data-slot="report-verification"] > div')!;
  const key = Object.keys(container).find((candidate) => candidate.startsWith('__reactFiber$'));
  expect(key).toBeDefined();
  type Fiber = { type: unknown; return: Fiber | null; memoizedProps: unknown };
  let fiber = (container as unknown as Record<string, unknown>)[key!] as Fiber | null;
  while (fiber && fiber.type !== Verification) fiber = fiber.return;
  expect(fiber?.type).toBe(Verification);
  const props = fiber!.memoizedProps as ComponentProps<typeof Verification>;
  return { onToken: props.onToken, onStart: props.onStart, reset: props.reset.current! };
}

test('retained installed submit, start, token and reset handlers cannot touch a reopened ceremony', async () => {
  await openReport();
  const api = makeTurnstile();
  await loadLatestScript(api);
  const oldWidget = activeWidget(api);
  await click(radio(m.report_other()));
  await fillDetails('Private prior ceremony');
  await verify(oldWidget);
  const submitOld = retainedFormSubmit();
  const old = await retainedVerificationHandlers();
  await click(button(m.report_cancel(), dialog()));
  await openReport();
  const freshWidget = activeWidget(api);
  expect(freshWidget.id).not.toBe(oldWidget.id);
  expect(detailField().value).toBe('');
  expect(api.removals).toContain(oldWidget.id);
  await click(radio(m.report_spam()));
  await verify(freshWidget);
  const focused = window.document.activeElement;

  await act(async () => {
    old.onStart();
    old.onToken('retained-token');
    old.reset();
    await submitOld();
    await tick();
  });
  expect(calls).toHaveLength(0);
  expect(api.resets).toEqual([]);
  expect(window.document.activeElement).toBe(focused);
  expect(window.document.querySelector('[role="alert"]')).toBeNull();
  expect(statusLink()).toBeNull();
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.data.botToken).not.toBe('retained-token');
  expect(calls[0]!.data.evidence).toBeUndefined();
  await settle(0, { ok: true, reportId: 'reopened-current' });
});

test('equal fresh target/config allocation preserves the draft and token while expiry with equal token bytes retires old submission', async () => {
  await openReport();
  const api = makeTurnstile();
  await loadLatestScript(api);
  const widget = activeWidget(api);
  await click(radio(m.report_other()));
  await fillDetails('Retain through equivalent renders');
  await act(async () => widget.options.callback('equal-token-bytes'));
  const submitOldToken = retainedFormSubmit();
  const before = await retainedVerificationHandlers();

  await paint({ target: { ...props.target }, verification: { ...props.verification } });
  expect(activeWidget(api)).toBe(widget);
  expect(detailField().value).toBe('Retain through equivalent renders');
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);
  expect((await retainedVerificationHandlers()).reset).toBe(before.reset);
  expect(api.removals).toEqual([]);

  await act(async () => {
    widget.options['expired-callback']();
    await tick();
    widget.options.callback('equal-token-bytes');
    await tick();
    await submitOldToken();
  });
  expect(calls).toHaveLength(0);
  expect(api.resets).toEqual([]);
  expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);
  await click(button(m.report_submit(), dialog()));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.data).toMatchObject({
    evidence: 'Retain through equivalent renders',
    botToken: 'equal-token-bytes',
  });
  await settle(0, { ok: true, reportId: 'equal-allocation-report' });
});

for (const event of ['equal-success', 'account-away-back', 'remove', 'clear'] as const) {
  test(`${event} synchronously fences an installed submit before React processes the cache notification`, async () => {
    await openReport();
    const api = makeTurnstile();
    await loadLatestScript(api);
    await click(radio(m.report_spam()));
    await verify();
    const retained = retainedFormSubmit();
    const handlers = await retainedVerificationHandlers();
    const timestamp = client.getQueryState(sessionQuery.queryKey)!.dataUpdatedAt;
    const same = client.getQueryData(sessionQuery.queryKey);
    await act(async () => {
      if (event === 'equal-success') client.setQueryData(sessionQuery.queryKey, same, { updatedAt: timestamp });
      if (event === 'account-away-back') {
        client.setQueryData(sessionQuery.queryKey, visitor('reader-two', 'csrf-two'));
        client.setQueryData(sessionQuery.queryKey, same, { updatedAt: timestamp });
      }
      if (event === 'remove') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      if (event === 'clear') client.clear();
      handlers.onStart();
      handlers.onToken('late-token-before-render');
      await retained();
      await tick();
    });
    expect(calls).toHaveLength(0);
    expect(statusLink()).toBeNull();
    expect(window.document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    await act(async () => client.setQueryData(sessionQuery.queryKey, visitor()));
    await openReport();
    await click(radio(m.report_spam()));
    await verify();
    await click(button(m.report_submit(), dialog()));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-one');
    expect(calls[0]!.data.botToken).not.toBe('late-token-before-render');
    await settle(0, { ok: true, reportId: `fresh-synchronous-${event}` });
  });
}

for (const state of ['unknown', 'unavailable', 'signed-out'] as const) {
  test(`${state} retires private success and old handlers before a later signed-in session can be used`, async () => {
    await openReport();
    const api = makeTurnstile();
    await loadLatestScript(api);
    await click(radio(m.report_spam()));
    await verify();
    const retained = retainedFormSubmit();
    await click(button(m.report_submit(), dialog()));
    await settle(0, { ok: true, reportId: 'prior-private-report' });
    expect(statusLink()).not.toBeNull();
    await act(async () => client.setQueryData(sessionQuery.queryKey, { state, subject: null, csrfToken: null }));
    expect(statusLink()).toBeNull();
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, visitor('reader-two', 'csrf-two'));
      await retained();
    });
    expect(calls).toHaveLength(1);
    await openReport();
    expect(detailField().value).toBe('');
    await click(radio(m.report_spam()));
    await verify();
    await click(button(m.report_submit(), dialog()));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get('x-csrf-token')).toBe('csrf-two');
    await settle(1, { ok: true, reportId: `current-after-${state}` });
  });
}

for (const [result, message] of [
  [{ ok: false, reason: 'closed' }, () => m.platform_closed_message()],
  [{ ok: false, reason: 'invalid' }, () => m.report_invalid()],
  [{ ok: false, reason: 'rate-limited', retryAfter: 3 }, () => m.report_rate_limited({ seconds: 3 })],
  [{ ok: false, reason: 'unavailable' }, () => m.report_unavailable()],
  [new Error('UNTRUSTED TRANSPORT TEXT'), () => m.report_unavailable()],
] satisfies [ReportResult | Error, () => string][]) {
  test(`the installed form preserves the original command key after ${result instanceof Error ? 'a lost response' : result.ok ? 'success' : result.reason}`, async () => {
    await openReport();
    const api = makeTurnstile();
    await loadLatestScript(api);
    const widget = activeWidget(api);
    await click(radio(m.report_illegal()));
    await verify(widget);
    expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
    await fillDetails('   ');
    expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
    await fillDetails('x'.repeat(4096));
    expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(false);
    await click(button(m.report_submit(), dialog()));
    const original = calls[0]!;
    await settle(0, result);
    expect(window.document.querySelector('[role="alert"]')?.textContent).toBe(message());
    expect(dialog().textContent).not.toContain('UNTRUSTED');
    expect(detailField().value).toBe('x'.repeat(4096));
    expect(radio(m.report_illegal()).getAttribute('aria-checked')).toBe('true');
    expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
    await paint({ target: { ...props.target }, verification: { ...props.verification } });
    await verify(widget);
    await click(button(m.report_submit(), dialog()));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data).toEqual({ ...original.data, botToken: calls[1]!.data.botToken });
    expect(calls[1]!.data.botToken).not.toBe(original.data.botToken);
    expect(calls[1]!.headers.get('x-csrf-token')).toBe('csrf-one');
    expect(api.resets).toEqual([widget.id]);
    expect(api.widgets.size).toBe(1);
    await settle(1, { ok: true, reportId: 'retried-original-command' });
  });
}

for (const outcome of ['success', 'refusal', 'rejection'] as const) {
  test(`an old ${outcome} cannot unlock, reset, close or focus a fresh pending report`, async () => {
    await openReport();
    const api = makeTurnstile();
    await loadLatestScript(api);
    const old = await retainedVerificationHandlers();
    await click(radio(m.report_spam()));
    await verify();
    await click(button(m.report_submit(), dialog()));
    await paint({ target: { kind: 'subject', id: 'fresh-subject' }, revisionId: 'fresh-revision' });
    await openReport();
    await click(radio(m.report_other()));
    await fillDetails('Fresh pending draft');
    await verify();
    await click(button(m.report_submit(), dialog()));
    const focus = window.document.activeElement;
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data.target).toEqual({ kind: 'subject', id: 'fresh-subject' });
    expect(calls[1]!.data.revisionId).toBe('fresh-revision');
    expect(calls[1]!.data.idempotencyKey).not.toBe(calls[0]!.data.idempotencyKey);
    old.onStart();
    old.onToken('retained-before-old-settlement');
    old.reset();
    await settle(
      0,
      outcome === 'success'
        ? { ok: true, reportId: 'stale-report' }
        : outcome === 'refusal'
          ? { ok: false, reason: 'forbidden' }
          : new Error('UNTRUSTED OLD REJECTION'),
    );
    expect(button(m.report_submit(), dialog()).hasAttribute('disabled')).toBe(true);
    expect(detailField().value).toBe('Fresh pending draft');
    expect(window.document.activeElement).toBe(focus);
    expect(window.document.querySelector('[role="alert"]')).toBeNull();
    expect(api.resets).toEqual([]);
    expect(statusLink()).toBeNull();
    expect(calls).toHaveLength(2);
    await settle(1, { ok: true, reportId: 'fresh-pending-report' });
    expect(statusLink()?.getAttribute('href')).toContain('/moderation/reports/fresh-pending-report');
  });
}

test('a held script and actual retained start/token/reset callbacks cannot survive target replacement or unmount', async () => {
  await openReport();
  const script = window.document.querySelector<HTMLScriptElement>('script[src]')!;
  const retainedLoad = script.onload!;
  const old = await retainedVerificationHandlers();
  await paint({ target: { kind: 'thread', id: 'replacement-before-load' } });
  await openReport();
  const currentScript = window.document.querySelector<HTMLScriptElement>('script[src]')!;
  expect(currentScript).not.toBe(script);
  const api = makeTurnstile();
  Object.defineProperty(window, 'turnstile', { configurable: true, writable: true, value: api.api });
  await act(async () => {
    retainedLoad.call(script, new window.Event('load') as unknown as Event);
    old.onStart();
    old.onToken('old-loading-token');
    old.reset();
    await tick();
  });
  expect(api.widgets.size).toBe(0);
  expect(calls).toHaveLength(0);
  await loadLatestScript(api);
  expect(api.widgets.size).toBe(1);
  await click(radio(m.report_spam()));
  await verify();
  const retainedSubmit = retainedFormSubmit();
  const current = await retainedVerificationHandlers();
  await unmount();
  const removals = [...api.removals];
  await act(async () => {
    current.onStart();
    current.onToken('after-unmount');
    current.reset();
    await retainedSubmit();
    await tick();
  });
  expect(api.removals).toEqual(removals);
  expect(api.widgets.size).toBe(0);
  expect(api.resets).toEqual([]);
  expect(calls).toHaveLength(0);
});
