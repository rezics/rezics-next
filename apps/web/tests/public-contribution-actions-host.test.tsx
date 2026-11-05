import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { act, createElement, useState, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { dirname } from 'node:path';

mock.module('cloudflare:workers', () => ({ env: {} }));

type MockPostActionsProps = {
  target: { kind: string; id: string };
  revisionId?: string;
  canonicalHref?: string;
  canStartReport?: boolean;
  commandLease?: object;
};
const reportActionMounts: MockPostActionsProps[] = [];
mock.module('../src/report/content-actions', () => ({
  PostActions: (props: MockPostActionsProps) => {
    reportActionMounts.push(props);
    return createElement('div', {
      'data-slot': 'mock-post-actions',
      'data-target-kind': props.target.kind,
      'data-target-id': props.target.id,
      'data-revision-id': props.revisionId,
      'data-report-allowed': String(props.canStartReport),
    });
  },
}));

type MockReplyCommand = {
  title: string;
  body: unknown;
  mediaIds: string[];
  idempotencyKey: string;
  parentId?: string;
  submissionContext?: unknown;
};
type MockWriteResult = { ok: true; value: unknown } | { ok: false; reason: string };
type MockComposerProps = {
  initialKey: string;
  localDraft: boolean;
  canSubmit: boolean;
  containerId?: string;
  boardId?: string;
  replyTargetId?: string | null;
  submissionContext?: unknown;
  onSubmit: (command: MockReplyCommand) => Promise<MockWriteResult>;
  onSuccess: (value: unknown) => void;
  onIntentLockChange: (locked: boolean) => void;
};
const mountedComposerProps: MockComposerProps[] = [];
const replyWrites: { data: Record<string, unknown>; headers: Headers; fetch: typeof fetch }[] = [];
const replyDraftBodies: unknown[] = [];
let submitMockReply: (() => Promise<void>) | undefined;
let replyResult: unknown = { ok: true, post: { id: 'created-reply' } };
mock.module('../src/threads/composer', () => ({
  draftFetch: (body: unknown) => {
    replyDraftBodies.push(body);
    return globalThis.fetch;
  },
  PostComposer: (props: MockComposerProps) => {
    mountedComposerProps.push(props);
    const command = {
      title: '',
      body: { profile: 'blocks', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Private reply' }] }] },
      mediaIds: [],
      idempotencyKey: '00000000-0000-4000-8000-000000000099',
      parentId: props.replyTargetId ?? undefined,
      submissionContext: props.submissionContext,
    };
    return createElement(
      'div',
      { 'data-slot': 'mock-reply-composer' },
      createElement(
        'button',
        {
          type: 'button',
          'data-slot': 'send-mock-reply',
          onClick: () => {
            submitMockReply = async () => {
              const result = await props.onSubmit(command);
              if (result.ok) props.onSuccess(result.value);
            };
          },
        },
        'Send reply',
      ),
      createElement(
        'button',
        { type: 'button', 'data-slot': 'lock-mock-reply', onClick: () => props.onIntentLockChange(true) },
        'Retain uncertain reply',
      ),
    );
  },
}));
mock.module('../src/threads/actions', () => ({
  replyToThread: async (request: { data: Record<string, unknown>; headers: HeadersInit; fetch: typeof fetch }) => {
    replyWrites.push({ ...request, headers: new Headers(request.headers) });
    return replyResult;
  },
}));

const { AccountPosts } = await import('../src/features/pages/account');
const { OverviewContext } = await import('../src/features/pages/overview');
const {
  observeContributionActionsRows,
  ContributionActionsHost,
  useContributionActionsHost,
  sameContributionActionsEpisode,
  ContributionActionsPageScope,
} = await import('../src/accounts/public-profile/contribution-actions/host');
type ContributionActionsEpisode =
  import('../src/accounts/public-profile/contribution-actions/host').ContributionActionsEpisode;
const { sessionQuery } = await import('../src/session/query');
const { unavailableAuthorContributionActionsWire } =
  await import('../src/accounts/public-profile/contribution-actions/receiver');
const { rememberContribution, restoreContributionRecovery, contributionReturnOccurrence } =
  await import('../src/accounts/public-profile/contributions/navigation');
const { ContributionAdvicePresentation, ContributionWatch } =
  await import('../src/accounts/public-profile/contribution-actions/presentation');
const { ContributionReaction } = await import('../src/accounts/public-profile/contribution-actions/reaction');
const { ContributionReport } = await import('../src/accounts/public-profile/contribution-actions/report');
const { ContributionReply, contributionReplyTarget } = await import(
  '../src/accounts/public-profile/contribution-actions/reply'
);
const { m } = await import('../src/paraglide/messages.js');
const { originalContributionReference, contributionCommandTarget, contributionOperationAdvice } =
  await import('../src/accounts/public-profile/contribution-actions/advice');
type NativeAdvice = import('../src/accounts/public-profile/contribution-actions/advice').NativeContributionAdvice;

const id = '00000000-0000-4000-8000-000000000001';

test('private advice requires the exact native action, operation, revision and reader', () => {
  const reference = { type: 'content.thread' as const, id, placeId: id, sourceRevisionId: id };
  const operation = { action: 'reaction:set', operationId: 'reaction.set', state: 'available' as const };
  const nativeReference = {
    type: 'content.thread' as const,
    id,
    sourceRevisionId: id,
    state: 'current' as const,
    operations: [operation],
  };
  const source: NativeAdvice = {
    viewer: { kind: 'account', id },
    currentness: { actions: 'current' },
    actions: { state: 'current', retryable: false, references: [nativeReference] },
  };
  const request = {
    reference,
    operation: 'reaction' as const,
    action: operation.action,
    operationId: operation.operationId,
    source,
    reader: id,
    isCurrent: () => true,
  };
  const withReferences = (references: NativeAdvice['actions']['references']): NativeAdvice => ({
    ...source,
    actions: { ...source.actions, references },
  });
  expect(contributionOperationAdvice(request)).toBe('available');
  for (const state of ['denied', 'sign_in_required', 'withheld', 'unavailable', 'not_applicable'] as const) {
    const next = { ...nativeReference, operations: [{ ...operation, state }] };
    expect(contributionOperationAdvice({ ...request, source: withReferences([next]) })).toBe(state);
  }
  for (const replacement of [{ action: 'other' }, { operationId: 'other' }, { source: undefined }])
    expect(contributionOperationAdvice({ ...request, ...replacement })).toBe('missing');
  expect(contributionOperationAdvice({ ...request, reader: 'replacement' })).toBe('unavailable');
  expect(contributionOperationAdvice({ ...request, isCurrent: () => false, failed: true })).toBe('retired');
  expect(contributionOperationAdvice({ ...request, failed: true })).toBe('failed');
  for (const references of [
    [{ ...nativeReference, sourceRevisionId: 'replacement' }],
    [{ ...nativeReference, operations: [operation, operation] }],
    [nativeReference, nativeReference],
  ])
    expect(contributionOperationAdvice({ ...request, source: withReferences(references) })).toBe('unavailable');
  const stale: NativeAdvice = { ...source, currentness: { actions: 'unavailable' } };
  expect(contributionOperationAdvice({ ...request, source: stale })).toBe('unavailable');
  const withheld = withReferences([{ ...nativeReference, state: 'withheld' }]);
  expect(contributionOperationAdvice({ ...request, source: withheld })).toBe('withheld');
});

test('only surviving original Discussion, Review and Post occurrences select advice; Post watch keeps its thread', () => {
  const publicState = { availability: 'available', visibility: 'published' };
  const firstPost = { ...publicState, threadId: id, revisionId: id };
  const thread = { ...publicState, id, boardId: id, authorId: id, firstPost, kind: 'discussion' };
  const threadReference = { type: 'content.thread' as const, id, placeId: id, sourceRevisionId: id };
  const input = {
    accountId: id,
    cursor: 'original+/=',
    proof: 'native-proof',
    view: 'discussion' as const,
    references: [threadReference],
  };
  expect(originalContributionReference(input, thread)).toBe(threadReference);
  expect(originalContributionReference({ ...input, view: 'reviews' }, { ...thread, kind: 'review' })).toBe(
    threadReference,
  );
  for (const replacement of [
    { ...thread, authorId: 'another-author' },
    { ...thread, visibility: 'hidden' },
    { ...thread, firstPost: { ...firstPost, revisionId: 'replacement-revision' } },
  ])
    expect(originalContributionReference(input, replacement)).toBeUndefined();
  const postId = '00000000-0000-4000-8000-000000000002';
  const postRevision = '00000000-0000-4000-8000-000000000003';
  const postReference = {
    ...threadReference,
    id: postId,
    sourceRevisionId: postRevision,
    type: 'content.post' as const,
    threadId: id,
    threadRevisionId: id,
  };
  const postInput = { ...input, view: 'posts' as const, references: [postReference] };
  const post = { ...publicState, id: postId, authorId: id, threadId: id, revisionId: postRevision, thread };
  expect(originalContributionReference(postInput, post)).toBe(postReference);
  expect(
    originalContributionReference(postInput, { ...post, thread: { ...thread, boardId: 'replacement-board' } }),
  ).toBeUndefined();
  expect(contributionCommandTarget(postReference, 'watch')).toEqual({ type: 'content.thread', id, revisionId: id });
  for (const operation of ['reaction', 'report'] as const)
    expect(contributionCommandTarget(postReference, operation)).toEqual({
      type: 'content.post',
      id: postId,
      revisionId: postRevision,
    });
  expect(contributionCommandTarget(postReference, 'reply')).toEqual({ type: 'content.thread', id, revisionId: id });
});

function episode(client: QueryClient, row: Record<string, unknown>): ContributionActionsEpisode {
  return {
    client,
    accountId: id,
    view: 'posts',
    cursor: 'signed+/=cursor',
    locale: 'en',
    page: {},
    read: {},
    source: {},
    selection: { proof: 'native-proof', references: [] },
    publication: {},
    postsPublished: true,
    reviewsPublished: true,
    reader: { state: 'signed-in', observation: { subject: id, id: 3 } },
    credential: 'csrf-a',
    navigation: {},
    mount: {},
    wire: unavailableAuthorContributionActionsWire,
    rows: observeContributionActionsRows([row]),
  };
}

test('the one page host retires on page, read, source, author, credential and immediate row-context replacement', () => {
  const client = new QueryClient();
  const parent = {};
  const row = { id: 'rendered-row-only', threadId: id, parentContext: parent };
  const current = episode(client, row);
  expect(sameContributionActionsEpisode(current, { ...current, rows: observeContributionActionsRows([row]) })).toBe(
    true,
  );
  for (const replacement of [
    { page: {} },
    { read: {} },
    { source: {} },
    { selection: { proof: 'same-value-new-source', references: [] } },
    { publication: {} },
    { cursor: 'replacement-cursor' },
    { locale: 'zh-Hant' },
    { reader: { state: 'signed-in' as const, observation: { subject: id, id: 4 } } },
    { credential: 'csrf-b' },
    { navigation: {} },
    { mount: {} },
    { accountId: 'another-account' },
    { client: new QueryClient() },
    { rows: [] },
    { rows: observeContributionActionsRows([{ ...row, parentContext: {} }]) },
  ]) {
    expect(sameContributionActionsEpisode(current, { ...current, ...replacement })).toBe(false);
  }
});

test('an admitted posts page mounts one bounded host and never derives a selection from its rendered rows', async () => {
  const client = new QueryClient();
  const page = {
    account: { id, handle: 'reader' },
    reads: { account: { status: 200, body: { accounts: [{ id, state: 'active' }] } } },
  } as never;
  const profile = {
    id,
    kind: 'actor',
    handle: 'reader',
    displayName: null,
    bio: null,
    links: [],
    avatar: null,
    subject: null,
    verified: false,
    automated: false,
    operatorId: null,
    publicViews: { posts: true, reviews: true, collections: true, realms: false },
  };
  const value = {
    locale: 'en',
    account: { id, handle: 'reader' },
    profile,
    sections: new Map([
      [
        'posts',
        {
          ok: true,
          read: { kind: 'accountPosts', id, limit: 20 },
          body: {
            posts: [
              {
                id: '00000000-0000-4000-8000-000000000099',
                kind: 'reply',
                threadId: id,
                thread: { id, title: 'Original public thread' },
                authorId: 'another-author',
                parentId: null,
              },
            ],
            next: 'native-next-cursor',
          },
        },
      ],
    ]),
  } as never;
  const route = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <OverviewContext.Provider value={value}>
          <ContributionActionsPageScope page={page} cursor="original+/=cursor" view="posts">
            <AccountPosts id="posts" paged limit={20} />
          </ContributionActionsPageScope>
        </OverviewContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToString(<RouterProvider router={router} />);
  expect((html.match(/data-slot="contribution-actions-host"/g) ?? []).length).toBe(1);
  expect(html).toContain('data-action-state="unavailable"');
  expect(html).toContain('data-slot="account-posts-items"');
  expect(html).toContain('Original public thread');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('native-proof');
  client.clear();
});

async function installDom() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/accounts/author/posts?cursor=original%2B%2F%3D#reply' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return {
    window,
    async close() {
      await window.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('mounted host shares reader retirement and reacquires only the current original page', async () => {
  const dom = await installDom();
  const { window } = dom;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { state: 'signed-in', subject: 'viewer-a', csrfToken: 'original-credential' };
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
  type Input = import('../src/accounts/public-profile/contribution-actions/receiver').ContributionActionsInput;
  type Value = import('../src/accounts/public-profile/contribution-actions/host').ContributionActionsHostValue;
  const flights: { input: Input; signal: AbortSignal; resolve(value: unknown): void; reject(error: unknown): void }[] =
    [];
  const wire = {
    read: (input: Input, signal: AbortSignal) =>
      new Promise((resolve, reject) => flights.push({ input, signal, resolve, reject })),
  };
  const selection = {
    proof: 'original-native-selection',
    references: [
      { type: 'content.post', id, threadId: id, placeId: id, sourceRevisionId: null, threadRevisionId: null },
    ],
  };
  const initial = {
    accountId: id,
    view: 'posts' as const,
    cursor: 'original+/=',
    locale: 'en',
    page: {},
    read: {},
    source: { actionSelection: selection },
    selection,
    publication: {},
    postsPublished: true,
    reviewsPublished: true,
    rows: [{ id: 'browser-row-only' }],
  };
  let latest: Value | null = null;
  let update: (value: typeof initial) => void = () => {};
  function Probe() {
    latest = useContributionActionsHost();
    return null;
  }
  function Harness() {
    const [scope, setScope] = useState(initial);
    update = setScope;
    return (
      <QueryClientProvider client={client}>
        <ContributionActionsHost {...scope} wire={wire}>
          <Probe />
          <a href="/en/threads/original?post=original">Public contribution</a>
        </ContributionActionsHost>
      </QueryClientProvider>
    );
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Harness }),
    history: createMemoryHistory({ initialEntries: ['/en/accounts/author/posts?cursor=original%2B%2F%3D'] }),
  });
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const flush = async (action: () => void = () => {}) => {
    await act(async () => {
      action();
      await Promise.resolve();
    });
  };
  const current = () => {
    expect(latest).not.toBeNull();
    return latest!;
  };
  try {
    const region = document.createElement('section');
    region.dataset.slot = 'account-posts';
    const recovery = document.createElement('p');
    recovery.hidden = true;
    recovery.tabIndex = -1;
    region.append(recovery);
    document.body.append(region);
    rememberContribution('removed-row', '/en/threads/original?post=original', window);
    restoreContributionRecovery(recovery, window);
    expect(recovery.hidden).toBe(false);
    expect(document.activeElement).toBe(recovery);
    const survivingRow = document.createElement('li');
    const contribution = document.createElement('div');
    contribution.dataset.profileContributionId = 'removed-row';
    const destination = document.createElement('a');
    destination.setAttribute('href', '/en/threads/original?post=original');
    survivingRow.append(contribution, destination);
    region.append(survivingRow);
    restoreContributionRecovery(recovery, window);
    expect(recovery.hidden).toBe(true);
    expect(document.activeElement).toBe(destination);
    const originalAddress = window.location.href;
    const occurrence = contributionReturnOccurrence({ id: 'removed-row', revisionId: id });
    contribution.dataset.profileContributionOccurrence = occurrence;
    for (const href of [
      '/en/threads/original',
      '/en/threads/original?post=original',
      '/en/threads/original?post=parent',
    ]) {
      destination.setAttribute('href', href);
      rememberContribution('removed-row', href, window, occurrence);
      destination.blur();
      restoreContributionRecovery(recovery, window);
      expect(document.activeElement).toBe(destination);
      expect(window.location.href).toBe(originalAddress);
    }
    // An equal row ID and destination URL cannot lend focus to a replacement revision.
    contribution.dataset.profileContributionOccurrence = contributionReturnOccurrence({
      id: 'removed-row',
      revisionId: 'replacement',
    });
    restoreContributionRecovery(recovery, window);
    expect(recovery.hidden).toBe(false);
    expect(document.activeElement).toBe(recovery);
    contribution.dataset.profileContributionOccurrence = occurrence;
    destination.remove();
    restoreContributionRecovery(recovery, window);
    expect(recovery.hidden).toBe(false);
    expect(document.activeElement).toBe(recovery);
    region.remove();
    await router.load();
    await flush(() =>
      root.render(
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>,
      ),
    );
    expect(flights).toHaveLength(0);
    expect(node.querySelector('a[href*="sign-in"]')?.getAttribute('href')).toContain(
      'return_to=%2Fen%2Faccounts%2Fauthor%2Fposts%3Fcursor%3Doriginal%252B%252F%253D%23reply',
    );
    await flush(() => client.setQueryData(sessionQuery.queryKey, session));
    expect(flights).toHaveLength(1);
    expect(flights[0]!.input).toMatchObject({ accountId: id, cursor: 'original+/=', proof: selection.proof });
    expect(flights[0]!.input.references[0]!.id).toBe(id);
    expect(current().isCurrent()).toBe(true);
    const original = current();
    const operation = original.operation('watch')!;
    expect(operation.reader).toBe('viewer-a');
    expect(operation.credential()).toBe('original-credential');
    await flush(() => {
      void client.invalidateQueries({ queryKey: sessionQuery.queryKey, refetchType: 'none' });
      expect(flights[0]!.signal.aborted).toBe(true);
      expect(operation.current()).toBe(false);
    });
    await flush(() => flights[0]!.resolve({ opaque: 'late advice' }));
    expect(original.isCurrent()).toBe(false);
    expect(node.textContent).toContain('Public contribution');
    await flush(() => client.setQueryData(sessionQuery.queryKey, session));
    expect(flights).toHaveLength(2);
    const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true })!;
    await flush(() => query.setState({ fetchStatus: 'fetching' }));
    expect(flights[1]!.signal.aborted).toBe(true);
    await flush(() => query.setState({ fetchStatus: 'idle' }));
    const equal = current();
    await flush(() => client.setQueryData(sessionQuery.queryKey, session));
    expect(equal.isCurrent()).toBe(false);
    const beforeABA = current();
    await flush(() => {
      client.setQueryData(sessionQuery.queryKey, { ...session, subject: 'viewer-b' });
      client.setQueryData(sessionQuery.queryKey, session);
      expect(beforeABA.isCurrent()).toBe(false);
    });
    expect(operation.credential()).toBeNull();
    const oldSource = current();
    await flush(() => update({ ...initial, source: { actionSelection: selection }, rows: [] }));
    expect(oldSource.isCurrent()).toBe(false);
    expect(current().input?.cursor).toBe(initial.cursor);
    const beforeReturn = current();
    await flush(() => {
      window.dispatchEvent(new window.Event('pagehide'));
      window.dispatchEvent(new window.Event('pageshow'));
    });
    expect(beforeReturn.isCurrent()).toBe(false);
    const mounted = current();
    await flush(() => root.render(null));
    expect(mounted.isCurrent()).toBe(false);
    expect(flights.every((flight) => flight.signal.aborted)).toBe(true);
    await flush(() => root.render(<RouterProvider router={router} />));
    expect(current().isCurrent()).toBe(true);
    const flight = flights.at(-1)!;
    await flush(() => flight.reject(new Error('private read failed')));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('Private actions are unavailable');
    await flush(() => node.querySelector('button')!.click());
    expect(flights.at(-1)!.input).toEqual(flight.input);
    await flush(() => flights.at(-1)!.resolve({ opaque: 'current advice' }));
    expect(current().state.state).toBe('ready');
    expect(mounted.isCurrent()).toBe(false);
  } finally {
    await flush(() => root.unmount());
    client.clear();
    node.remove();
    await dom.close();
  }
});

