import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ThreadReading } from '../../../threads/thread-reading';
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
import thread from '../../../kernel/recorded/thread.json';
import owned from '../../../kernel/recorded/thread-owned.json';
import history from '../../../kernel/recorded/thread-history-thread.json';
import community from '../../../kernel/recorded/board-realm-thread.json';

export type ReadingState =
  | 'populated'
  | 'community'
  | 'deleted'
  | 'withheld'
  | 'own'
  | 'history'
  | 'loading'
  | 'unavailable'
  | 'denied';

function Connected({ state }: { state: ReadingState }) {
  const source = state === 'own' ? owned : state === 'history' ? history : state === 'community' ? community : thread;
  const id = source.thread.id;
  const returnTo = threadHref(source.thread);
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
    ),
    enabled: session === 'signed-in' && loaded !== undefined,
  });
  if (pageQuery.isPending) return <PendingPage />;
  if (pageQuery.isError) return <ErrorPage />;
  if (!loaded) return <ErrorPage />;
  // Explicit lifecycle examples replace the current payload; no earlier revision body is used as a fallback.
  const page =
    state === 'deleted' || state === 'withheld'
      ? {
          ...loaded,
          posts: {
            ...loaded.posts,
            posts: loaded.posts.posts.map((post, index): ThreadPost => {
              if (index !== 1 || post.availability !== 'available') return post;
              return state === 'deleted'
                ? { ...post, body: null, sha256: null, removed: true, availability: 'erased' }
                : { ...post, body: null, sha256: null, removed: true, availability: 'withheld' };
            }),
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
        const next = await queryClient.fetchQuery({ ...threadPageQuery(id, undefined, 'anonymous'), staleTime: 0 });
        return 'redirect' in next ? undefined : next;
      }}
    />
  );
}

/** Both story tiers render the delivered region; the page tier adds only the existing application shell. */
export function ThreadReadingPreview({
  state = 'populated',
  shell = false,
}: {
  state?: ReadingState;
  shell?: boolean;
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
    <PatternStory visitor="Signed In" path={threadHref(thread.thread)}>
      {shell ? <AppShell>{content}</AppShell> : <div className="p-3 md:p-6">{content}</div>}
    </PatternStory>
  );
}
