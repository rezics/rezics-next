import { RemovedPost } from '../../threads/post-removed';
import { ReplyButton, ReplyContext, type ReplyParents } from '../../threads/reply-context';
import { csrfHeaders, draftFetch, InlinePostEditor, SignInPrompt } from '../../threads/composer';
import { erasePost, restorePost as restorePostAction, revisePost, type WriteFailure } from '../../threads/actions';
import type { ThreadSubject } from '../../threads/subjects';
import type { VoteCitation } from '../../threads/post-writes';
import { RevisionProvenance } from '../../threads/revision-provenance-view';
import { exactRevisionHref } from '../../threads/exact-revision-href';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { DocumentBody, type DocumentMentions } from '../../document-body';
import { NativeDocumentImage } from '../../threads/document-media';
import { documentImageForPost, type ThreadDocumentMedia } from '../../threads/document-media-read';
import { ContentActions } from '@rezics/ui/content-actions';
import { useSession } from '../../session/query';
import { createFileRoute, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as v from 'valibot';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { threadPageQuery, threadPersonalQuery } from '../../threads/thread-queries';
import { threadPageHead } from '../../threads/thread-head';
import {
  rememberThreadSlug,
  rememberedThreadSlug,
  sameThreadSlug,
  slugMatches,
  threadLocation,
  threadTitle,
} from '../../threads/thread-href';
import { BoardContext } from '../../threads/thread-context';
import { ThreadSubjects } from '../../threads/thread-subjects';
import { ThreadReading, type ThreadReadingPage } from '../../threads/thread-reading';
import { PageHeading } from '../../shell/page-heading';
import { AuthoringDepartureProvider } from '../../threads/authoring-departure';

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
    <header className="min-w-0 min-h-8 scroll-mt-24 space-y-3 px-1 [overflow-wrap:anywhere]">
      <BoardContext realm={page.realm} board={page.board} prominent />
      {title ? <PageHeading>{title}</PageHeading> : null}
      <ThreadSubjects subjects={page.subjects} />
    </header>
  );
}