test('prepared current advice keeps native watch custody through uncertain readback and deliberate retry', async () => {
  const dom = await installDom();
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id, csrfToken: 'original-credential' });
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  const publicState = { availability: 'available', visibility: 'published' };
  const firstPost = { ...publicState, threadId: id, revisionId: id };
  const row = { ...publicState, id, authorId: id, boardId: id, firstPost, kind: 'discussion' };
  const input = {
    accountId: id,
    view: 'discussion' as const,
    cursor: 'original+/=',
    proof: 'native-proof',
    references: [{ type: 'content.thread' as const, id, placeId: id, sourceRevisionId: id }],
  };
  const source: NativeAdvice = {
    viewer: { kind: 'account', id },
    currentness: { actions: 'current' },
    actions: {
      state: 'current',
      retryable: false,
      references: [
        {
          type: 'content.thread',
          id,
          sourceRevisionId: id,
          state: 'current',
          operations: [{ action: 'thread:watch', operationId: 'thread.watch', state: 'available' }],
        },
      ],
    },
  };
  type Command = import('../src/threads/thread-watch-native').ThreadWatchCommand;
  const commands: Command[] = [];
  const native = {
    async read() {
      return { kind: 'confirmed' as const, state: { watching: true } };
    },
    async set(command: Command) {
      commands.push(command);
      return { kind: commands.length === 1 ? ('unknown' as const) : ('confirmed' as const) };
    },
  };
  const scope = {
    input,
    row,
    source,
    reader: id,
    locale: 'en' as const,
    isCurrent: () => true,
    operation: () => ({
      reader: id,
      operation: 'watch' as const,
      current: () => true,
      credential: () => 'original-credential',
    }),
  };
  const render = async (children: ReactNode) =>
    act(async () => {
      root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
    });
  const click = async (label: string) =>
    act(async () => {
      const button = [...node.querySelectorAll('button')].find((item) => item.textContent === label);
      expect(button).toBeDefined();
      button!.click();
    });
  try {
    await render(
      <ContributionWatch
        presentation={scope}
        watching={false}
        returnTo="/en/accounts/author/discussion"
        native={native}
      />,
    );
    await click('Watch');
    expect(commands[0]).toMatchObject({ threadId: id, viewerId: id, csrfToken: 'original-credential', watching: true });
    await click('Check watch status');
    expect(node.textContent).toContain('Retry the same action');
    expect(commands).toHaveLength(1);
    await click('Retry the same action');
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    expect(node.textContent).not.toContain('Stop watching');
    for (const state of [
      'denied',
      'missing',
      'withheld',
      'sign_in_required',
      'not_applicable',
      'unavailable',
      'retired',
      'failed',
    ] as const) {
      await render(
        <ContributionAdvicePresentation state={state} label="Watch" locale="en">
          <button>Native command</button>
        </ContributionAdvicePresentation>,
      );
      expect(node.querySelector('[data-advice-state]')?.getAttribute('data-advice-state')).toBe(state);
      expect(node.querySelector('button')).toBeNull();
      expect(node.querySelector(state === 'failed' ? '[role="alert"]' : '[role="status"]')?.textContent).toBeTruthy();
    }
    const denied: NativeAdvice = {
      ...source,
      actions: {
        ...source.actions,
        references: [
          {
            ...source.actions.references[0]!,
            operations: [{ action: 'thread:watch', operationId: 'thread.watch', state: 'denied' }],
          },
        ],
      },
    };
    await render(
      <ContributionWatch
        presentation={{ ...scope, source: denied }}
        watching={false}
        returnTo="/en/accounts/author/discussion"
        native={native}
      />,
    );
    expect(node.textContent).toContain('This action is currently not allowed.');
    expect(node.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    node.remove();
    await dom.close();
  }
});

