import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useLayoutEffect, useState } from 'react';
import * as start from '../.storybook/react-start';
import { subjectReadServerFixture } from './subject-read-server-fixture';
import type { ChangeReactionInput, ReactionFailure } from '../src/threads/reaction-request';
import type { SubjectOwnReaction, SubjectReactionKind } from '../src/features/pages/subject-reactions';

// UNRUN: connected mounted reader/command regressions; only the existing BFF read and command transports are gated.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/subject-one/overview' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Session = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
  csrfToken: string | null;
};
type ReadCall = {
  id: string;
  expectedReader: string;
  preparedReader: string;
  response: ReturnType<typeof deferred<SubjectOwnReaction | null>>;
};
type WriteResult = { ok: true } | ReactionFailure;
const privateReads: ReadCall[] = [];
const publicReads: string[] = [];
const writes: (ReturnType<typeof deferred<WriteResult>> & {
  data: ChangeReactionInput;
  headers: Headers;
})[] = [];
let preparedReader = 'reader-one';

const server = subjectReadServerFixture();
mock.module('@tanstack/react-start', () => ({ ...start, createServerFn: server.createServerFn }));
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: server.getRequest }));
mock.module('cloudflare:workers', () => ({ env: {} }));
const kernel = await import('../src/kernel/client');
mock.module('../src/kernel/client', () => ({ ...kernel, kernelClient: () => ({}) }));
mock.module('../src/report/content-actions', () => ({ PostActions: () => null }));
mock.module('../src/library/follow-target-control', () => ({ FollowTargetControl: () => null }));
mock.module('../src/features/pages/subject-reactions', () => ({
  readReactionCounts: async (_client: unknown, id: string) => {
    publicReads.push(id);
    return { counts: { like: 2, love: 3, laugh: 1, insightful: 4, sad: 1 }, value: null };
  },
  readOwnReaction: (
    _client: unknown,
    _request: Request,
    _sessionEnv: unknown,
    id: string,
    expectedReader?: string | null,
  ) => {
    if (!expectedReader || expectedReader !== preparedReader) return Promise.resolve(null);
    const response = deferred<SubjectOwnReaction | null>();
    privateReads.push({ id, expectedReader, preparedReader, response });
    return response.promise;
  },
}));
const reactions = await import('../src/threads/reactions');
mock.module('../src/threads/reactions', () => ({
  ...reactions,
  changeReaction: ({ data, headers }: { data: ChangeReactionInput; headers: HeadersInit }) => {
    const call = { ...deferred<WriteResult>(), data, headers: new Headers(headers) };
    writes.push(call);
    return call.promise;
  },
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, QueryObserver, useQuery, useQueryClient } =
  await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { subjectReactionsQuery } = await import('../src/features/pages/subject-queries');
const { useSubjectReactionAdmissionForZone, useSubjectReactionReader } =
  await import('../src/features/pages/subject-reaction-reader');
const { SubjectHeaderActions } = await import('../src/features/pages/subject-reactions-view');
const { m } = await import('../src/paraglide/messages.js');

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let nextClient: InstanceType<typeof QueryClient> | undefined;

const viewer = (subject = 'reader-one', csrfToken: string | null = 'csrf-one'): Session => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
const unknown: Session = { state: 'unknown', subject: null, csrfToken: null };

function currentSession(queryClient: InstanceType<typeof QueryClient>) {
  return queryClient.getQueryData<Session>(sessionQuery.queryKey) ?? unknown;
}

function SubjectOwner({
  id,
  eligible = true,
  onMutation,
}: {
  id: string;
  eligible?: boolean;
  onMutation?: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const session = currentSession(queryClient);
  const { data: counts } = useQuery(subjectReactionsQuery(id, 'en'));
  const reader = useSubjectReactionReader({
    subjectId: id,
    locale: 'en',
    view: 'overview',
    session,
    enabled: eligible,
  });
  return (
    <SubjectHeaderActions
      id={id}
      reactions={counts ? { ...counts, value: reader.ownReaction?.value ?? null } : null}
      returnTo={`/en/subjects/${id}/overview`}
      signedIn={session.state === 'signed-in'}
      personalReady={session.state !== 'signed-in' || reader.ready}
      reactionOrigin={reader.origin}
      verification={{ sitekey: '', scriptUrl: '' }}
      onPersonalChange={async (kind) => {
        reader.applyMutation(kind);
        await onMutation?.();
      }}
    />
  );
}

function SubjectReaderWitness({ id }: { id: string }) {
  const queryClient = useQueryClient();
  useSubjectReactionReader({
    subjectId: id,
    locale: 'en',
    view: 'overview',
    session: currentSession(queryClient),
  });
  return null;
}

type ZoneRead = {
  id: string;
  reader: string | null;
  key: string;
  response: ReturnType<typeof deferred<SubjectOwnReaction | null>>;
};
const zoneReads: ZoneRead[] = [];

function ZoneOwner({ id, view }: { id: string; view: string }) {
  const queryClient = useQueryClient();
  const session = currentSession(queryClient);
  const admission = useSubjectReactionAdmissionForZone({ subjectId: id, locale: 'en', view, session, enabled: true });
  const [loaded, setLoaded] = useState<{
    key: string;
    reaction: SubjectOwnReaction | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (!admission.active || view !== 'overview') return;
    const response = deferred<SubjectOwnReaction | null>();
    zoneReads.push({ id, reader: admission.reader, key: admission.key, response });
    void response.promise.then((reaction) => {
      if (admission.origin.isCurrent()) setLoaded({ key: admission.key, reaction });
    });
    return () => {};
  }, [id, view, admission.key, admission.active]);
  if (view !== 'overview') return null;
  const own =
    loaded?.key === admission.key && loaded.reaction?.reader === admission.reader && admission.origin.isCurrent()
      ? loaded.reaction
      : undefined;
  const reactions = { counts: { like: 2, love: 3, insightful: 4 }, value: own?.value ?? null };
  return (
    <SubjectHeaderActions
      id={id}
      reactions={reactions}
      returnTo={`/en/zones/one/subjects/${id}`}
      signedIn={session.state === 'signed-in'}
      personalReady={session.state !== 'signed-in' || own !== undefined}
      reactionOrigin={admission.origin}
      verification={{ sitekey: '', scriptUrl: '' }}
    />
  );
}

function tree(
  component: 'subject' | 'zone',
  props: { id: string; eligible?: boolean; view?: string; onMutation?: () => Promise<void> },
  queryClient = client,
  strict = false,
) {
  const content = (
    <QueryClientProvider client={queryClient}>
      {component === 'subject' ? (
        <SubjectOwner
          id={props.id}
          {...(props.eligible === undefined ? {} : { eligible: props.eligible })}
          {...(props.onMutation === undefined ? {} : { onMutation: props.onMutation })}
        />
      ) : (
        <ZoneOwner id={props.id} view={props.view ?? 'overview'} />
      )}
    </QueryClientProvider>
  );
  return strict ? <StrictMode>{content}</StrictMode> : content;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  await act(tick);
  while (!check() && Date.now() < deadline) await act(tick);
  expect(check()).toBe(true);
}
async function paint(
  component: 'subject' | 'zone',
  props: { id: string; eligible?: boolean; view?: string; onMutation?: () => Promise<void> },
  queryClient = client,
  strict = false,
) {
  await act(async () => {
    root.render(tree(component, props, queryClient, strict));
    await tick();
  });
}
function chips() {
  return [...host.querySelectorAll<HTMLButtonElement>('[data-slot="reaction-chip"]')];
}
function chip(kind: SubjectReactionKind) {
  const label =
    kind === 'like'
      ? m.reaction_like()
      : kind === 'love'
        ? m.reaction_love()
        : kind === 'laugh'
          ? m.reaction_laugh()
          : kind === 'insightful'
            ? m.reaction_insightful()
            : m.reaction_sad();
  const found = chips().find((button) => button.getAttribute('aria-label')?.startsWith(label));
  expect(found).toBeDefined();
  return found!;
}
async function clickKind(kind: SubjectReactionKind) {
  await act(async () => {
    if (kind === 'like' || kind === 'insightful') {
      chip(kind).click();
      await tick();
    } else {
      const trigger = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === m.reaction_react(),
      );
      expect(trigger).toBeDefined();
      trigger!.click();
      await tick();
    }
  });
  if (kind !== 'like' && kind !== 'insightful')
    await act(async () => {
      const choice = [
        ...window.document.querySelectorAll<HTMLButtonElement>('[data-slot="popover-content"] button'),
      ].find((button) =>
        button
          .getAttribute('aria-label')
          ?.startsWith(kind === 'love' ? m.reaction_love() : kind === 'laugh' ? m.reaction_laugh() : m.reaction_sad()),
      );
      expect(choice).toBeDefined();
      choice!.click();
      await tick();
    });
}
function setPrivateRead(index: number, value: SubjectReactionKind | null) {
  privateReads[index]!.response.resolve({ reader: privateReads[index]!.preparedReader, value });
}
function setZoneRead(index: number, value: SubjectReactionKind | null) {
  const entry = zoneReads[index]!;
  entry.response.resolve(entry.reader ? { reader: entry.reader, value } : null);
}
async function failSessionReadRetainingData() {
  await client
    .fetchQuery({
      ...sessionQuery,
      staleTime: 0,
      queryFn: async () => {
        throw new Error('session refresh failed');
      },
    })
    .catch(() => {});
  const entry = client.getQueryCache().find({ queryKey: sessionQuery.queryKey });
  expect(entry?.state.status).toBe('error');
  expect(entry?.state.data).toEqual(viewer());
}

beforeEach(() => {
  privateReads.length = 0;
  publicReads.length = 0;
  writes.length = 0;
  zoneReads.length = 0;
  preparedReader = 'reader-one';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  nextClient = undefined;
  root = createRoot(host);
  start.setStoryRequestContext({ visitor: 'Signed In', url: 'https://site.test/en/subjects/subject-one/overview' });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  for (const read of privateReads) read.response.resolve(null);
  for (const read of zoneReads) read.response.resolve(null);
  for (const write of writes) write.resolve({ ok: true });
  client.clear();
  nextClient?.clear();
});

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('subject own reactions and queued commands retire on retained session error and recover with a fresh same-reader response', async () => {
  await paint('subject', { id: 'subject-one' });
  await until(() => privateReads.length === 1 && publicReads.length === 1);
  setPrivateRead(0, 'love');
  await until(() => chip('love').getAttribute('aria-pressed') === 'true');

  await clickKind('like');
  await clickKind('sad');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.data).toEqual({
    target: 'subject',
    id: 'subject-one',
    kind: 'like',
    expectedReader: 'reader-one',
  });
  expect(writes[0]!.headers.get('x-csrf-token')).toBe('csrf-one');

  await act(async () => {
    await failSessionReadRetainingData();
    await tick();
  });
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(chips().every((button) => button.disabled)).toBe(true);
  expect(publicReads).toEqual(['subject-one']);
  await act(async () => {
    writes[0]!.resolve({ ok: false, reason: 'forbidden' });
    await tick();
  });
  expect(writes).toHaveLength(1);
  expect(host.querySelector('[role="status"]')).toBeNull();

  preparedReader = 'reader-one';
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer());
    await tick();
  });
  await until(() => privateReads.length === 2);
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  setPrivateRead(1, null);
  await until(() => chips().some((button) => !button.disabled));
  await clickKind('insightful');
  expect(writes).toHaveLength(2);
  expect(writes[1]!.data.expectedReader).toBe('reader-one');
});

