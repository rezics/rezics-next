import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import { createKernelClient } from '@rezics/client';
import { fromMarkdown, fromPlainText } from '@rezics/document';
import * as start from '../.storybook/react-start';
import type { ReplyParentInput } from '../src/threads/reply-parent-read';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import thread from '../src/kernel/recorded/thread.json';
import accounts from '../src/kernel/recorded/accounts.json';

// Authored for integration; acceptance is intentionally UNRUN in the implementation attempt.
// The reading region, route Post, ReplyContext, session cache and native response projection are real.
// Only the existing server-function boundary and its deferred HTTP response are supplied here.
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
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const parentId = id(501);
const revisionId = id(502);
const viewer = (subject = id(1), csrfToken = 'original-session') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const anonymous = { state: 'signed-out' as const, subject: null, csrfToken: null };
const author = { ...accounts.accounts[0]!, displayName: 'Current parent author', handle: 'current_parent' };
const parent = {
  ...thread.thread.firstPost,
  id: parentId,
  authorId: author.id,
  revisionId,
  licence: 'CC-BY-4.0',
  body: fromMarkdown(
    'Private recovered excerpt >!concealed writing!< ![hidden image](https://image.test/private)',
    'blocks',
  ),
};
const lookups: ReplyParentInput[] = [];
const requests: (ReturnType<typeof deferred<Response>> & { request: Request })[] = [];
const native = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === '/v1/accounts') return Response.json({ accounts: [author] });
    expect(path).toBe(`/v1/posts/${parentId}`);
    const call = { ...deferred<Response>(), request };
    requests.push(call);
    return call.promise;
  },
});
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadReplyParent } = await import('../src/threads/reply-parent-read');
const originalReads = { ...(await import('../src/threads/reads')) };
mock.module('../src/threads/reads', () => ({
  ...originalReads,
  readReplyParent: ({ data }: { data: ReplyParentInput }) => {
    lookups.push(data);
    return loadReplyParent(
      native,
      new Request('https://site.test/', {
        headers: data.credentialMode === 'session' ? { authorization: 'Bearer original-reader' } : {},
      }),
      {},
      data,
    );
  },
}));
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { ThreadReading } = await import('../src/threads/thread-reading');
const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
const { ReplyContext, ReplyParentReader } = await import('../src/threads/reply-context');
const { exactRevisionHref } = await import('../src/threads/exact-revision-href');
const { getLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
type Props = ComponentProps<typeof ThreadReading>;
let reader: InstanceType<typeof ReplyParentReader> | undefined;
function CapturePost(props: ComponentProps<typeof ThreadReadingPost>) {
  if (props.post.parentId === parentId) reader = props.replyParentReader;
  return <ThreadReadingPost {...props} />;
}
function page(): ThreadReadingPage {
  const first = {
    ...thread.thread.firstPost,
    availability: 'available' as const,
    body: fromPlainText('Page-native parent text', 'blocks'),
  };
  return {
    thread: { ...thread.thread, firstPost: first } as ThreadReadingPage['thread'],
    posts: {
      posts: [
        first,
        ...[503, 504].map((n) => ({ ...first, id: id(n), parentId, body: fromPlainText('Off-page reply', 'blocks') })),
        { ...first, id: id(505), parentId: first.id, body: fromPlainText('In-page reply', 'blocks') },
      ],
      next: null,
    },
    authors: { [first.authorId]: author },
    subjects: [],
    provenanceSubjects: [],
    mentions: {},
    verification: { sitekey: '', scriptUrl: '' },
    now: first.createdAt,
  };
}
const baseline = (): Props => ({
  page: page(),
  readAuthority: {},
  readerSubject: viewer().subject,
  session: 'signed-in',
  personal: undefined,
  Post: CapturePost,
  signedOut: null,
  returnTo: '/',
  renderHeader: () => null,
  onMutation: async () => {},
  onPageRefresh: async () => undefined,
});
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let props: Props;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function render() {
  root.render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ThreadReading {...props} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
async function paint(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await act(async () => render());
}
function context(index = 0) {
  return host.querySelectorAll<HTMLElement>('[data-slot="reply-context"]')[index]!;
}
function button(label: string, index = 0) {
  const found = [...context(index).querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found).toBeDefined();
  return found!;
}
const click = (label: string, index = 0) => act(async () => button(label, index).click());
async function finish(index: number, response = Response.json({ post: parent })) {
  await act(async () => {
    requests[index]!.resolve(response);
    await tick();
  });
}
function empty(old: InstanceType<typeof ReplyParentReader>) {
  expect(old.get(parentId)).toEqual({ open: false, result: { state: 'idle' } });
  expect(context().textContent).not.toContain('Private recovered excerpt');
  expect(context().textContent).not.toContain('Current parent author');
  expect(context().querySelector(`a[href*="${revisionId}"]`)).toBeNull();
}
beforeEach(() => {
  reader = undefined;
  lookups.length = 0;
  requests.length = 0;
  props = baseline();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});
afterAll(async () => {
  mock.module('../src/threads/reads', () => originalReads);
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('The real off-page reply parent reader never starts queued transport or retains private previews after its original thread and browser session lifetime retires', async () => {
  await paint();
  expect(lookups).toEqual([]);
  await click(m.thread_reply_parent_view());
  const old = reader!;
  expect(lookups).toHaveLength(1);
  await finish(0);
  expect(context().textContent).toContain('Private recovered excerpt');
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'replacement-session'));
  });
  empty(old);
  expect(reader).not.toBe(old);
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer());
    old.activate();
    old.toggle(parentId);
    await old.load(parentId);
  });
  empty(old);
  expect(lookups).toHaveLength(1);
  await click(m.thread_reply_parent_view());
  expect(lookups).toHaveLength(2);
  await finish(1);
  expect(context().textContent).toContain('Private recovered excerpt');
});