test.each(['discussion', 'reviews', 'posts'] as const)(
  'prepared %s reactions retain the native uncertain command through readback and retry',
  async (view) => {
    const dom = await installDom();
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id, csrfToken: 'original-credential' });
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    const kind = view === 'posts' ? 'post' : 'thread';
    const publicState = { availability: 'available', visibility: 'published' };
    const firstPost = { ...publicState, threadId: id, revisionId: id };
    const thread = {
      ...publicState,
      id,
      authorId: id,
      boardId: id,
      firstPost,
      kind: view === 'reviews' ? 'review' : 'discussion',
    };
    const reference = {
      type: `content.${kind}` as const,
      id,
      placeId: id,
      sourceRevisionId: id,
      threadId: id,
      threadRevisionId: id,
    };
    const input = { accountId: id, view, cursor: 'original+/=', proof: 'native-proof', references: [reference] };
    const operations = ['set', 'clear'].map((operation) => ({
      action: 'reaction:set',
      operationId: `${kind}.${operation}_reaction`,
      state: 'available' as const,
    }));
    const source: NativeAdvice = {
      viewer: { kind: 'account', id },
      currentness: { actions: 'current' },
      actions: {
        state: 'current',
        retryable: false,
        references: [{ type: reference.type, id, sourceRevisionId: id, state: 'current', operations }],
      },
    };
    const scope = {
      input,
      row: view === 'posts' ? { ...publicState, id, authorId: id, revisionId: id, threadId: id, thread } : thread,
      source,
      reader: id,
      locale: 'en' as const,
      isCurrent: () => true,
      operation: () => ({
        reader: id,
        operation: 'reaction' as const,
        current: () => true,
        credential: () => 'original-credential',
      }),
    };
    type Transport = NonNullable<import('../src/threads/thread-reactions').ThreadReactionsProps['preparedTransport']>;
    const commands: Parameters<Transport['change']>[0][] = [];
    let reads = 0;
    const transport: Transport = {
      async change(command) {
        commands.push(command);
        return commands.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true };
      },
      async read() {
        reads++;
        return { ok: true, value: 'like', counts: { like: 2 } };
      },
    };
    const paint = async (advice = source, count = 1) =>
      act(async () => {
        root.render(
          <QueryClientProvider client={client}>
            <ContributionReaction
              presentation={{ ...scope, source: advice }}
              counts={{ like: count }}
              value={null}
              returnTo="/en/accounts/author/posts?cursor=original%2B%2F%3D#reply"
              preparedTransport={transport}
            />
          </QueryClientProvider>,
        );
      });
    try {
      for (const replacement of [
        [{ ...operations[0]!, state: 'denied' as const }, operations[1]!],
        [operations[0]!],
        operations.map((operation) => ({ ...operation, operationId: 'reaction.set' })),
      ]) {
        await paint({
          ...source,
          actions: { ...source.actions, references: [{ ...source.actions.references[0]!, operations: replacement }] },
        });
        expect(node.querySelector('button')).toBeNull();
      }
      await paint();
      expect(commands).toHaveLength(0);
      await act(async () => node.querySelector<HTMLButtonElement>('[data-slot="reaction-chip"]')!.click());
      expect(commands).toHaveLength(1);
      expect(commands[0]!.data).toEqual({ target: kind, id, kind: 'like', expectedReader: id });
      expect(new Headers(commands[0]!.headers).get('X-CSRF-Token')).toBe('original-credential');
      // New read advice and totals do not acknowledge the lost command or start another write/read.
      await paint({ ...source }, 2);
      expect(reads).toBe(0);
      expect(commands).toHaveLength(1);
      const retry = [...node.querySelectorAll('button')].find((button) => button.textContent === m.editorial_retry());
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(commands).toHaveLength(2);
      expect(commands[1]!.data).toEqual(commands[0]!.data);
      expect(new Headers(commands[1]!.headers).get('Idempotency-Key')).toBe(
        new Headers(commands[0]!.headers).get('Idempotency-Key'),
      );
      expect(reads).toBe(1);
      expect(node.querySelector('[role="status"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      client.clear();
      node.remove();
      await dom.close();
    }
  },
);

