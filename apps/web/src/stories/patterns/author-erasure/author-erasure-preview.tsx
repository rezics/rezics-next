import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import { parseAuthorErasureAdmission } from '../../../threads/author-erasure-admission';
import { AuthorErasureOperationPage } from '../../../threads/author-erasure-operation';
import { ThreadReading } from '../../../threads/thread-reading';
import { ThreadReadingHeader, ThreadReadingPost } from '../../../routes/threads/$id_.$slug';
import { threadPageQuery, threadPersonalQuery } from '../../../threads/thread-queries';
import { threadHref } from '../../../threads/thread-href';
import type { ErasureIntent, ErasureOperation, ErasureRead } from '../../../threads/author-erasure';
import { useSession } from '../../../session/query';
import { AppShell, ErrorPage } from '../../../shell/shell';
import { PendingPage } from '../../../shell/pending';
import { PatternStory } from '../../page';
import { storyViewerId } from '../../../kernel/fake/identities';
import owned from '../../../kernel/recorded/thread-owned.json';

export type ErasureStoryState =
  | 'unavailable-entry'
  | 'available-entry'
  | 'denied-entry'
  | 'lost-response'
  | 'queued'
  | 'running'
  | 'permission-denied'
  | 'completed';
const operationId = '01a17a7a-1071-720f-8100-2345e36e8473';

/** Illustrative wire DTOs only. They do not establish native permission, counters or completion. */
export function erasureStoryOperation(state: ErasureStoryState): ErasureOperation {
  const base = {
    name: `operations/${operationId}` as const,
    metadata: {
      type: 'content.author_erasure' as const,
      threadId: owned.thread.id,
      authorId: owned.thread.authorId,
      processedPosts: state === 'queued' ? 0 : 8,
      erasedRevisions: state === 'queued' ? 0 : 19,
      steps: state === 'queued' ? 0 : 2,
    },
  };
  if (state === 'permission-denied') return { ...base, done: true, error: { code: 7, message: 'Permission denied' } };
  if (state === 'completed') return { ...base, done: true, response: { processedPosts: 8, erasedRevisions: 19 } };
  return { ...base, done: false };
}

function EntryThread({ state, onAccepted }: { state: ErasureStoryState; onAccepted: () => void }) {
  const client = useQueryClient();
  const { state: session } = useSession();
  const page = useQuery(threadPageQuery(owned.thread.id, undefined, 'anonymous'));
  const loaded = page.data && !('redirect' in page.data) ? page.data : undefined;
  const [postIds, setPostIds] = useState<string[]>([]);
  const personal = useQuery({
    ...threadPersonalQuery(
      owned.thread.id,
      undefined,
      postIds.length ? postIds : (loaded?.posts.posts.map((p) => p.id) ?? []),
      { readReactions: !loaded?.composed },
    ),
    enabled: session === 'signed-in' && !!loaded,
  });
  const original = useRef<ErasureIntent | null>(null);
  if (page.isPending) return <PendingPage />;
  if (!loaded) return <ErrorPage />;
  return (
    <ThreadReading
      page={loaded}
      personal={personal.data}
      session={session}
      Post={ThreadReadingPost}
      signedOut={null}
      returnTo={threadHref(owned.thread)}
      onPostIdsChange={setPostIds}
      renderHeader={(title) => <ThreadReadingHeader page={loaded} title={title} />}
      onMutation={async () => {
        await client.invalidateQueries();
      }}
      onPageRefresh={async () => {
        const next = await page.refetch();
        return next.data && !('redirect' in next.data) ? next.data : undefined;
      }}
      {...(state === 'lost-response'
        ? {
            authorErasure: {
              admission: { kind: 'current' as const, mayErase: true },
              onAccepted,
              send: async (intent: ErasureIntent) => {
                if (!original.current) {
                  original.current = intent;
                  return { kind: 'uncertain' as const };
                }
                if (
                  intent.threadId !== original.current.threadId ||
                  intent.idempotencyKey !== original.current.idempotencyKey
                )
                  throw new Error('Uncertain retries must retain the original intent');
                return { kind: 'accepted' as const, operationId };
              },
            },
          }
        : {
            authorErasure: {
              ...(state === 'available-entry' || state === 'denied-entry'
                ? {
                    send: async () => ({ kind: 'unavailable' as const }),
                    readAdmission: async (threadId: string) =>
                      parseAuthorErasureAdmission(
                        {
                          thread: { id: owned.thread.id },
                          authorErasure: { authorId: storyViewerId, mayErase: state === 'available-entry' },
                        },
                        threadId,
                        storyViewerId,
                      ),
                  }
                : { admission: { kind: 'unavailable' as const } }),
            },
          })}
    />
  );
}

export function AuthorErasurePreview({
  state = 'running',
  shell = false,
}: {
  state?: ErasureStoryState;
  shell?: boolean;
}) {
  const [accepted, setAccepted] = useState(false);
  const entry = (state === 'lost-response' || state.endsWith('-entry')) && !accepted;
  const operation = useMemo(() => erasureStoryOperation(accepted ? 'queued' : state), [accepted, state]);
  const current: ErasureRead = useMemo(() => ({ kind: 'available', operation }), [operation]);
  const read = useCallback(async () => current, [current]);
  const content = entry ? (
    <EntryThread state={state} onAccepted={() => setAccepted(true)} />
  ) : (
    <AuthorErasureOperationPage initial={current} operationId={operationId} read={read} />
  );
  return (
    <PatternStory visitor="Signed In" path={entry ? threadHref(owned.thread) : `/operations/${operationId}`}>
      {shell ? <AppShell>{content}</AppShell> : <div className="p-3 md:p-6">{content}</div>}
    </PatternStory>
  );
}
