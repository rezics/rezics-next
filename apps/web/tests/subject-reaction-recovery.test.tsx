import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
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
afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

type OwnReaction = { reader: string; value: 'like' | null };
type Read = { id: string; reader: string | null; response: ReturnType<typeof deferred<OwnReaction>> };
type ReactionProps = { counts: { like: number }; personalReady: boolean; target: { id: string }; value: string | null };
const reads: Read[] = [];
const origins = new Map<string, { isCurrent(): boolean }>();
const reactionProps = new Map<string, ReactionProps>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

mock.module('../src/kernel/query', () => ({ personalRead: { enabled: true } }));
mock.module('../src/features/pages/subject-queries', () => ({
  subjectOwnReactionQuery: (id: string, locale: string, scope: { reader: string | null; scopeKey: string }) => ({
    queryKey: ['recovery-test-own-reaction', id, locale, scope.scopeKey],
    meta: { subjectReactionScope: scope.scopeKey },
    retry: false,
    queryFn: () => {
      const response = deferred<OwnReaction>();
      reads.push({ id, reader: scope.reader, response });
      return response.promise;
    },
  }),
}));
mock.module('../src/report/content-actions', () => ({ PostActions: () => null }));
mock.module('../src/library/follow-target-control', () => ({ FollowTargetControl: () => null }));
mock.module('../src/threads/thread-reactions', () => ({
  ThreadReactions: (props: ReactionProps) => {
    reactionProps.set(props.target.id, props);
    return <span data-public-count={props.target.id}>{props.counts.like}</span>;
  },
}));

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, useQueryClient } = await import('@tanstack/react-query');
const { useSubjectReactionReader } = await import('../src/features/pages/subject-reaction-reader');
const { SubjectHeaderActions } = await import('../src/features/pages/subject-reactions-view');
const { m } = await import('../src/paraglide/messages.js');

type Session = { state: 'signed-in'; subject: string; csrfToken: string };
const viewer = (subject: string): Session => ({ state: 'signed-in', subject, csrfToken: 'csrf' });

function RecoverySurface({ id, zone }: { id: string; zone: boolean }) {
  const client = useQueryClient();
  const session = client.getQueryData<Session>(['session'])!;
  const reaction = useSubjectReactionReader({ subjectId: id, locale: 'en', view: 'overview', session });
  origins.set(id, reaction.origin);
  return (
    <SubjectHeaderActions
      id={id}
      reactions={{ counts: { like: 3, love: 2, laugh: 0, insightful: 1, sad: 0 }, value: reaction.ownReaction?.value ?? null }}
      returnTo={`/en/${zone ? 'zones/zone/subjects' : 'subjects'}/${id}`}
      signedIn
      personalReady={zone ? Boolean(reaction.ready && reaction.ownReaction?.reader === reaction.reader) : reaction.ready}
      reactionOrigin={reaction.origin}
      reactionRecovery={{
        failed: reaction.recoveryFailed,
        pending: reaction.recoveryPending,
        retry: reaction.retryOwnReaction,
      }}
      verification={{ sitekey: '', scriptUrl: '' }}
    />
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check() && Date.now() < deadline) await tick();
  expect(check()).toBe(true);
}

test('Subject and Zone headers retry failed own-reaction reads without reviving old sessions', async () => {
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer('reader-one'));
  const root = createRoot(host as unknown as HTMLElement);
  const tree = (
    <QueryClientProvider client={client}>
      <RecoverySurface id="subject-one" zone={false} />
      <RecoverySurface id="subject-two" zone />
    </QueryClientProvider>
  );
  const buttons = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) => button.textContent?.trim() === m.subject_reaction_recovery_retry(),
    );
  try {
    await act(async () => {
      root.render(tree);
      await tick();
    });
    await until(() => reads.length === 2);
    await act(async () => {
      reads[0]!.response.reject(new Error('temporary read failure'));
      reads[1]!.response.reject(new Error('temporary read failure'));
      await tick();
    });
    await until(() => buttons().length === 2);
    expect(host.querySelector('[data-public-count="subject-one"]')?.textContent).toBe('3');
    expect(reactionProps.get('subject-one')?.personalReady).toBe(false);
    const failedOrigins = ['subject-one', 'subject-two'].map((id) => origins.get(id)!);

    await act(async () => {
      for (const button of buttons()) button.click();
      await tick();
    });
    await until(() => reads.length === 4);
    expect(buttons().every((button) => button.disabled)).toBe(true);
    expect(failedOrigins.every((origin) => !origin.isCurrent())).toBe(true);

    await act(async () => {
      reads[2]!.response.reject(new Error('retry failed'));
      reads[3]!.response.resolve({ reader: 'reader-one', value: 'like' });
      await tick();
    });
    await until(() => buttons().length === 1 && !buttons()[0]!.disabled);
    expect(reactionProps.get('subject-one')?.personalReady).toBe(false);
    expect(reactionProps.get('subject-two')?.personalReady).toBe(true);
    await act(async () => {
      buttons()[0]!.click();
      await tick();
    });
    await until(() => reads.length === 5);

    await act(async () => {
      client.setQueryData(['session'], viewer('reader-two'));
      await tick();
    });
    await until(() => reads.length === 7);
    await act(async () => {
      reads[4]!.response.resolve({ reader: 'reader-one', value: 'like' });
      await tick();
    });
    expect(reactionProps.get('subject-one')?.personalReady).toBe(false);
    await act(async () => {
      reads[5]!.response.resolve({ reader: 'reader-two', value: 'like' });
      reads[6]!.response.resolve({ reader: 'reader-two', value: 'like' });
      await tick();
    });
    await until(() => ['subject-one', 'subject-two'].every((id) => reactionProps.get(id)?.personalReady));
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