test('prepared report keeps the selected post target and uncertain owner while current advice changes', async () => {
  const dom = await installDom();
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  reportActionMounts.length = 0;
  const threadId = id;
  const postId = '00000000-0000-4000-8000-000000000002';
  const openingRevision = '00000000-0000-4000-8000-000000000003';
  const postRevision = '00000000-0000-4000-8000-000000000004';
  const boardId = '00000000-0000-4000-8000-000000000005';
  const openingPostId = '00000000-0000-4000-8000-000000000006';
  const publicState = { availability: 'available', visibility: 'published' };
  const input = {
    accountId: id,
    view: 'posts' as const,
    cursor: 'original+/=',
    proof: 'native-proof',
    references: [
      {
        type: 'content.post' as const,
        id: postId,
        threadId,
        placeId: boardId,
        threadRevisionId: openingRevision,
        sourceRevisionId: postRevision,
      },
    ],
  };
  const row = {
    ...publicState,
    id: postId,
    authorId: id,
    threadId,
    revisionId: postRevision,
    thread: {
      ...publicState,
      id: threadId,
      boardId,
      firstPost: { ...publicState, id: openingPostId, threadId, revisionId: openingRevision },
    },
  };
  const lease = {
    reader: id,
    operation: 'report' as const,
    current: () => true,
    credential: () => 'original-credential',
  };
  const reportSource = (state: 'available' | 'denied'): NativeAdvice => ({
    viewer: { kind: 'account', id },
    currentness: { actions: 'current' },
    actions: {
      state: 'current',
      retryable: false,
      references: [
        {
          type: 'content.post',
          id: postId,
          sourceRevisionId: postRevision,
          state: 'current',
          operations: [{ action: 'report:create', operationId: 'report.create', state }],
        },
      ],
    },
  });
  const scope = {
    input,
    row,
    reader: id,
    locale: 'en' as const,
    isCurrent: () => true,
    operation: () => lease,
  };
  const canonicalHref = '/en/threads/original?post=original-post';
  const paint = async (source: NativeAdvice, proof = input.proof, currentLease = lease) =>
    act(async () =>
      root.render(
        <ContributionReport
          presentation={{ ...scope, input: { ...input, proof }, source, operation: () => currentLease }}
          canonicalHref={canonicalHref}
          verification={{ sitekey: '', scriptUrl: '' }}
        />,
      ),
    );
  try {
    await paint(reportSource('denied'));
    expect(node.querySelector('[data-slot="mock-post-actions"]')).toBeNull();
    await paint(reportSource('available'));
    expect(node.querySelector('[data-slot="mock-post-actions"]')?.getAttribute('data-target-kind')).toBe('post');
    expect(node.querySelector('[data-slot="mock-post-actions"]')?.getAttribute('data-target-id')).toBe(postId);
    expect(node.querySelector('[data-slot="mock-post-actions"]')?.getAttribute('data-revision-id')).toBe(postRevision);
    expect(node.querySelector('[data-slot="mock-post-actions"]')?.getAttribute('data-report-allowed')).toBe('true');
    expect(reportActionMounts.at(-1)?.canonicalHref).toBe(canonicalHref);
    expect(reportActionMounts.at(-1)?.commandLease).toBe(lease);
    await paint(reportSource('denied'));
    expect(node.querySelector('[data-slot="mock-post-actions"]')?.getAttribute('data-report-allowed')).toBe('false');
    const newLease = { ...lease };
    await paint(reportSource('denied'), 'replacement-proof', newLease);
    expect(node.querySelector('[data-slot="mock-post-actions"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    node.remove();
    await dom.close();
  }
});

test.each(['discussion', 'reviews', 'posts'] as const)(
  'prepared %s reply uses the selected thread, immediate parent and original credential', async (view) => {
    const dom = await installDom();
    const node = document.createElement('div');
    document.body.append(node);
    const root = createRoot(node);
    mountedComposerProps.length = 0;
    replyWrites.length = 0;
    replyDraftBodies.length = 0;
    submitMockReply = undefined;
    replyResult = { ok: true, post: { id: 'created-reply' } };
    const threadId = id;
    const boardId = '00000000-0000-4000-8000-000000000005';
    const openingPostId = '00000000-0000-4000-8000-000000000006';
    const openingRevision = '00000000-0000-4000-8000-000000000003';
    const postId = '00000000-0000-4000-8000-000000000002';
    const postRevision = '00000000-0000-4000-8000-000000000004';
    const publicState = { availability: 'available', visibility: 'published' };
    const thread = {
      ...publicState,
      id: threadId,
      authorId: id,
      boardId,
      kind: view === 'reviews' ? 'review' : 'discussion',
      firstPost: { ...publicState, id: openingPostId, threadId, revisionId: openingRevision },
    };
    const reference =
      view === 'posts'
        ? {
            type: 'content.post' as const,
            id: postId,
            threadId,
            placeId: boardId,
            threadRevisionId: openingRevision,
            sourceRevisionId: postRevision,
          }
        : { type: 'content.thread' as const, id: threadId, placeId: boardId, sourceRevisionId: openingRevision };
    const input = {
      accountId: id,
      view,
      cursor: 'original+/=',
      proof: 'native-proof',
      references: [reference],
    };
    const row =
      view === 'posts'
        ? { ...publicState, id: postId, authorId: id, threadId, revisionId: postRevision, thread }
        : thread;
    const actionReference = {
      type: 'content.thread' as const,
      id: threadId,
      sourceRevisionId: openingRevision,
      state: 'current' as const,
      operations: [
        { action: 'post:create', operationId: 'post.create', state: 'available' as const },
      ],
    };
    const source: NativeAdvice = {
      viewer: { kind: 'account', id },
      currentness: { actions: 'current' },
      actions: { state: 'current', retryable: false, references: [actionReference] },
    };
    const denied: NativeAdvice = {
      ...source,
      actions: {
        ...source.actions,
        references: [
          {
            ...actionReference,
            operations: [{ action: 'post:create', operationId: 'post.create', state: 'denied' }],
          },
        ],
      },
    };
    let activeLease = {
      reader: id,
      operation: 'reply' as const,
      current: () => true,
      credential: () => 'original-credential',
    };
    const scope = {
      input,
      row,
      reader: id,
      locale: 'en' as const,
      isCurrent: () => true,
      operation: () => activeLease,
    };
    const expectedParent = view === 'posts' ? postId : openingPostId;
    const canonicalHref = `/en/threads/${threadId}?post=${expectedParent}`;
    const paint = async (advice: NativeAdvice, proof = input.proof) =>
      act(async () =>
        root.render(
          <ContributionReply
            presentation={{ ...scope, input: { ...input, proof }, source: advice }}
            canonicalHref={canonicalHref}
          />,
        ),
      );
    try {
      expect(contributionReplyTarget(input, row)).toMatchObject({ threadId, boardId, parentId: expectedParent });
      await paint(denied);
      expect(node.querySelector('[data-slot="mock-reply-composer"]')).toBeNull();
      await paint(source);
      expect(node.querySelector('[data-slot="mock-reply-composer"]')).not.toBeNull();
      const props = mountedComposerProps.at(-1)!;
      expect(props).toMatchObject({
        localDraft: false,
        canSubmit: true,
        containerId: threadId,
        boardId,
        replyTargetId: expectedParent,
      });
      expect(JSON.stringify(props.submissionContext)).toContain(`"operationLease":`);
      expect(node.querySelector('a[href]')?.getAttribute('href')).toBe(canonicalHref);
      await act(async () => node.querySelector<HTMLButtonElement>('[data-slot="lock-mock-reply"]')!.click());
      await paint(denied);
      expect(node.querySelector('[data-slot="mock-reply-composer"]')).not.toBeNull();
      await act(async () => node.querySelector<HTMLButtonElement>('[data-slot="send-mock-reply"]')!.click());
      await act(async () => submitMockReply?.());
      expect(replyWrites).toHaveLength(1);
      expect(replyWrites[0]!.data).toMatchObject({
        threadId,
        parentId: expectedParent,
        idempotencyKey: '00000000-0000-4000-8000-000000000099',
      });
      expect(replyWrites[0]!.data.body).toEqual(replyDraftBodies[0]);
      expect(replyWrites[0]!.headers.get('X-CSRF-Token')).toBe('original-credential');
      const replacementLease = { ...activeLease };
      activeLease = replacementLease;
      await paint(denied, 'replacement-proof');
      expect(node.querySelector('[data-slot="mock-reply-composer"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      node.remove();
      await dom.close();
    }
  },
);