test('ordinary admission false/true and batched A/B/A never reuse a cached or in-flight private response', async () => {
  await paint('subject', { id: 'subject-one' });
  await until(() => privateReads.length === 1);
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-two'));
    preparedReader = 'reader-one';
    client.setQueryData(sessionQuery.queryKey, viewer());
    setPrivateRead(0, 'love');
    await tick();
  });
  await until(() => privateReads.length === 2);
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  setPrivateRead(1, 'like');
  await until(() => chip('like').getAttribute('aria-pressed') === 'true');

  await paint('subject', { id: 'subject-one', eligible: false });
  expect(chips().every((button) => button.disabled)).toBe(true);
  await paint('subject', { id: 'subject-one', eligible: true });
  await until(() => privateReads.length === 3);
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  setPrivateRead(2, null);
  await until(() => chips().some((button) => !button.disabled));
  expect(publicReads).toEqual(['subject-one']);
});

test('a failed private response stays hidden until a fresh route admission returns a new response', async () => {
  await paint('subject', { id: 'subject-one' });
  await until(() => privateReads.length === 1 && publicReads.length === 1);
  privateReads[0]!.response.reject(new Error('private read failed'));
  await until(() => chips().every((button) => button.disabled));
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(chips().some((button) => button.textContent?.includes('2'))).toBe(true);

  await paint('subject', { id: 'subject-one', eligible: false });
  await paint('subject', { id: 'subject-one', eligible: true });
  await until(() => privateReads.length === 2);
  setPrivateRead(1, 'insightful');
  await until(() => chip('insightful').getAttribute('aria-pressed') === 'true');
  expect(publicReads).toEqual(['subject-one']);
});