function ThreadPage() {
  const loadedPage = Route.useLoaderData();
  const [refreshed, setRefreshed] = useState<{ source: typeof loadedPage; scope: object; page?: ThreadReadingPage }>();
  const [postIds, setPostIds] = useState(() => loadedPage.posts.posts.map((post) => post.id));
  const { state: session, subject, csrfToken } = useSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const location = useLocation();
  const id = Route.useParams().id;
  const cursor = Route.useSearch().cursor;
  const returnTo = location.publicHref.split(/[?#]/, 1)[0]!;
  const readerScope = useMemo(() => ({}), [session, subject, csrfToken]);
  const readScope = useMemo(() => ({}), [loadedPage, id, cursor, readerScope]);
  const [lastCurrentReader, setLastCurrentReader] = useState<object>();
  const expiredRead = refreshed !== undefined && refreshed.scope !== readScope;
  if (expiredRead) setRefreshed(undefined);
  const currentPageUnavailable =
    (lastCurrentReader !== undefined && lastCurrentReader !== readerScope) ||
    (loadedPage.viewerId !== undefined && (session !== 'signed-in' || loadedPage.viewerId !== subject));
  const page =
    !expiredRead && !currentPageUnavailable && refreshed?.source === loadedPage ? refreshed.page! : loadedPage;
  const personalQuery = useQuery({
    ...threadPersonalQuery(id, cursor, postIds),
    enabled: session === 'signed-in',
  });
  const personal = session === 'signed-in' && personalQuery.data?.viewerId === subject ? personalQuery.data : undefined;
  const currentRead = useRef({ scope: readScope, sequence: 0 });
  if (currentRead.current.scope !== readScope) currentRead.current = { scope: readScope, sequence: 0 };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
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
    const read = currentRead.current;
    const sequence = ++read.sequence;
    const current = () => mounted.current && currentRead.current === read && read.sequence === sequence;
    await queryClient.cancelQueries({ queryKey: ['thread-page', id] });
    if (!current()) throw new Error('Thread reader changed');
    // Retire pre-command pages as well as in-flight reads, so navigation cannot reuse their old bodies.
    queryClient.removeQueries({ queryKey: ['thread-page', id] });
    const updated = await queryClient.fetchQuery({
      ...threadPageQuery(id, cursor, session === 'signed-in' ? 'session' : 'anonymous'),
      staleTime: 0,
      retry: false,
    });
    if (!current() || 'redirect' in updated) throw new Error('Current thread page unavailable');
    if (session === 'signed-in' && (!subject || updated.viewerId !== subject))
      throw new Error('Current thread reader unavailable');
    setLastCurrentReader(readerScope);
    setRefreshed({ source: loadedPage, scope: readScope, page: updated });
    rememberThreadSlug(updated.thread.id, updated.thread.title);
    const destination = threadLocation(getLocale(), { id: updated.thread.id, title: updated.thread.title }, cursor);
    if (new URL(destination, window.location.origin).pathname !== location.pathname)
      await router.navigate({ to: destination });
    return updated;
  }

  if (currentPageUnavailable) {
    return (
      <div role="alert" className="space-y-3 p-4">
        <p>{m.thread_post_unavailable()}</p>
        <Button onClick={() => void refreshThreadPage().catch(() => {})}>{m.thread_post_refresh()}</Button>
      </div>
    );
  }

  return (
    <AuthoringDepartureProvider>
      <ThreadReading
        key={id}
        page={page}
        readAuthority={readScope}
        readerSubject={subject}
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
    </AuthoringDepartureProvider>
  );
}

function SharePost({ onCopyLink }: { onCopyLink: () => Promise<void> }) {
  const [message, setMessage] = useState('');
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={async () => {
          try {
            await onCopyLink();
            setMessage(m.thread_reading_link_copied());
          } catch {
            setMessage(m.thread_reading_share_failed());
          }
        }}
      >
        <Share2Icon aria-hidden="true" />
        {m.thread_reading_share()}
      </Button>
      {message ? (
        <span role="status" className="text-xs text-muted-foreground">
          {message}
        </span>
      ) : null}
    </div>
  );
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
  readAuthority,
  authors,
  mentions,
  documentMedia,
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
  replyParentReader,
  replyPending,
  onReply,
  subjects,
  currentVote,
  review,
}: {
  post: ThreadPost;
  readAuthority?: object | undefined;
  authors: PageAuthors;
  mentions: DocumentMentions;
  documentMedia?: ThreadDocumentMedia | undefined;
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
  onPageRefresh: () => Promise<ThreadReadingPage | undefined>;
  onOpeningPostChange: (restored: boolean) => void;
  replyParents: ReplyParents;
  replyParentReader?: import('../../threads/reply-context').ReplyParentReader | undefined;
  replyPending: boolean;
  onReply: () => void;
  subjects: ThreadSubject[];
  currentVote: VoteCitation | undefined;
  review: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editKey, setEditKey] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const [existingReviewId, setExistingReviewId] = useState<string>();
  const [, updateIntent] = useState(0);
  const [removedMinHeight, setRemovedMinHeight] = useState<number>();
  const menuButton = useRef<HTMLButtonElement>(null);
  const itemElement = useRef<HTMLLIElement>(null);
  const deleteKey = useRef<string | undefined>(undefined);
  const scope = useMemo(
    () => ({}),
    [readAuthority, signedIn, personalReady, viewerId, post.id, post.threadId, target.kind, target.id],
  );
  const feedbackScope = useRef(scope);
  const intent = useRef({
    scope,
    key: undefined as string | undefined,
    pending: false,
    applied: false,
    uncertain: false,
    deleted: false,
    read: 0,
  });
  if (intent.current.scope !== scope) {
    intent.current = {
      scope,
      key: undefined,
      pending: false,
      applied: false,
      uncertain: false,
      deleted: false,
      read: 0,
    };
    deleteKey.current = undefined;
  }
  const restoreIntent = useRef<((expected: object) => Promise<void>) | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      restoreIntent.current = undefined;
      intent.current.key = undefined;
      deleteKey.current = undefined;
    };
  }, []);
  useEffect(() => {
    setRestoreError('');
    setExistingReviewId(undefined);
    feedbackScope.current = scope;
  }, [scope]);
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

  async function refreshCurrentPost() {
    if (!mounted.current) return;
    const command = intent.current;
    const read = ++command.read;
    try {
      const page = await onPageRefresh();
      if (!mounted.current || intent.current !== command || command.read !== read) return;
      if (!page || page.viewerId !== viewerId) throw new Error('Current thread page unavailable');
      command.deleted = false;
      const current = page.posts.posts.find((item) => item.id === post.id);
      if (current?.availability === 'erased') command.applied = false;
      setRestoreError('');
      return current;
    } catch {
      if (mounted.current && intent.current === command && command.read === read) {
        setRestoreError(
          command.applied
            ? m.thread_post_restore_read_failure()
            : command.uncertain
              ? m.thread_post_restore_unknown()
              : m.thread_post_delete_read_failure(),
        );
      }
      return;
    }
  }

  async function restoreRemovedPost(expected = scope) {
    const command = intent.current;
    if (!mounted.current || command.scope !== expected || command.pending || !signedIn || !personalReady || !viewerId)
      return;
    command.pending = true;
    setRestoreError('');
    setExistingReviewId(undefined);
    try {
      // A confirmed write is never repeated because its subsequent read failed.
      if (command.applied) {
        await refreshCurrentPost();
        return;
      }
      if (command.uncertain) {
        const current = await refreshCurrentPost();
        if (!mounted.current || intent.current !== command || !current) return;
        if (current.availability !== 'erased' || !current.restorableUntil) return;
      }
      command.key ??= crypto.randomUUID();
      const result = await restorePostAction({
        data: { postId: post.id, idempotencyKey: command.key },
        headers: csrfHeaders(),
      });
      if (!mounted.current || intent.current !== command) return;
      if (!result.ok) {
        command.uncertain = result.reason === 'unavailable';
        if (result.reason === 'conflict') {
          command.key = undefined;
          setExistingReviewId(result.existingReviewId);
          setRestoreError(m.thread_post_restore_conflict());
        } else {
          setRestoreError(command.uncertain ? m.thread_post_restore_unknown() : m.thread_post_restore_failure());
        }
        return;
      }
      command.applied = true;
      command.deleted = false;
      command.uncertain = false;
      command.key = undefined;
      restorePostFocus.current = true;
      await refreshCurrentPost();
    } catch {
      if (mounted.current && intent.current === command) {
        command.uncertain = true;
        setRestoreError(m.thread_post_restore_unknown());
      }
    } finally {
      command.pending = false;
      if (mounted.current && intent.current === command) updateIntent((value) => value + 1);
    }
  }
  restoreIntent.current = restoreRemovedPost;

  async function deletePost() {
    const command = intent.current;
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
    if (!mounted.current || intent.current !== command) return;
    if (removedMinHeight === undefined) setRemovedMinHeight(itemElement.current?.getBoundingClientRect().height);
    command.deleted = true;
    restoreMenuFocus.current = true;
    setRestoreError('');
    // This byte-free placeholder records the applied deletion, not a native expiry or a read grant.
    onChange({
      id: post.id,
      threadId: post.threadId,
      route: post.route,
      parentId: post.parentId,
      body: null,
      sha256: null,
      availability: 'erased',
      removed: true,
    });
    if (target.kind === 'thread') onOpeningPostChange(false);
    const expected = scope;
    const restore = restoreIntent;
    undoToast(m.thread_post_deleted_toast(), () => void restore.current?.(expected), { undo: m.thread_post_undo() });
    await refreshCurrentPost();
  }

  if (post.availability !== 'available') {
    const canRestore =
      post.availability === 'erased' &&
      signedIn &&
      personalReady &&
      viewerId !== undefined &&
      !intent.current.applied &&
      (intent.current.deleted || Boolean('restorableUntil' in post && post.restorableUntil));
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
        restoreError={feedbackScope.current === scope ? restoreError : ''}
        existingReviewId={feedbackScope.current === scope ? existingReviewId : undefined}
        restored={intent.current.applied}
        deadlineUnknown={intent.current.deleted && !('restorableUntil' in post && post.restorableUntil)}
        {...(feedbackScope.current === scope && restoreError ? { onRefresh: () => void refreshCurrentPost() } : {})}
        onCopyLink={copyLink}
        {...(canRestore ? { onRestore: () => void restoreRemovedPost() } : {})}
      >
        <ReplyContext parentId={post.parentId} parents={replyParents} authors={authors} reader={replyParentReader} />
      </RemovedPost>
    );
  }

  const authorId = 'authorId' in post ? post.authorId : undefined;
  return (
    <li id={anchorId} ref={itemElement} tabIndex={-1} className="min-w-0 scroll-mt-24 target:ring-2 target:ring-ring">
      <ContentItemFrame
        as="article"
        data-slot="content-item-frame"
        className="min-w-0 rounded-xl px-4 py-5 sm:px-6 sm:py-6"
      >
        <div className="mb-4 flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <Byline
            author={authorId === undefined ? undefined : authors?.[authorId]}
            createdAt={post.createdAt}
            now={now}
            showAuthor={authorId !== undefined}
            className="min-h-8 min-w-0 flex-1 basis-40"
          >
            {post.revisedAt && new Date(post.revisedAt).getTime() > new Date(post.createdAt).getTime() ? (
              <time dateTime={post.revisedAt} title={fullDateTime(post.revisedAt)}>
                {m.thread_post_edited()}
              </time>
            ) : null}
          </Byline>
          <div className="max-w-full shrink-0">
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
        </div>
        <ReplyContext parentId={post.parentId} parents={replyParents} authors={authors} reader={replyParentReader} />
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
              renderImage={({ mediaId, alt }) => (
                <NativeDocumentImage
                  image={documentImageForPost(documentMedia, post, mediaId)}
                  alt={alt}
                  locale={getLocale()}
                />
              )}
              mentions={mentions}
              locale={getLocale()}
              labels={{ revealSpoiler: m.thread_reveal_spoiler() }}
            />
            <footer className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="mr-auto min-w-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {m.thread_history_licence()}: {post.licence}
              </p>
              <SharePost onCopyLink={copyLink} />
              {signedIn && personalReady ? <ReplyButton disabled={replyPending} onReply={onReply} /> : null}
              <Collapsible className="contents">
                <CollapsibleTrigger
                  aria-controls={`revision-details-${post.id}`}
                  render={<Button variant="ghost" size="sm" />}
                >
                  {m.thread_provenance_heading()}
                </CollapsibleTrigger>
                <CollapsibleContent
                  id={`revision-details-${post.id}`}
                  keepMounted
                  className="order-last min-w-0 basis-full space-y-3 pt-3"
                >
                  <RevisionProvenance
                    revision={post}
                    subjects={subjects}
                    currentVote={ownsPost ? (currentVote ?? null) : null}
                    review={review}
                    showLicence={false}
                  />
                  {post.revisionId ? (
                    <a
                      href={exactRevisionHref({ postId: post.id, revisionId: post.revisionId }, getLocale())}
                      className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                    >
                      {m.exact_revision_heading()}
                    </a>
                  ) : null}
                </CollapsibleContent>
              </Collapsible>
              {post.revisionId ? (
                <PostHistory
                  postId={post.id}
                  readAuthority={scope}
                  {...(viewerId ? { viewerId } : {})}
                  review={review}
                  className="contents"
                />
              ) : null}
            </footer>
          </>
        )}
      </ContentItemFrame>
    </li>
  );
}
