import { RemovedPost } from '../../threads/post-removed';
import { ReplyButton, ReplyContext, type ReplyParents } from '../../threads/reply-context';
import { csrfHeaders, draftFetch, InlinePostEditor, SignInPrompt } from '../../threads/composer';
import { erasePost, restorePost as restorePostAction, revisePost, type WriteFailure } from '../../threads/actions';
import type { ThreadSubject } from '../../threads/subjects';
import type { VoteCitation } from '../../threads/post-writes';
import { RevisionProvenance } from '../../threads/revision-provenance-view';
import { PostHistory } from '../../threads/post-history';
import { ThreadPostActions, ThreadReactions } from '../../threads/thread-reactions';
import { Byline } from '../../threads/byline';
import type { VerificationConfig } from '../../report/turnstile';
import { PostActions } from '../../report/content-actions';
import type { ThreadPost } from '../../threads/reads';
import type { PageAuthors } from '../../identity/read';
import { Share2Icon } from 'lucide-react';
import type { ReactionKind } from '@rezics/ui/reactions';
import { undoToast } from '@rezics/ui/undo-toast';
import { Button } from '@rezics/ui/shadcn/button';
import { ListRow } from '@rezics/ui/list-row';
import { DocumentBody, type DocumentMentions } from '@rezics/ui/document-body';
import { ContentActions } from '@rezics/ui/content-actions';
import { useSession } from '../../session/query';
import { createFileRoute, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { threadPageQuery, threadPersonalQuery } from '../../threads/thread-queries';
import { threadPageHead } from '../../threads/thread-head';
import { rememberThreadSlug, rememberedThreadSlug, sameThreadSlug, slugMatches, threadLocation, threadTitle } from '../../threads/thread-href';
import { BoardContext } from '../../threads/thread-context';
import { ThreadSubjects } from '../../threads/thread-subjects';
import { ThreadReading, type ThreadReadingPage } from '../../threads/thread-reading';
import { PageHeading } from '../../shell/page-heading';

function threadSearch(search: Record<string, unknown>): { cursor?: string } {
  const cursor = v.parse(v.fallback(v.optional(v.string()), undefined), search.cursor);
  return typeof cursor === 'string' ? { cursor } : {};
}

export const Route = createFileRoute('/threads/$id_/$slug')({
  staticData: { publicCache: true },
  validateSearch: threadSearch,
  loaderDeps: ({ search }) => ({ cursor: threadSearch(search).cursor }),
  loader: async ({ params, deps, context }) => {
    const mode = context.credentialMode;
    const known = rememberedThreadSlug(params.id);
    const expectedSlug = known !== undefined && slugMatches(params.slug, known) ? undefined : params.slug;
    const page = await context.queryClient.ensureQueryData(threadPageQuery(params.id, deps.cursor, mode, expectedSlug));
    if ('redirect' in page) {
      rememberThreadSlug(page.redirect.id, page.redirect.title);
      throw redirect({ href: threadLocation(getLocale(), page.redirect, deps.cursor), statusCode: 301 });
    }
    const title = threadTitle(page.thread);
    rememberThreadSlug(page.thread.id, title);
    if (!sameThreadSlug(params.slug, title))
      throw redirect({
        href: threadLocation(getLocale(), { id: page.thread.id, title }, deps.cursor),
        statusCode: 301,
      });
    return { ...page, indexable: deps.cursor === undefined };
  },
  head: ({ loaderData }) => (loaderData ? threadPageHead(loaderData) : { meta: [{ title: m.threads_untitled() }] }),
  component: ThreadPage,
});

export function ThreadReadingHeader({ page, title }: { page: ThreadReadingPage; title: string | null }) {
  return (
    <header className="min-h-8 scroll-mt-24 space-y-3 px-1">
      <BoardContext realm={page.realm} board={page.board} prominent />
      {title ? <PageHeading>{title}</PageHeading> : null}
      <ThreadSubjects subjects={page.subjects} />
    </header>
  );
}

function ThreadPage() {
  const page = Route.useLoaderData();
  const [postIds, setPostIds] = useState(() => page.posts.posts.map((post) => post.id));
  const { state: session } = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const location = useLocation();
  const id = Route.useParams().id;
  const cursor = Route.useSearch().cursor;
  const returnTo = location.publicHref.split(/[?#]/, 1)[0]!;
  const personalQuery = useQuery({
    ...threadPersonalQuery(id, cursor, postIds),
    enabled: session === 'signed-in',
  });
  const personal = session === 'signed-in' ? personalQuery.data : undefined;
  useEffect(() => setPostIds(page.posts.posts.map((post) => post.id)), [page.posts]);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash.startsWith('post-')) document.getElementById(hash)?.scrollIntoView();
    else if (!hash) window.scrollTo(0, 0);
  }, [id, location.hash, page.posts]);

  async function refreshThreadQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['thread-page', id] }),
      queryClient.invalidateQueries({ queryKey: ['thread-personal', id] }),
    ]);
  }

  async function refreshThreadPage() {
    const updated = await queryClient.fetchQuery({
      ...threadPageQuery(id, cursor, session === 'signed-in' ? 'session' : 'anonymous'),
      staleTime: 0,
    });
    if ('redirect' in updated) return;
    rememberThreadSlug(updated.thread.id, updated.thread.title);
    const destination = threadLocation(getLocale(), { id: updated.thread.id, title: updated.thread.title }, cursor);
    if (new URL(destination, window.location.origin).pathname !== location.pathname)
      await router.navigate({ to: destination });
    return updated;
  }

  return (
    <ThreadReading
      key={id}
      page={page}
      Post={ThreadReadingPost}
      signedOut={<SignInPrompt returnTo={returnTo} label={m.threads_sign_in_to_reply()} />}
      personal={personal}
      session={session}
      returnTo={returnTo}
      renderHeader={(title) => <ThreadReadingHeader page={page} title={title} />}
      onMutation={refreshThreadQueries}
      onPageRefresh={refreshThreadPage}
      onPostIdsChange={setPostIds}
    />
  );
}