test('sign-out and unknown cache states show public counts without the prior reader selection', async () => {
  await paint('subject', { id: 'subject-one' });
  await until(() => privateReads.length === 1);
  setPrivateRead(0, 'love');
  await until(() => chip('love').getAttribute('aria-pressed') === 'true');

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    await tick();
  });
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(chips().some((button) => button.textContent?.includes('2'))).toBe(true);
  expect(writes).toHaveLength(0);

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, unknown);
    await tick();
  });
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(chips().some((button) => button.textContent?.includes('2'))).toBe(true);
  expect(privateReads).toHaveLength(1);
});

test('a healthy reader with no CSRF token can read own reaction but cannot write', async () => {
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('reader-one', null));
    await tick();
  });
  await paint('subject', { id: 'subject-one' });
  await until(() => privateReads.length === 1 && publicReads.length === 1);
  setPrivateRead(0, 'love');
  await until(() => chip('love').getAttribute('aria-pressed') === 'true');
  expect(chips().every((button) => button.disabled)).toBe(true);
  await clickKind('like');
  expect(writes).toHaveLength(0);
});

test('removing and recreating the session retires old private data and requires a fresh response', async () => {
  await paint('subject', { id: 'subject-one' });
  await until(() => privateReads.length === 1);
  setPrivateRead(0, 'love');
  await until(() => chip('love').getAttribute('aria-pressed') === 'true');
  await clickKind('like');
  expect(writes).toHaveLength(1);

  await act(async () => {
    client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
    await tick();
  });
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  expect(chips().every((button) => button.disabled || button.getAttribute('role') === 'img')).toBe(true);
  await act(async () => {
    writes[0]!.resolve({ ok: true });
    client.setQueryData(sessionQuery.queryKey, viewer());
    await tick();
  });
  await until(() => privateReads.length === 2);
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  setPrivateRead(1, null);
  await until(() => chips().some((button) => !button.disabled));
  expect(writes).toHaveLength(1);
});

