import { afterAll, afterEach, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { AppealReadInput, AppealReadState, PrivateAppealPage } from '../src/moderation/appeals-read-model';

const { dirname } = await import('node:path');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/boards/board/moderation?tab=appeals' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Element: browser.Element,
  Node: browser.Node,
  MutationObserver: browser.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { ModerationAppealsPage } = await import('../src/moderation/appeals-tab');
const { appealReadKey, prepareModerationAppealRead } = await import('../src/moderation/appeals-read-model');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');

const input: AppealReadInput = { boardId: 'board' };
const viewerId = 'moderator';
const token = 'appeal-focus-session';
const origin = { subject: viewerId, csrfFingerprint: await privateReaderFingerprint(token) };
let cache: InstanceType<typeof QueryClient> | null = null;
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
let external: HTMLElement | null = null;
let generation = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
function page(state: AppealReadState): PrivateAppealPage {
  return {
    appeals: [],
    targets: [],
    next: null,
    viewerId,
    readKey: appealReadKey(input),
    generation: `appeal-generation-${++generation}`,
    state,
    readerOrigin: origin,
  };
}
async function mount(state: AppealReadState, read: (input: AppealReadInput) => Promise<PrivateAppealPage>) {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  cache.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: viewerId, csrfToken: token });
  const initial = await prepareModerationAppealRead(cache, input, async () => page(state));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: cache! },
        createElement(ModerationAppealsPage, { page: initial, input, read }),
      ),
    ),
  );
}
async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function unmount() {
  if (root) await act(async () => root!.unmount());
  cache?.clear();
  host?.remove();
  external?.remove();
  root = null;
  cache = null;
  host = null;
  external = null;
}
function button(label: string) {
  return [...host!.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!;
}
async function activate(control: HTMLButtonElement, pointer = false) {
  control.focus();
  await act(async () =>
    control.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, detail: pointer ? 1 : 0 })),
  );
}
afterEach(unmount);
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});

test('keyboard retries focus each admitted recovery control and the queue after deferred recovery', async () => {
  const attempts = [deferred<PrivateAppealPage>(), deferred<PrivateAppealPage>(), deferred<PrivateAppealPage>()];
  let reads = 0;
  await mount('unavailable', async () => attempts[reads++]!.promise);
  for (const attempt of attempts.slice(0, 2)) {
    await activate(button(m.moderation_appeals_read_retry()));
    expect(host!.textContent).toContain(m.moderation_appeals_read_loading());
    attempt.resolve(page('unavailable'));
    await flush();
    expect(document.activeElement).toBe(button(m.moderation_appeals_read_retry()));
  }
  await activate(button(m.moderation_appeals_read_retry()));
  expect(host!.textContent).toContain(m.moderation_appeals_read_loading());
  attempts[2]!.resolve(page('ready'));
  await flush();
  expect(document.activeElement).toBe(host!.querySelector('article'));
  expect(reads).toBe(3);
});

test('moved focus, pointer activation, and retired admission cancel local handoff', async () => {
  let calls = 0;
  const elsewhere = document.createElement('button');
  external = elsewhere;
  elsewhere.textContent = 'Elsewhere';
  document.body.append(elsewhere);
  const moved = deferred<PrivateAppealPage>();
  await mount('unavailable', async () => {
    calls++;
    return moved.promise;
  });
  await activate(button(m.moderation_appeals_read_retry()));
  await act(async () => elsewhere.focus());
  moved.resolve(page('ready'));
  await flush();
  expect(document.activeElement).toBe(elsewhere);
  expect(host!.querySelector('article')).not.toBe(document.activeElement);
  await unmount();

  const pointer = deferred<PrivateAppealPage>();
  await mount('unavailable', async () => {
    calls++;
    return pointer.promise;
  });
  await activate(button(m.moderation_appeals_read_retry()), true);
  pointer.resolve(page('ready'));
  await flush();
  expect(host!.querySelector('article')).not.toBe(document.activeElement);
  await unmount();

  const retired = deferred<PrivateAppealPage>();
  await mount('unavailable', async () => {
    calls++;
    return retired.promise;
  });
  await activate(button(m.moderation_appeals_read_retry()));
  cache!.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'replacement', csrfToken: 'new-session' });
  await flush();
  retired.resolve(page('ready'));
  await flush();
  expect(host!.textContent).toContain(m.moderation_appeals_read_closed());
  expect(host!.querySelector('article')).not.toBe(document.activeElement);
  expect(calls).toBe(3);
});
