import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkbenchRead } from '../src/moderation/workbench-queue/read';
import type { ResolutionCommand } from '../src/moderation/appeal-resolution';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/authoring-departure', () => ({
  AuthoringDepartureBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuthoringDeparture: () => ({ release() {} }),
}));
const sent: ResolutionCommand[] = [];
mock.module('../src/moderation/actions', () => ({
  actionOnReport: async () => ({ ok: true }),
  actionOnAppeal: async ({ data }: { data: ResolutionCommand }) => {
    sent.push(data);
    throw new Error('Response lost');
  },
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/moderation/workbench' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Element: browser.Element,
  Node: browser.Node,
  MutationObserver: browser.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { WorkbenchPage } = await import('../src/moderation/workbench-queue/page');
const { prepareWorkbenchRead } = await import('../src/moderation/workbench-queue/read');
const { workbenchSearch, workbenchReadKey } = await import('../src/moderation/workbench-queue/scope');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { m } = await import('../src/paraglide/messages.js');
const search = workbenchSearch({ queue: 'appeals', board: 'board', case: 'appeal', cursor: 'captured' });
const session = { state: 'signed-in', subject: 'moderator', csrfToken: 'csrf' };
const origin = { subject: session.subject, csrfFingerprint: await privateReaderFingerprint(session.csrfToken) };
// Presentation fixture; the mounted composed transport case below uses the installed client.
const selected = {
  id: 'appeal',
  decisionId: 'decision',
  appellantId: 'private-account',
  statement: 'Reconsider.',
  createdAt: '2026-01-01T00:00:00Z',
  canResolve: true,
  decision: { statement: 'Original decision.', target: { kind: 'board' as const, id: 'board' } },
};
function page(state: WorkbenchRead['state'], resolved = false): WorkbenchRead {
  return {
    search,
    readKey: workbenchReadKey(search),
    generation: crypto.randomUUID(),
    readerOrigin: origin,
    state,
    realms: [],
    realmsNext: null,
    boards: [],
    boardsNext: null,
    reports: [],
    appeals: [],
    cases: [],
    next: 'sparse-next',
    selectedTarget: null,
    ...(state === 'ready'
      ? {
          selectedAppeal: resolved
            ? {
                ...selected,
                decision: {
                  ...selected.decision,
                  appeal: { outcome: 'upheld' as const, statement: 'Reviewed.', resolvedAt: selected.createdAt },
                },
              }
            : selected,
        }
      : {}),
  };
}
let root: ReturnType<typeof createRoot> | undefined;
let cache: InstanceType<typeof QueryClient>;
let host: HTMLElement;
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function mount(
  initial: WorkbenchRead,
  read: (input: typeof search) => Promise<WorkbenchRead>,
  refresh = async () => {},
) {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], session);
  const prepared = await prepareWorkbenchRead(cache, search, async () => initial, new AbortController().signal);
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={cache}>
        <WorkbenchPage page={prepared} search={search} onSearch={() => {}} read={read} onRefresh={refresh} />
      </QueryClientProvider>,
    ),
  );
}
function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)!;
}
async function click(control: HTMLButtonElement, detail = 0) {
  control.focus();
  await act(async () => {
    control.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, detail }));
  });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  cache?.clear();
  host?.remove();
  sent.length = 0;
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});