const boundaries = [
  'csrf',
  'account',
  'away/back',
  'unknown',
  'unavailable',
  'missing-csrf',
  'removed',
  'page-preparing',
  'page-denied',
  'authority',
  'thread',
  'parent',
  'provider',
  'unmount',
] as const;
type Boundary = (typeof boundaries)[number];
const discardedClients: InstanceType<typeof QueryClient>[] = [];
function retire(boundary: Boundary) {
  if (boundary === 'csrf') client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'replacement-session'));
  if (boundary === 'account') client.setQueryData(sessionQuery.queryKey, viewer(id(2), 'other-session'));
  if (boundary === 'away/back') {
    client.setQueryData(sessionQuery.queryKey, viewer(id(2), 'other-session'));
    client.setQueryData(sessionQuery.queryKey, viewer());
  }
  if (boundary === 'unknown') client.setQueryData(sessionQuery.queryKey, { state: 'unknown', csrfToken: null });
  if (boundary === 'unavailable') client.setQueryData(sessionQuery.queryKey, { state: 'unavailable', csrfToken: null });
  if (boundary === 'missing-csrf') client.setQueryData(sessionQuery.queryKey, viewer(id(1), ''));
  if (boundary === 'removed') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
  if (boundary === 'page-preparing') props = { ...props, session: 'unknown' };
  if (boundary === 'page-denied') props = { ...props, session: 'unavailable' };
  if (boundary === 'authority') props = { ...props, readAuthority: {} };
  if (boundary === 'thread')
    props = { ...props, page: { ...props.page, thread: { ...props.page.thread, id: id(600) } } };
  if (boundary === 'parent')
    props = {
      ...props,
      page: {
        ...props.page,
        posts: { ...props.page.posts, posts: props.page.posts.posts.filter((post) => post.parentId !== parentId) },
      },
    };
  if (boundary === 'provider') {
    discardedClients.push(client);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, viewer());
  }
  // Commit page/unmount boundaries before yielding, as when navigation removes the original region.
  if (boundary === 'unmount') flushSync(() => root.render(null));
  else if (['page-preparing', 'page-denied', 'authority', 'thread', 'parent', 'provider'].includes(boundary))
    flushSync(render);
}
afterEach(() => {
  for (const discarded of discardedClients.splice(0)) discarded.clear();
});
for (const boundary of boundaries) {
  test(`${boundary} retires a queued explicit lookup before its microtask: zero transport`, async () => {
    await paint();
    const old = reader!;
    await act(async () => {
      button(m.thread_reply_parent_view()).click();
      retire(boundary);
      await tick();
    });
    expect(lookups).toEqual([]);
    expect(requests).toEqual([]);
    expect(old.get(parentId).result.state).toBe('idle');
    await act(async () => {
      old.activate();
      await old.load(parentId);
    });
    expect(lookups).toEqual([]);
  });
  test(`${boundary} drops a late native result and its private context`, async () => {
    await paint();
    await click(m.thread_reply_parent_view());
    const old = reader!;
    expect(requests).toHaveLength(1);
    await act(async () => retire(boundary));
    await finish(0);
    expect(old.get(parentId)).toEqual({ open: false, result: { state: 'idle' } });
    expect(host.textContent).not.toContain('Private recovered excerpt');
    expect(host.querySelector(`a[href*="${revisionId}"]`)).toBeNull();
    expect(lookups).toHaveLength(1);
  });
}

