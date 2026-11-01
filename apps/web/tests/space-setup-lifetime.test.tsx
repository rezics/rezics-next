import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, isValidElement, useState, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { SetupChoice, SetupCommand, SetupFailure, SetupResult, SetupSnapshot } from '../src/community/space-setup';
import type { BoardChoiceSource } from '../src/community/setup-board-picker';
import type { SetupTransport } from '../src/stories/patterns/space-setup/space-setup';
import type { SpaceSetupInitialAdmission } from '../src/community/space-setup-lifetime';

// Production page, form, session query and choice controls; only the server action boundary and
// browser environment are supplied. Authored coverage; acceptance remains deferred to integration.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/new' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
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
type ReadResult = SetupSnapshot | SetupFailure;
type ReadCall = { data: { spaceId?: string }; pending: ReturnType<typeof deferred<ReadResult>> };
type CommandCall = {
  data: SetupCommand;
  headers?: Record<string, string>;
  pending: ReturnType<typeof deferred<SetupResult>>;
};
type ChoiceCall = {
  kind: 'context' | 'scheme' | 'concept';
  id: string;
  pending: ReturnType<typeof deferred<SetupChoice | SetupFailure>>;
};
const reads: ReadCall[] = [];
const commands: CommandCall[] = [];
const choices: ChoiceCall[] = [];
const searches: { query: string; signal?: AbortSignal; pending: ReturnType<typeof deferred<unknown>> }[] = [];
mock.module('../src/community/space-actions', () => ({
  readSpaceSetup: (input: { data: { spaceId?: string } }) => {
    const call = { data: input.data, pending: deferred<ReadResult>() };
    reads.push(call);
    return call.pending.promise;
  },
  changeSpaceSetup: (input: { data: SetupCommand; headers?: Record<string, string> }) => {
    const call = { ...input, pending: deferred<SetupResult>() };
    commands.push(call);
    return call.pending.promise;
  },
  resolveSpaceSetupChoice: (input: { data: { kind: ChoiceCall['kind']; id: string } }) => {
    const call = { ...input.data, pending: deferred<SetupChoice | SetupFailure>() };
    choices.push(call);
    return call.pending.promise;
  },
  searchSpaceSetupContexts: (input: { data: { query: string }; signal?: AbortSignal }) => {
    const call = { query: input.data.query, signal: input.signal, pending: deferred<unknown>() };
    searches.push(call);
    return call.pending.promise;
  },
  readSpaceSetupBoardChoices: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }),
}));
const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    const chain = {
      validator() {
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        return handler;
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://site.test/action'),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { SpaceSetupEntry, SpaceSetupPage } = await import('../src/community/space-setup-page');
const { SpaceSetupForm } = await import('../src/stories/patterns/space-setup/space-setup');
const { captureSpaceSetupInitialAdmission } = await import('../src/community/space-setup-lifetime');
const { m } = await import('../src/paraglide/messages.js');
const id = (number: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(number).padStart(12, '0')}`;
const subject = id(1);
const spaceId = id(2);
const realmId = id(3);
const contextId = id(4);
const viewer = (csrfToken: string | null = 'csrf-one') => ({ state: 'signed-in', subject, csrfToken });
const empty: SetupSnapshot = {
  kind: 'ready',
  space: null,
  realm: null,
  permitted: { address: true, settings: false, scheme: false, board: false },
};
const existing: SetupSnapshot = {
  kind: 'ready',
  space: {
    id: spaceId,
    head: id(5),
    title: 'Saved Space',
    summary: '',
    address: 'saved-space',
    realmId,
  },
  realm: {
    id: realmId,
    head: id(6),
    title: 'Saved Realm',
    summary: '',
    visibility: 'public',
    contextId,
    schemeId: null,
  },
  permitted: { address: true, settings: true, scheme: false, board: false },
};
const unavailable: SetupFailure = { kind: 'failure', reason: 'unavailable', status: 503 };
const retiredLabel = 'Retired private Context label';
const loaderAdmissions = new WeakMap<object, SpaceSetupInitialAdmission>();
function authenticated<T extends object>(value: T): T & { reader: { kind: 'session'; subject: string } } {
  return { ...value, reader: { kind: 'session', subject } };
}
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let mounted = false;
let client: QueryClient;
let router: ReturnType<typeof createRouter>;
let rerender: (() => void) | undefined;
let replaceBoardSource: ((source: BoardChoiceSource) => void) | undefined;

function PageFrame({ initial, spaceId: target }: { initial: ReadResult; spaceId?: string }) {
  const [, setRevision] = useState(0);
  rerender = () => setRevision((revision) => revision + 1);
  const admission = loaderAdmissions.get(initial);
  return <SpaceSetupPage initial={initial} admission={admission} spaceId={target} />;
}

function DynamicFormFrame({
  initial,
  transport,
  source,
}: {
  initial: SetupSnapshot;
  transport: SetupTransport;
  source: BoardChoiceSource;
}) {
  const [currentSource, setCurrentSource] = useState(source);
  replaceBoardSource = setCurrentSource;
  return <SpaceSetupForm initial={initial} transport={transport} boardChoices={currentSource} />;
}

async function paint() {
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function close() {
  if (!mounted) return;
  await act(async () => {
    root.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted = false;
  client.clear();
  rerender = undefined;
  replaceBoardSource = undefined;
}
async function mount(
  content: ReactNode,
  session: unknown = viewer(),
  bindSnapshot?: ReadResult,
  sessionAtRender?: unknown,
) {
  await close();
  reads.length = 0;
  commands.length = 0;
  choices.length = 0;
  searches.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  const initial =
    bindSnapshot ??
    (isValidElement(content) && content.type === PageFrame
      ? (content.props as { initial: ReadResult }).initial
      : undefined);
  if (initial) {
    const actualSubject =
      session && typeof session === 'object' && 'state' in session && session.state === 'signed-in' &&
      'subject' in session && typeof session.subject === 'string'
        ? session.subject
        : undefined;
    if (actualSubject) initial.reader = { kind: 'session', subject: actualSubject };
    loaderAdmissions.set(initial, captureSpaceSetupInitialAdmission(client));
  }
  if (sessionAtRender !== undefined) client.setQueryData(sessionQuery.queryKey, sessionAtRender);
  const route = createRootRoute({ component: () => content });
  router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/realms/new'] }) });
  root = createRoot(host);
  mounted = true;
  await paint();
}
async function setSession(session: unknown) {
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, session);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function edit(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof window.HTMLInputElement
        ? window.HTMLInputElement.prototype
        : window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(node).toBeDefined();
  return node!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function submit() {
  const form = host.querySelector('form');
  expect(form).not.toBeNull();
  await act(async () => {
    form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    pending.resolve(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function hidden(...values: string[]) {
  for (const value of values) expect(host.textContent).not.toContain(value);
}

afterAll(async () => {
  await close();
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('same-account session revisions retire Space setup command/read callbacks and do not restore the old draft on return', async () => {
  const initial = { ...empty, permitted: { ...empty.permitted } };
  await mount(<PageFrame initial={initial} />);
  const title = host.querySelector('input')!;
  await edit(title, 'Private draft from first caller');
  await submit();
  expect(commands).toHaveLength(1);
  expect(commands[0]!.headers).toEqual({ 'X-CSRF-Token': 'csrf-one' });

  await setSession(viewer('csrf-two'));
  hidden('Private draft from first caller');
  const readsBeforeLateCommand = reads.length;
  await settle(
    commands[0]!.pending,
    authenticated({
      kind: 'space' as const,
      space: { id: spaceId, head: id(7), title: 'Late private result', summary: '', address: null, realmId: null },
    }),
  );
  expect(reads).toHaveLength(readsBeforeLateCommand);
  hidden('Late private result');

  await setSession({ state: 'signed-out', subject: null, csrfToken: null });
  await setSession(viewer('csrf-one'));
  hidden('Private draft from first caller', 'Late private result');
  expect(commands).toHaveLength(1);
});

test('a route-loader snapshot stays bound to the session-cache revision that admitted its read', async () => {
  const initial = { ...existing, permitted: { ...existing.permitted } };
  await mount(<PageFrame initial={initial} spaceId={spaceId} />, viewer('csrf-one'), initial, viewer('csrf-two'));
  hidden('Saved Realm', 'Saved Space');
  await setSession(viewer('csrf-one'));
  hidden('Saved Realm', 'Saved Space');
  expect(choices).toHaveLength(0);
});

test('healthy rerender keeps a draft; uncertain retry reuses the frozen command and failed refresh keeps returned identity', async () => {
  const initial = { ...empty, permitted: { ...empty.permitted } };
  await mount(<PageFrame initial={initial} />);
  const title = host.querySelector('input')!;
  await edit(title, 'Entered Space title');
  await act(async () => {
    rerender?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.querySelector('input')?.value).toBe('Entered Space title');
  await submit();
  expect(commands).toHaveLength(1);
  const first = commands[0]!;
  expect(Object.isFrozen(first.data)).toBe(true);
  await settle(first.pending, unavailable);
  await click(m.space_setup_retry());
  expect(commands).toHaveLength(2);
  expect(commands[1]!.data).toBe(first.data);
  expect(commands[1]!.headers).toEqual(first.headers);
  await settle(commands[1]!.pending, {
    kind: 'space',
    space: {
      id: spaceId,
      head: id(8),
      title: 'Returned Space identity',
      summary: 'Saved despite refresh',
      address: null,
      realmId: null,
    },
  });
  expect(reads).toHaveLength(1);
  expect(reads[0]!.data).toEqual({ spaceId });
  await settle(reads[0]!.pending, unavailable);
  expect(host.textContent).toContain('Returned Space identity');
  expect(host.textContent).toContain(m.space_setup_unavailable());
});

test('SpaceSetupEntry fences private query cache across same-account replacement and away-and-back revisions', async () => {
  const result: SetupSnapshot = {
    ...existing,
    permitted: { address: true, settings: false, scheme: false, board: false },
  };
  await mount(<SpaceSetupEntry spaceId={spaceId} />);
  expect(reads).toHaveLength(1);
  await setSession(viewer('csrf-two'));
  expect(reads).toHaveLength(2);
  await settle(reads[0]!.pending, authenticated(result));
  hidden(m.space_setup_entry());
  await settle(reads[1]!.pending, authenticated(result));
  expect(host.textContent).toContain(m.space_setup_entry());

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    client.setQueryData(sessionQuery.queryKey, viewer('csrf-two'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(reads).toHaveLength(3);
  hidden(m.space_setup_entry());
  await settle(reads[2]!.pending, authenticated(result));
  expect(host.textContent).toContain(m.space_setup_entry());
});

test('StrictMode page retires current, search and exact Context resolutions on source replacement and same-snapshot remount', async () => {
  const initial = { ...existing, permitted: { ...existing.permitted } };
  await mount(<PageFrame initial={initial} spaceId={spaceId} />);
  expect(choices.length).toBeGreaterThan(0);
  expect(choices.every((call) => call.kind === 'context' && call.id === contextId)).toBe(true);
  await click(m.space_setup_realm());

  const search = [...host.querySelectorAll<HTMLInputElement>('input[type="search"]')].find((input) =>
    input.id.includes('query'),
  );
  expect(search).toBeDefined();
  await act(async () => {
    search!.focus();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await edit(search!, 'retired query');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 270));
  });
  expect(searches).toHaveLength(1);

  await setSession(viewer('csrf-two'));
  expect(searches[0]!.signal?.aborted).toBe(true);
  for (const choice of choices)
    await settle(choice.pending, authenticated({ id: contextId, label: retiredLabel }));
  searches[0]!.pending.resolve(
    authenticated({ contexts: [{ id: contextId, label: retiredLabel }], next: null }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  hidden(retiredLabel, 'Saved Realm');

  await close();
  await mount(<PageFrame initial={initial} spaceId={spaceId} />, viewer('csrf-two'));
  hidden(retiredLabel, 'Saved Realm');
  expect(choices).toHaveLength(0);
});

test('production setup form fences late Board source and text pages after concept query changes', async () => {
  const retiredSource = deferred<{ concepts: readonly SetupChoice[]; next: string | null }>();
  const retiredText = deferred<{ concepts: readonly SetupChoice[]; next: string | null }>();
  const schemeId = id(9);
  const conceptId = id(10);
  const initial: SetupSnapshot = {
    ...existing,
    realm: { ...existing.realm!, schemeId },
    permitted: { ...existing.permitted, board: true },
  };
  const firstSource: BoardChoiceSource = {
    schemes: async () => ({ schemes: [], next: null }),
    concepts: async () => retiredSource.promise,
  };
  const nextSource: BoardChoiceSource = {
    schemes: async () => ({ schemes: [], next: null }),
    concepts: async ({ query }) =>
      query === 'old-text'
        ? retiredText.promise
        : { concepts: [{ id: conceptId, label: 'Current Board concept' }], next: null },
  };
  const transport: SetupTransport = {
    command: async () => unavailable,
    read: async () => unavailable,
    choice: async (_kind, id) => ({ id, label: 'Current Context' }),
  };
  await mount(<DynamicFormFrame initial={initial} transport={transport} source={firstSource} />);
  await click(m.space_setup_board());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 270));
  });
  replaceBoardSource?.(nextSource);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await click(m.space_setup_board());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 270));
  });
  expect(host.textContent).toContain('Current Board concept');

  const search = host.querySelector<HTMLInputElement>('input[type="search"]');
  expect(search).not.toBeNull();
  await edit(search!, 'old-text');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 270));
  });
  await edit(search!, 'new-text');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 270));
  });
  retiredSource.resolve({ concepts: [{ id: id(11), label: 'Retired source concept' }], next: 'old-next' });
  retiredText.resolve({ concepts: [{ id: id(12), label: 'Retired text concept' }], next: null });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  hidden('Retired source concept', 'Retired text concept');
  expect(host.textContent).toContain('Current Board concept');
});