test('same-input inspection retries recover keyboard focus and show a resolved selection outside a sparse pending page', async () => {
  const calls: (typeof search)[] = [];
  let finish!: (value: WorkbenchRead) => void;
  await mount(page('unavailable'), async (input) => {
    calls.push(input);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await click(button(m.moderation_queue_retry()));
  await act(async () => finish(page('unavailable')));
  expect(document.activeElement).toBe(button(m.moderation_queue_retry()));
  await click(button(m.moderation_queue_retry()));
  await act(async () => finish(page('ready', true)));
  expect(calls).toEqual([search, search]);
  expect(host.textContent).toContain('Reviewed.');
  expect(host.textContent).toContain(m.moderation_appeal_upheld());
  expect(host.textContent).not.toContain('private-account');
  expect(document.activeElement).toBe(host.querySelector('article'));
  expect(host.querySelector('a')?.getAttribute('href')).toContain('cursor=captured');
});

test('pointer retry and moved focus do not steal focus; session replacement fences late inspection', async () => {
  for (const mode of ['pointer', 'moved', 'session', 'account']) {
    let finish!: (value: WorkbenchRead) => void;
    await mount(
      page('unavailable'),
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click(button(m.moderation_queue_retry()), mode === 'pointer' ? 1 : 0);
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    if (mode === 'moved') elsewhere.focus();
    if (mode === 'session' || mode === 'account') {
      cache.setQueryData(['session'], { ...session, ...(mode === 'account' ? { subject: 'foreign' } : { csrfToken: 'replacement' }) });
      await flush();
    }
    await act(async () => finish(page('ready', true)));
    expect(document.activeElement).not.toBe(host.querySelector('article'));
    if (mode === 'moved') expect(document.activeElement).toBe(elsewhere);
    if (mode === 'session' || mode === 'account') expect(host.textContent).not.toContain('Reviewed.');
    await act(async () => root!.unmount());
    root = undefined;
    cache.clear();
    host.remove();
    elsewhere.remove();
  }
});

test('an uncertain selected resolution fences refresh and retries its original command', async () => {
  let refreshes = 0;
  await mount(
    page('ready'),
    async () => {
      throw new Error('No read may recover a command');
    },
    async () => {
      refreshes++;
    },
  );
  const textarea = host.querySelector('textarea')!;
  const { createRequire } = await import('node:module');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: browser.document });
  await act(async () => {
    await user.type(textarea, '  Review this.  ');
  });
  await click(button(m.moderation_appeal_uphold_action()));
  expect(sent).toHaveLength(1);
  expect(button(m.moderation_queue_refresh()).disabled).toBe(true);
  await click(button(m.moderation_queue_refresh()));
  expect(refreshes).toBe(0);
  await click(button(m.moderation_appeal_intent_retry()));
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);
  expect(sent[0]).toMatchObject({ id: selected.id, statement: 'Review this.', outcome: 'uphold' });
});


test('mounted exact retry receives the installed composed operation outside the retained page', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readWorkbenchPage } = await import('../src/moderation/workbench-queue/read');
  const source = { partition: 0, epoch: 1, position: '12' };
  const requests: string[] = [];
  const client = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
    requests.push(new Request(input, init).url);
    if (requests.length < 3) return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    return Response.json({ appeals: [], next: 'sparse-next', provenance: { actorId: session.subject, session: { clientId: 'web', authnEpoch: 1 }, source },
      selectedAppeal: { ...selected, source, resolution: { outcome: 'upheld', statement: 'Native retained outcome.', resolvedAt: selected.createdAt },
        resolutionCommand: { operationId: 'moderation_appeal.resolve', method: 'POST', path: '/v1/moderation-appeals/appeal:resolve' } } },
      { headers: { 'rezics-session-token': 'opaque-native' } });
  } });
  const credential = `Bearer ${btoa('{}')}.${btoa(JSON.stringify({ sub: session.subject, client_id: 'web', authn_epoch: 1 }))}.signature`;
  const read = (input: typeof search) => readWorkbenchPage(client, input, credential, origin);
  await mount(await read(search), read);
  await click(button(m.moderation_queue_retry()));
  expect(document.activeElement).toBe(button(m.moderation_queue_retry()));
  await click(button(m.moderation_queue_retry()));
  expect(host.textContent).toContain('Native retained outcome.');
  expect(host.textContent).not.toContain('opaque-native');
  expect(document.activeElement).toBe(host.querySelector('article'));
  expect(requests).toHaveLength(3);
  expect(new Set(requests).size).toBe(1);
  expect(new URL(requests[0]!).searchParams.get('inspect')).toBe('appeal');
  expect(new URL(requests[0]!).searchParams.get('cursor')).toBe('captured');
});