test('current explicit recovery shares one pending read, retains disclosure on close/reopen and supports retry', async () => {
  await paint();
  const current = reader!;
  await act(async () => {
    button(m.thread_reply_parent_view()).click();
    const pending = current.load(parentId);
    expect(current.load(parentId)).toBe(pending);
    await tick();
  });
  expect(requests).toHaveLength(1);
  expect(context(1).textContent).toContain(m.thread_reply_parent_loading());
  await click(m.thread_reply_parent_close());
  await click(m.thread_reply_parent_view(), 1);
  expect(requests).toHaveLength(1);
  await finish(0);
  expect(context().textContent).toContain('Current parent author');
  expect(context().textContent).toContain('Private recovered excerpt');
  expect(context().textContent).toContain('CC-BY-4.0');
  expect(context().querySelector('a')?.getAttribute('href')).toBe(`/${getLocale()}/@current_parent`);
  expect(
    context().querySelector(`a[href="${exactRevisionHref({ postId: parentId, revisionId }, getLocale())}"]`),
  ).not.toBeNull();
  expect(context().textContent).not.toContain('concealed writing');
  expect(context().textContent).not.toContain('hidden image');
  expect(context().innerHTML).not.toContain('https://image.test/private');
  await click(m.thread_reply_parent_close());
  await click(m.thread_reply_parent_view());
  await paint();
  expect(reader).toBe(current);
  expect(requests).toHaveLength(1);
  await act(async () => {
    void current.load(parentId);
    await tick();
  });
  await finish(1, Response.json({ code: 'forbidden' }, { status: 403 }));
  expect(context().textContent).toContain(m.thread_reply_parent_unavailable());
  expect(context().textContent).not.toContain('Private recovered excerpt');
  await click(m.exact_revision_retry());
  await finish(2);
  expect(context().textContent).toContain('Private recovered excerpt');
  expect(lookups).toHaveLength(3);
});

for (const response of [
  { post: { ...parent, availability: 'withheld' } },
  { post: { ...parent, availability: 'erased' } },
  { post: { ...parent, id: id(700) } },
  { post: { ...parent, threadId: id(701) } },
])
  test('native withholding, erasure and unrelated addresses stay generically unavailable', async () => {
    await paint();
    await click(m.thread_reply_parent_view());
    await finish(0, Response.json(response));
    expect(context().textContent).toContain(m.thread_reply_parent_unavailable());
    expect(context().textContent).not.toContain('Private recovered excerpt');
    expect(context().textContent).not.toContain('Current parent author');
  });

test('unknown browser admission never becomes anonymous; genuine anonymous recovery remains explicit', async () => {
  client.setQueryData(sessionQuery.queryKey, { state: 'unknown', csrfToken: null });
  await paint({ session: 'signed-out', readerSubject: null });
  expect(reader).toBeUndefined();
  expect(context().querySelector('button')).toBeNull();
  expect(lookups).toEqual([]);
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, anonymous);
  });
  expect(lookups).toEqual([]);
  await click(m.thread_reply_parent_view());
  expect(lookups[0]?.credentialMode).toBe('anonymous');
  expect(requests[0]?.request.headers.get('authorization')).toBeNull();
  await finish(0);
  expect(context().textContent).toContain('Private recovered excerpt');
});

