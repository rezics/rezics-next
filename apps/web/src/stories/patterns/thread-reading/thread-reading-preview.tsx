import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { fromPlainText } from '@rezics/document';
import { ThreadReading } from '../../../threads/thread-reading';
import { AuthoringDepartureProvider } from '../../../threads/authoring-departure';
import type { ThreadPost } from '../../../threads/thread-page';
import { ThreadReadingHeader, ThreadReadingPost } from '../../../routes/threads/$id_.$slug';
import { threadPageQuery, threadPersonalQuery } from '../../../threads/thread-queries';
import { useSession } from '../../../session/query';
import { SignInPrompt } from '../../../threads/composer';
import { AppShell, ErrorPage, NotFoundPage } from '../../../shell/shell';
import { PendingPage } from '../../../shell/pending';
import { m } from '../../../paraglide/messages.js';
import { threadHref } from '../../../threads/thread-href';
import { PatternStory } from '../../page';
import { deletedOrganizationThreadId } from '../../../kernel/fake';
import thread from '../../../kernel/recorded/thread.json';
import owned from '../../../kernel/recorded/thread-owned.json';
import history from '../../../kernel/recorded/thread-history-thread.json';
import community from '../../../kernel/recorded/board-realm-thread.json';

const longDocument = fromPlainText(
  [
    ...Array.from(
      { length: 24 },
      (_, index) =>
        `Canonical paragraph ${index + 1}: a full discussion remains readable at its original length, with its own complete text and paragraph boundaries.`,
    ),
    'The final canonical paragraph remains visible in the complete discussion document.',
  ].join('\n\n'),
  'blocks',
);

export type ReadingState =
  | 'populated'
  | 'long-document'
  | 'community'
  | 'existing-reply'
  | 'deleted-organization'
  | 'restorable'
  | 'deleted'
  | 'withheld'
  | 'own'
  | 'history'
  | 'loading'
  | 'unavailable'
  | 'denied';

function readingThread(state: ReadingState) {
  if (state === 'deleted-organization') return { id: deletedOrganizationThreadId, title: owned.thread.title };
  return (
    state === 'own' || state === 'existing-reply' || state === 'restorable'
      ? owned
      : state === 'history'
        ? history
        : state === 'community'
          ? community
          : thread
  ).thread;
}

function Connected({ state }: { state: ReadingState }) {
  const source = readingThread(state);
  const id = source.id;
  const returnTo = threadHref(source);
  const queryClient = useQueryClient();
  const { state: session } = useSession();
  const pageQuery = useQuery(threadPageQuery(id, undefined, 'anonymous'));
  const loaded = pageQuery.data && !('redirect' in pageQuery.data) ? pageQuery.data : undefined;
  const [postIds, setPostIds] = useState<string[]>([]);
  const personalQuery = useQuery({
    ...threadPersonalQuery(
      id,
      undefined,
      postIds.length ? postIds : (loaded?.posts.posts.map((post) => post.id) ?? []),
      { readReactions: !loaded?.composed },
    ),
    enabled: session === 'signed-in' && loaded !== undefined,
  });
  if (pageQuery.isPending) return <PendingPage />;
  if (pageQuery.isError) return <ErrorPage />;
  if (!loaded) return <ErrorPage />;
  // Explicit lifecycle examples replace the current payload; no earlier revision body is used as a fallback.
  const page =
    state === 'deleted' || state === 'withheld' || state === 'restorable'
      ? {
          ...loaded,
          posts: {
            ...loaded.posts,
            posts: loaded.posts.posts.map((post, index): ThreadPost => {
              if (index !== 1 || post.availability !== 'available') return post;
              if (state === 'restorable')
                return {
                  id: post.id,
                  threadId: post.threadId,
                  route: post.route,
                  parentId: post.parentId,
                  availability: 'erased',
                  removed: true,
                  body: null,
                  sha256: null,
                  restorableUntil: '2026-11-23T03:04:05.000Z',
                };
              return state === 'deleted'
                ? { ...post, body: null, sha256: null, removed: true, availability: 'erased' }
                : { ...post, body: null, sha256: null, removed: true, availability: 'withheld' };
            }),
          },
        }
      : state === 'long-document'
        ? {
            ...loaded,
            posts: {
              ...loaded.posts,
              posts: loaded.posts.posts.map((post, index): ThreadPost =>
                index === 0 && post.availability === 'available' ? { ...post, body: longDocument } : post,
              ),
            },
          }
        : loaded;
  return (
    <ThreadReading
      key={`${id}-${state}`}
      page={page}
      Post={ThreadReadingPost}
      personal={personalQuery.data}
      session={session}
      returnTo={returnTo}
      renderHeader={(title) => <ThreadReadingHeader page={page} title={title} />}
      signedOut={<SignInPrompt returnTo={returnTo} label={m.threads_sign_in_to_reply()} />}
      onPostIdsChange={setPostIds}
      onMutation={async () => {
        await queryClient.invalidateQueries();
      }}
      onPageRefresh={async () => {
        const next = await queryClient.fetchQuery({
          ...threadPageQuery(id, undefined, session === 'signed-in' ? 'session' : 'anonymous'),
          staleTime: 0,
          retry: false,
        });
        return 'redirect' in next ? undefined : next;
      }}
    />
  );
}

/** Both story tiers render the delivered region; the page tier adds only the existing application shell. */
export function ThreadReadingPreview({
  state = 'populated',
  shell = false,
  visitor = 'Signed In',
}: {
  state?: ReadingState;
  shell?: boolean;
  visitor?: 'Signed In' | 'Signed Out';
}) {
  const content =
    state === 'loading' ? (
      <PendingPage />
    ) : state === 'unavailable' ? (
      <ErrorPage />
    ) : state === 'denied' ? (
      <NotFoundPage />
    ) : (
      <Connected state={state} />
    );
  return (
    <PatternStory visitor={visitor} path={threadHref(readingThread(state))}>
      <AuthoringDepartureProvider>
        {shell ? <AppShell>{content}</AppShell> : <div className="p-3 md:p-6">{content}</div>}
      </AuthoringDepartureProvider>
    </PatternStory>
  );
}