test('multiple mounted observers and StrictMode share one healthy private observation', async () => {
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <SubjectOwner id="subject-one" />
          <SubjectReaderWitness id="subject-one" />
        </QueryClientProvider>
      </StrictMode>,
    );
    await tick();
  });
  await until(() => privateReads.length === 1 && publicReads.length === 1);
  setPrivateRead(0, 'love');
  await until(() =>
    chips().some(
      (button) => button.textContent?.startsWith(m.reaction_love()) && button.getAttribute('aria-pressed') === 'true',
    ),
  );
  expect(privateReads).toHaveLength(1);
  expect(publicReads).toEqual(['subject-one']);
  await clickKind('like');
  expect(writes).toHaveLength(1);
});

test('a successful subject command updates its own scoped selection without another private read', async () => {
  await paint('subject', { id: 'subject-one' });
  await until(() => privateReads.length === 1);
  setPrivateRead(0, 'love');
  await until(() => chip('love').getAttribute('aria-pressed') === 'true');
  await clickKind('like');
  expect(writes).toHaveLength(1);
  writes[0]!.resolve({ ok: true });
  await until(() => chip('like').getAttribute('aria-pressed') === 'true');
  expect(privateReads).toHaveLength(1);
});

test('Zone subject target and view replacement suppress delayed old private responses and keep public counts', async () => {
  await paint('zone', { id: 'subject-one', view: 'overview' });
  await until(() => zoneReads.length === 1);
  await paint('zone', { id: 'subject-two', view: 'overview' });
  await until(() => zoneReads.length === 2);
  setZoneRead(0, 'love');
  await tick();
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  setZoneRead(1, null);
  await until(() => chips().some((button) => !button.disabled));
  expect(chips().some((button) => button.textContent?.includes('2'))).toBe(true);

  await paint('zone', { id: 'subject-two', view: 'relations' });
  await paint('zone', { id: 'subject-two', view: 'overview' });
  await until(() => zoneReads.length === 3);
  await paint('zone', { id: 'subject-two', view: 'relations' });
  await paint('zone', { id: 'subject-two', view: 'overview' });
  await until(() => zoneReads.length === 4);
  setZoneRead(2, 'love');
  await tick();
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  setZoneRead(3, null);
  await until(() => chips().some((button) => !button.disabled));
});