test('in-page disclosed, withheld and erased parents stay page-native without recovery transport', async () => {
  await paint();
  expect(context(2).textContent).toContain('Page-native parent text');
  expect(context(2).querySelector('button')).toBeNull();
  for (const availability of ['withheld', 'erased'] as const) {
    const first = props.page.thread.firstPost;
    await paint({
      page: {
        ...props.page,
        posts: {
          ...props.page.posts,
          posts: props.page.posts.posts.map((post) =>
            post.id === first.id
              ? {
                  id: post.id,
                  threadId: post.threadId,
                  route: post.route,
                  parentId: post.parentId,
                  body: null,
                  sha256: null,
                  availability,
                  removed: true,
                }
              : post,
          ),
        },
      },
    });
    expect(context(2).textContent).not.toContain('Page-native parent text');
    expect(context(2).querySelector('button')).toBeNull();
  }
  expect(lookups).toEqual([]);
});

test('standalone prepared context keeps explicit admission and permanent disposal without a browser session', async () => {
  let reads = 0;
  const prepared = new ReplyParentReader(thread.thread.id, async () => {
    reads++;
    return {
      state: 'available',
      id: parentId,
      threadId: thread.thread.id,
      excerpt: 'Prepared excerpt',
      licence: 'MIT',
    };
  });
  await act(async () => root.render(<ReplyContext parentId={parentId} parents={new Map()} reader={prepared} />));
  expect(reads).toBe(0);
  await click(m.thread_reply_parent_view());
  expect(reads).toBe(1);
  expect(context().textContent).toContain('Prepared excerpt');
  await act(async () => {
    prepared.dispose();
    prepared.activate();
    prepared.toggle(parentId);
    await prepared.load(parentId);
  });
  expect(reads).toBe(1);
  expect(context().textContent).not.toContain('Prepared excerpt');
});

test('default standalone prepared reading uses its explicit page admission without seeding a ready session', async () => {
  function PreparedPost(post: ComponentProps<typeof ThreadReadingPost>) {
    reader = post.replyParentReader;
    return (
      <ReplyContext
        parentId={post.post.parentId}
        parents={post.replyParents}
        authors={post.authors}
        reader={post.replyParentReader}
      />
    );
  }
  const cached = client.getQueryData(sessionQuery.queryKey);
  await act(async () => root.render(<ThreadReading {...props} Post={PreparedPost} />));
  expect(lookups).toEqual([]);
  await click(m.thread_reply_parent_view());
  await finish(0);
  expect(context().textContent).toContain('Private recovered excerpt');
  expect(client.getQueryData(sessionQuery.queryKey)).toBe(cached);
});

test('losing the final context subscriber fences queued and late work before that parent is selected again', async () => {
  let reads = 0;
  const result = deferred<Awaited<ReturnType<typeof loadReplyParent>>>();
  const selected = new ReplyParentReader(thread.thread.id, () => {
    reads++;
    return result.promise;
  });
  const view = () => <ReplyContext parentId={parentId} parents={new Map()} reader={selected} />;
  await act(async () => root.render(view()));
  await act(async () => {
    button(m.thread_reply_parent_view()).click();
    flushSync(() => root.render(null));
    flushSync(() => root.render(view()));
    await tick();
  });
  expect(reads).toBe(0);
  await click(m.thread_reply_parent_view());
  expect(reads).toBe(1);
  await act(async () => {
    flushSync(() => root.render(null));
    flushSync(() => root.render(view()));
    result.resolve({
      state: 'available',
      id: parentId,
      threadId: thread.thread.id,
      excerpt: 'Retired private excerpt',
      licence: 'MIT',
    });
    await tick();
  });
  expect(selected.get(parentId)).toEqual({ open: false, result: { state: 'idle' } });
  expect(context().textContent).not.toContain('Retired private excerpt');
});

for (const boundary of ['away/back', 'unknown', 'missing-csrf', 'authority', 'provider'] as const)
  test(`${boundary} clears an already recovered private excerpt without another request`, async () => {
    await paint();
    await click(m.thread_reply_parent_view());
    await finish(0);
    const old = reader!;
    expect(context().textContent).toContain('Private recovered excerpt');
    await act(async () => retire(boundary));
    empty(old);
    expect(lookups).toHaveLength(1);
  });
