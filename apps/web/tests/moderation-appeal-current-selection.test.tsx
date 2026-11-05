import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { WorkbenchRead } from '../src/moderation/workbench-queue/read';
import type { ResolutionCommand } from '../src/moderation/appeal-resolution';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/authoring-departure', () => ({
  AuthoringDepartureBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuthoringDeparture: () => ({ release() {}, requestNavigation: (proceed: () => void) => proceed() }),
}));
const sent: ResolutionCommand[] = [];
let acknowledge = false;
mock.module('../src/moderation/actions', () => ({
  actionOnReport: async () => ({ ok: true }),
  actionOnAppeal: async ({ data }: { data: ResolutionCommand }) => {
    sent.push(data);
    if (acknowledge) return { state: 'resolved', outcome: data.outcome, statement: data.statement };
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
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const sessionModule = await import('../src/session/query');
mock.module('../src/session/query', () => ({ ...sessionModule, useSession: () => session }));
const { WorkbenchPage } = await import('../src/moderation/workbench-queue/page');
const { prepareWorkbenchRead } = await import('../src/moderation/workbench-queue/read');
const { workbenchQueueWindowHistory } = await import('../src/moderation/workbench-queue/window-history');
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
let replaceSource: () => Promise<void>;
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
  const render = (source: typeof read) =>
    act(async () =>
      root!.render(
        <QueryClientProvider client={cache}>
          <WorkbenchPage page={prepared} search={search} onSearch={() => {}} read={source} onRefresh={refresh} />
        </QueryClientProvider>,
      ),
    );
  replaceSource = () => render(async () => page('unavailable'));
  await render(read);
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
  acknowledge = false;
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
  for (const mode of ['pointer', 'moved', 'session', 'account', 'source']) {
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
      await act(async () => {
        cache.setQueryData(['session'], {
          ...session,
          ...(mode === 'account' ? { subject: 'foreign' } : { csrfToken: 'replacement' }),
        });
      });
      await flush();
    }
    if (mode === 'source') await replaceSource();
    await act(async () => finish(page('ready', true)));
    expect(document.activeElement).not.toBe(host.querySelector('article'));
    if (mode === 'moved') expect(document.activeElement).toBe(elsewhere);
    if (mode === 'session' || mode === 'account' || mode === 'source')
      expect(host.textContent).not.toContain('Reviewed.');
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
  expect(button(m.moderation_appeal_uphold_action()).disabled).toBe(false);
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

test.each([false, true])('mounted exact retry receives covered cross-home selection, resolved=%s', async (resolved) => {
  const { createKernelClient } = await import('@rezics/client');
  const { readWorkbenchPage } = await import('../src/moderation/workbench-queue/read');
  const source = { partition: 3, epoch: 4, position: '70' };
  let nativeResolved = resolved;
  const requests: string[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init).url);
      return Response.json(
        {
          appeals: [],
          next: 'sparse-next',
          provenance: {
            actorId: session.subject,
            session: { clientId: 'web', authnEpoch: 1 },
            source: { partition: 0, epoch: 1, position: '12' },
            sourceObservations:
              requests.length === 1
                ? [null]
                : [
                    {
                      appealId: selected.id,
                      source: requests.length === 2 ? { ...source, epoch: source.epoch + 1 } : source,
                    },
                  ],
          },
          selectedAppeal: {
            ...selected,
            source,
            resolution: nativeResolved
              ? { outcome: 'upheld', statement: 'Native retained outcome.', resolvedAt: selected.createdAt }
              : null,
            resolutionCommand: {
              operationId: 'moderation_appeal.resolve',
              method: 'POST',
              path: '/v1/moderation-appeals/appeal:resolve',
            },
          },
        },
        { headers: { 'rezics-session-token': 'opaque-native' } },
      );
    },
  });
  const credential = `Bearer ${btoa('{}')}.${btoa(JSON.stringify({ sub: session.subject, client_id: 'web', authn_epoch: 1 }))}.signature`;
  const read = (input: typeof search) => readWorkbenchPage(client, input, credential, origin);
  await mount(await read(search), read);
  await click(button(m.moderation_queue_retry()));
  expect(document.activeElement).toBe(button(m.moderation_queue_retry()));
  await click(button(m.moderation_queue_retry()));
  expect(host.textContent).toContain(resolved ? 'Native retained outcome.' : 'Reconsider.');
  expect(host.textContent).not.toContain('opaque-native');
  expect(document.activeElement).toBe(host.querySelector('article'));
  expect(requests).toHaveLength(3);
  expect(new Set(requests).size).toBe(1);
  expect(new URL(requests[0]!).searchParams.get('inspect')).toBe('appeal');
  expect(new URL(requests[0]!).searchParams.get('cursor')).toBe('captured');
  if (resolved) return;

  const { createRequire } = await import('node:module');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: browser.document });
  await act(async () => user.type(host.querySelector('textarea')!, '  Original review.  '));
  await click(button(m.moderation_appeal_uphold_action()));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    id: selected.id,
    outcome: 'uphold',
    statement: 'Original review.',
    nativeSession: 'opaque-native',
  });
  expect(button(m.moderation_queue_refresh()).disabled).toBe(true);
  expect(requests).toHaveLength(3);
  acknowledge = true;
  await click(button(m.moderation_appeal_intent_retry()));
  expect(sent[1]).toBe(sent[0]);
  expect(host.textContent).toContain('Original review.');
  expect(button(m.moderation_queue_refresh()).disabled).toBe(false);
  expect(requests).toHaveLength(3);

  // Acknowledgement and the next source admission are separate visits.
  await act(async () => root!.unmount());
  cache.clear();
  host.remove();
  nativeResolved = true;
  await mount(await read(search), read);
  expect(host.textContent).toContain('Native retained outcome.');
  expect(host.querySelector('textarea')).toBeNull();
  expect(host.textContent).not.toContain('Original review.');
  const returnLink = [...host.querySelectorAll('a')].find(
    (link) => link.textContent === m.moderation_workbench_history_return(),
  )!;
  const address = new URL(returnLink.href, browser.location.href);
  expect(address.pathname).toContain('/moderation/workbench');
  expect(address.searchParams.get('queue')).toBe('appeals');
  expect(address.searchParams.get('board')).toBe('board');
  expect(address.searchParams.get('cursor')).toBe('captured');
  expect(address.searchParams.has('case')).toBe(false);
  expect(requests).toHaveLength(4);
  expect(new Set(requests).size).toBe(1);
});