function SharePost({ onCopyLink }: { onCopyLink: () => Promise<void> }) {
  const [message, setMessage] = useState('');
  return <div className="flex min-w-0 flex-wrap items-center gap-2">
    <Button type="button" variant="ghost" size="sm" onClick={async () => {
      try { await onCopyLink(); setMessage(m.thread_reading_link_copied()); }
      catch { setMessage(m.thread_reading_share_failed()); }
    }}><Share2Icon aria-hidden="true" />{m.thread_reading_share()}</Button>
    {message ? <span role="status" className="text-xs text-muted-foreground">{message}</span> : null}
  </div>;
}


function fullDateTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'full', timeStyle: 'long', timeZone: 'UTC' }).format(date);
}

function postDeleteFailureText(failure: WriteFailure): string {
  return failure.reason === 'closed' ? m.thread_write_closed() : m.thread_delete_failure();
}

export function ThreadReadingPost({
  post,
  authors,
  mentions,
  now,
  viewerId,
  personalReady,
  onChange,
  anchorId,
  target,
  counts,
  value,
  signedIn,
  returnTo,
  verification,
  onMutation,
  onPageRefresh,
  onOpeningPostChange,
  replyParents,
  replyPending,
  onReply,
  subjects,
  currentVote,
  review,
}: {
  post: ThreadPost;
  authors: PageAuthors;
  mentions: DocumentMentions;
  now: string;
  viewerId: string | undefined;
  personalReady: boolean;
  onChange: (post: ThreadPost) => void;
  anchorId: string;
  target: { kind: 'thread' | 'post'; id: string };
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  signedIn: boolean;
  returnTo: string;
  verification: VerificationConfig;
  onMutation: () => Promise<void>;
  onPageRefresh: () => Promise<void>;
  onOpeningPostChange: (restored: boolean) => void;
  replyParents: ReplyParents;
  replyPending: boolean;
  onReply: () => void;
  subjects: ThreadSubject[];
  currentVote: VoteCitation | undefined;
  review: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [removedMinHeight, setRemovedMinHeight] = useState<number>();
  const menuButton = useRef<HTMLButtonElement>(null);
  const itemElement = useRef<HTMLLIElement>(null);
  const deleteKey = useRef<string | undefined>(undefined);
  const restoreKey = useRef<string | undefined>(undefined);
  const restoreSnapshot = useRef<ThreadPost | undefined>(undefined);
  const restorePending = useRef(false);
  const restoreMenuFocus = useRef(false);
  const restorePostFocus = useRef(false);
  const ownsPost = viewerId !== undefined && post.availability === 'available' && post.authorId === viewerId;

  useEffect(() => {
    if (restoreMenuFocus.current && !editing) {
      restoreMenuFocus.current = false;
      menuButton.current?.focus();
    }
    if (restorePostFocus.current && !editing && post.availability === 'available') {
      restorePostFocus.current = false;
      itemElement.current?.focus();
    }
  }, [editing, post.availability]);

  const labels = {
    moreActions: m.thread_content_more_actions(),
    copyLink: m.thread_content_copy_link(),
    edit: m.thread_content_edit(),
    delete: m.thread_content_delete(),
    deleteTitle: m.thread_delete_title(),
    deleteDescription: m.thread_delete_description(),
    confirmDelete: m.thread_delete_confirm(),
    cancel: m.thread_delete_cancel(),
    deleteFailure: m.thread_delete_failure(),
  };

  async function copyLink() {
    await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${anchorId}`);
  }

  function cancelEdit() {
    restoreMenuFocus.current = true;
    setEditing(false);
  }

  async function restoreRemovedPost(snapshot?: ThreadPost) {
    if (restorePending.current) return;
    restorePending.current = true;
    setRestoreError('');
    restoreKey.current ??= crypto.randomUUID();
    try {
      const result = await restorePostAction({
        data: { postId: post.id, idempotencyKey: restoreKey.current },
        headers: csrfHeaders(),
      });
      if (!result.ok) {
        if (result.reason === 'conflict') {
          restoreKey.current = undefined;
          setRestoreError(m.thread_post_restore_conflict());
        } else {
          setRestoreError(m.thread_post_restore_failure());
        }
        return;
      }

      restoreKey.current = undefined;
      restorePostFocus.current = true;
      if (snapshot) {
        onChange(snapshot);
        if (target.kind === 'thread') onOpeningPostChange(true);
      } else {
        // A fresh tombstone has no body by contract. Once restored, reload its readable page entry.
        await onPageRefresh();
      }
    } catch {
      setRestoreError(m.thread_post_restore_failure());
    } finally {
      restorePending.current = false;
    }
  }

  async function deletePost() {
    deleteKey.current ??= crypto.randomUUID();
    const result = await erasePost({
      data: {
        postId: post.id,
        idempotencyKey: deleteKey.current,
        ...(target.kind === 'thread' ? { openingThreadId: target.id } : {}),
      },
      headers: csrfHeaders(),
    });
    if (!result.ok) throw new Error(postDeleteFailureText(result));
    if (removedMinHeight === undefined) setRemovedMinHeight(itemElement.current?.getBoundingClientRect().height);
    restoreSnapshot.current = post;
    restoreMenuFocus.current = true;
    setRestoreError('');
    const deleted: ThreadPost = {
      ...post,
      body: null,
      sha256: null,
      availability: 'erased',
      removed: true,
      restorableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    onChange(deleted);
    if (target.kind === 'thread') onOpeningPostChange(false);
    undoToast(m.thread_post_deleted_toast(), () => void restoreRemovedPost(post), { undo: m.thread_post_undo() });
  }

  if (post.availability !== 'available') {
    const canRestore =
      post.availability === 'erased' &&
      'authorId' in post &&
      viewerId === post.authorId &&
      'restorableUntil' in post &&
      Boolean(post.restorableUntil);
    return (
      <RemovedPost
        post={post}
        authors={authors}
        now={now}
        {...(viewerId !== undefined ? { viewerId } : {})}
        anchorId={anchorId}
        itemRef={itemElement}
        menuButton={menuButton}
        {...(removedMinHeight !== undefined ? { minHeight: removedMinHeight } : {})}
        restoreError={restoreError}
        onCopyLink={copyLink}
        {...(canRestore ? { onRestore: () => void restoreRemovedPost(restoreSnapshot.current) } : {})}
      >
        <ReplyContext parentId={post.parentId} parents={replyParents} />
      </RemovedPost>
    );
  }

  const authorId = 'authorId' in post ? post.authorId : undefined;
  return (
    <ListRow id={anchorId} ref={itemElement} tabIndex={-1} className="min-w-0 scroll-mt-24 rounded-xl bg-card px-4 py-5 target:ring-2 target:ring-ring sm:p-6">
      <div className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <Byline
          author={authorId === undefined ? undefined : authors?.[authorId]}
          createdAt={post.createdAt}
          now={now}
          showAuthor={authorId !== undefined}
          className="min-h-8 min-w-0 flex-1 basis-48"
        >
          {post.revisedAt && new Date(post.revisedAt).getTime() > new Date(post.createdAt).getTime() ? (
            <time dateTime={post.revisedAt} title={fullDateTime(post.revisedAt)}>
              {m.thread_post_edited()}
            </time>
          ) : null}
        </Byline>
        <ThreadPostActions>
          <ThreadReactions
            counts={counts}
            returnTo={returnTo}
            signedIn={signedIn}
            target={target}
            value={value}
            onMutation={onMutation}
            personalReady={personalReady}
          />
          {editing ? null : ownsPost ? (
            <ContentActions
              labels={labels}
              onCopyLink={copyLink}
              onDelete={deletePost}
              onEdit={() => {
                setEditKey(crypto.randomUUID());
                setEditing(true);
              }}
              ownsContent
              triggerRef={menuButton}
            />
          ) : (
            <PostActions
              target={target}
              {...(post.revisionId ? { revisionId: post.revisionId } : {})}
              verification={verification}
            />
          )}
        </ThreadPostActions>
      </div>
      <ReplyContext parentId={post.parentId} parents={replyParents} />
      {editing ? (
        <InlinePostEditor
          initialBody={post.body}
          initialMediaIds={post.mediaIds}
          revisionId={post.revisionId}
          idempotencyKey={editKey}
          containerId={post.threadId}
          onCancel={cancelEdit}
          onSubmit={async ({ body, revisionId, idempotencyKey, mediaIds }) => {
            const result = await revisePost({
              data: { postId: post.id, body, revisionId, idempotencyKey, mediaIds },
              headers: csrfHeaders(),
              fetch: draftFetch(body),
            });
            return result;
          }}
          onSuccess={(updated) => {
            onChange(updated);
            setEditing(false);
            void onMutation();
          }}
        />
      ) : (
        <>
          <DocumentBody
            className="mx-0! w-full overflow-x-auto [overflow-wrap:anywhere] [&_img]:rounded-lg"
            document={post.body}
            mentions={mentions}
            locale={getLocale()}
            labels={{ revealSpoiler: m.thread_reveal_spoiler() }}
          />
          <div className="mt-4">
          <RevisionProvenance
            revision={post}
            subjects={subjects}
            currentVote={ownsPost ? (currentVote ?? null) : null}
            review={review}
          />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {post.revisionId ? (
              <PostHistory postId={post.id} {...(viewerId ? { viewerId } : {})} review={review} />
            ) : <span />}
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <SharePost onCopyLink={copyLink} />
              {signedIn && personalReady ? <ReplyButton disabled={replyPending} onReply={onReply} /> : null}
            </div>
          </div>
        </>
      )}
    </ListRow>
  );
}