test('provider replacement and unmount retire old private reads, writes and refresh continuations', async () => {
  let refresh!: ReturnType<typeof deferred<void>>;
  const refreshStarts: string[] = [];
  const onMutation = async () => {
    refreshStarts.push('started');
    refresh ??= deferred<void>();
    await refresh.promise;
  };
  await paint('subject', { id: 'subject-one', onMutation });
  await until(() => privateReads.length === 1);

  nextClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  nextClient.setQueryData(sessionQuery.queryKey, viewer());
  await paint('subject', { id: 'subject-one', onMutation }, nextClient);
  await until(() => privateReads.length === 2);
  privateReads[0]!.response.reject(new Error('retired reader failed'));
  await tick();
  expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
  setPrivateRead(1, null);
  await until(() => chips().some((button) => !button.disabled));

  await clickKind('like');
  expect(writes).toHaveLength(1);
  writes[0]!.resolve({ ok: true });
  await until(() => refreshStarts.length === 1);
  await act(async () => {
    root.render(null);
    refresh.resolve();
    await tick();
  });
  expect(writes).toHaveLength(1);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

for (const source of ['manual', 'fetch'] as const)
  test(`${source} equal success synchronously retires a shared StrictMode observation and requires a fresh matching own response`, async () => {
    let observed!: ReturnType<typeof useSubjectReactionReader>;
    function Witness() {
      observed = useSubjectReactionReader({
        subjectId: 'subject-one',
        locale: 'en',
        view: 'overview',
        session: currentSession(client),
      });
      return null;
    }
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <SubjectOwner id="subject-one" />
            <Witness />
          </QueryClientProvider>
        </StrictMode>,
      );
    });
    await until(() => privateReads.length === 1 && publicReads.length === 1);
    const oldOrigin = observed.origin;
    const oldKey = client
      .getQueryCache()
      .findAll({ queryKey: ['subject-own-reaction'] })
      .find((query) => query.state.fetchStatus === 'fetching')!.queryKey;
    const observer = new QueryObserver(client, sessionQuery);
    const unsubscribeObserver = observer.subscribe(() => {});
    await act(async () => {
      observer.updateResult();
      await client.invalidateQueries({ queryKey: sessionQuery.queryKey, exact: true, refetchType: 'none' });
      client.setQueryData(['session', 'unrelated'], viewer());
    });
    expect(observed.origin.key).toBe(oldOrigin.key);
    expect(oldOrigin.isCurrent()).toBe(true);
    expect(privateReads).toHaveLength(1);
    const prior = client.getQueryData(sessionQuery.queryKey);
    const successData: unknown[] = [];
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey.length === 1 &&
        event.query.queryKey[0] === 'session' &&
        event.type === 'updated' &&
        event.action.type === 'success'
      ) {
        successData.push(event.query.state.data);
        expect(oldOrigin.isCurrent()).toBe(false);
        setPrivateRead(0, 'love');
      }
    });
    await act(async () => {
      if (source === 'manual') client.setQueryData(sessionQuery.queryKey, { ...viewer() });
      else await client.fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: async () => ({ ...viewer() }) });
      expect(oldOrigin.isCurrent()).toBe(false);
      await tick();
    });
    unsubscribe();
    unsubscribeObserver();
    expect(successData).toEqual([viewer()]);
    expect(successData[0]).toBe(prior);
    await until(() => privateReads.length === 2);
    expect(client.getQueryData(oldKey)).toBeUndefined();
    expect(chips().every((button) => button.disabled)).toBe(true);
    expect(chips().filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0);
    expect(publicReads).toEqual(['subject-one']);
    expect(writes).toHaveLength(0);
    expect(observed.origin.key).not.toBe(oldOrigin.key);
    setPrivateRead(1, null);
    await until(() => chips().some((button) => !button.disabled));
    await clickKind('like');
    await act(async () => {
      writes[0]!.resolve({ ok: true });
      await tick();
    });
    await until(() => chip('like').getAttribute('aria-pressed') === 'true');
    await clickKind('like');
    await act(async () => {
      writes[1]!.resolve({ ok: true });
      await tick();
    });
    await until(() => chips().every((button) => button.getAttribute('aria-pressed') !== 'true'));
    expect(privateReads).toHaveLength(2);
    expect(publicReads).toHaveLength(1);
    expect(writes.map((write) => write.data)).toEqual([
      { target: 'subject', id: 'subject-one', kind: 'like', expectedReader: 'reader-one' },
      { target: 'subject', id: 'subject-one', kind: null, expectedReader: 'reader-one' },
    ]);
    expect(writes.every((write) => write.headers.get('x-csrf-token') === 'csrf-one')).toBe(true);
  });

for (const size of [1, 10, 100])
  test(`${size} mounted observers share one own read per equal-success admission without public read growth`, async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <SubjectOwner id="subject-one" />
            {Array.from({ length: size - 1 }, (_, index) => (
              <SubjectReaderWitness key={index} id="subject-one" />
            ))}
          </QueryClientProvider>
        </StrictMode>,
      );
    });
    await until(() => privateReads.length === 1 && publicReads.length === 1);
    setPrivateRead(0, null);
    await until(() => chips().some((button) => !button.disabled));
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { ...viewer() });
      await tick();
    });
    await until(() => privateReads.length === 2);
    expect(chips().every((button) => button.disabled)).toBe(true);
    expect(publicReads).toHaveLength(1);
    setPrivateRead(1, null);
    await until(() => chips().some((button) => !button.disabled));
    await clickKind('like');
    await act(async () => {
      writes[0]!.resolve({ ok: true });
      await tick();
    });
    expect(writes).toHaveLength(1);
    expect(privateReads).toHaveLength(2);
    expect(publicReads).toHaveLength(1);
  });