test('mounted keyboard appeal return restores the activator only after exact queue admission', async () => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], session);
  const history = workbenchQueueWindowHistory(cache);
  const queueSearch = workbenchSearch({ queue: 'appeals', board: 'board', cursor: 'captured' });
  const selectedSearch = workbenchSearch({ ...queueSearch, case: selected.id });
  const queueRaw: WorkbenchRead = {
    ...page('ready'),
    search: queueSearch,
    readKey: workbenchReadKey(queueSearch),
    cases: [
      {
        kind: 'appeal',
        id: selected.id,
        createdAt: selected.createdAt,
        outcome: null,
        reason: null,
        evidence: null,
        statement: selected.statement,
        decisionId: selected.decisionId,
        target: { kind: 'board', id: 'board' },
      },
    ],
    selectedAppeal: null,
  };
  const selectedRaw = { ...page('ready'), search: selectedSearch, readKey: workbenchReadKey(selectedSearch) };
  host = document.createElement('main');
  document.body.append(host);
  root = createRoot(host);
  let current: { visitId: string; search: typeof queueSearch; page: WorkbenchRead } | undefined;
  let transition: Promise<void> | undefined;

  async function renderVisit(raw: WorkbenchRead, search: typeof queueSearch, visitId: string) {
    const prepared = await prepareWorkbenchRead(cache!, search, async () => raw, new AbortController().signal);
    current = { visitId, search, page: prepared };
    await act(async () =>
      root!.render(
        <QueryClientProvider client={cache!}>
          <WorkbenchPage
            key={visitId}
            page={prepared}
            search={search}
            navigation={{ visitId, isCurrent: () => true, subscribe: () => () => {} }}
            onSearch={(next) => {
              transition = move(next);
            }}
            onOpenCase={() => {
              transition = move(selectedSearch);
            }}
          />
        </QueryClientProvider>,
      ),
    );
  }

  async function move(next: typeof queueSearch) {
    const targetPage = next.case ? selectedRaw : queueRaw;
    const visitId = next.case ? 'selected' : 'returned';
    expect(
      history.navigate(
        current!.visitId,
        { pathname: '/moderation/workbench', search: { ...next } },
        current!.search,
        current!.page,
      ),
    ).toBe(true);
    await renderVisit(targetPage, next, visitId);
  }

  await renderVisit(queueRaw, queueSearch, 'queue');
  const activator = host.querySelector<HTMLAnchorElement>('[data-workbench-appeal-activator]')!;
  activator.focus();
  await act(async () => {
    activator.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, detail: 0 }));
  });
  await transition;
  expect(host.textContent).toContain('Reconsider.');
  const returnLink = [...host.querySelectorAll('a')].find(
    (link) => link.textContent === m.moderation_workbench_history_return(),
  )!;
  returnLink.focus();
  await act(async () => {
    returnLink.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, detail: 0 }));
  });
  await transition;
  expect(current.search.cursor).toBe('captured');
  expect(current.search.case).toBeUndefined();
  expect(document.activeElement).toBe(host.querySelector('[data-workbench-appeal-activator]'));
});
