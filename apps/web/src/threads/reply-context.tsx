import { Button } from '@rezics/ui/shadcn/button';
import { ReplyIcon } from 'lucide-react';
import { useCallback, useId, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthor, PageAuthors } from '../identity/read';
import { exactRevisionHref } from './exact-revision-href';
import { replyParentExcerpt, type ReplyParentResult } from './reply-parent-read';
import type { ThreadPost } from './thread-page';
import { useReplyParentNavigation } from './conversation-branches';

export type ReplyParents = ReadonlyMap<
  string,
  Pick<ThreadPost, 'id' | 'availability'> & { authorId?: string; body?: ThreadPost['body'] }
>;

type ParentView = { open: boolean; result: { state: 'idle' | 'loading' } | ReplyParentResult };
const idle: ParentView = { open: false, result: { state: 'idle' } };

/** One reading scope, shared by rows that reference the same parent. No reads during rendering. */
export class ReplyParentReader {
  private views = new Map<string, ParentView>();
  private pending = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<() => void>>();
  private generation = 0;
  private active = true;
  private retired = false;
  private managed = false;
  constructor(
    readonly threadId: string,
    private read: (parentId: string) => Promise<ReplyParentResult>,
    private scopeCurrent: () => boolean = () => true,
  ) {}
  /** A failed scope comparison is permanent, including an observed away/back transition. */
  current = () => {
    if (!this.retired && !this.scopeCurrent()) this.dispose();
    return this.active && !this.retired;
  };
  get = (parentId: string): ParentView => (this.current() ? (this.views.get(parentId) ?? idle) : idle);
  subscribe = (parentId: string, listener: () => void) => {
    const listeners = this.listeners.get(parentId) ?? new Set<() => void>();
    this.listeners.set(parentId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(parentId) === listeners) {
        this.listeners.delete(parentId);
        this.views.delete(parentId);
        this.pending.delete(parentId);
      }
    };
  };
  private set(parentId: string, view: ParentView) {
    this.views.set(parentId, view);
    for (const listener of this.listeners.get(parentId) ?? []) listener();
  }
  activate() {
    if (!this.retired && !this.managed) this.active = true;
    this.current();
  }
  private disconnect() {
    this.active = false;
    this.generation++;
    this.views.clear();
    this.pending.clear();
    for (const listeners of this.listeners.values()) for (const listener of listeners) listener();
  }
  /** Effect replay may reconnect, but never lends the previous connection's work to it. */
  connect() {
    this.managed = true;
    if (!this.retired) this.active = true;
    this.current();
    return () => this.disconnect();
  }
  dispose() {
    if (this.retired) return;
    this.retired = true;
    this.disconnect();
  }
  toggle(parentId: string) {
    if (!this.current()) return;
    const view = this.get(parentId);
    this.set(parentId, { ...view, open: !view.open });
    if (!view.open && view.result.state === 'idle') void this.load(parentId);
  }
  load(parentId: string): Promise<void> {
    if (!this.current()) return Promise.resolve();
    const pending = this.pending.get(parentId);
    if (pending) return pending;
    const generation = this.generation;
    const ownsRequest = (): boolean =>
      this.current() && generation === this.generation && this.pending.get(parentId) === request;
    const request: Promise<void> = Promise.resolve()
      .then(() => (ownsRequest() ? this.read(parentId) : undefined))
      .then(
        (result) => {
          if (!ownsRequest() || !result) return;
          // Keep the selected address exact even if a reader returns an unrelated response.
          const admitted =
            result.state === 'available' && (result.id !== parentId || result.threadId !== this.threadId)
              ? { state: 'unavailable' as const }
              : result;
          this.set(parentId, { open: this.get(parentId).open, result: admitted });
        },
        () => {
          if (ownsRequest()) this.set(parentId, { open: this.get(parentId).open, result: { state: 'unavailable' } });
        },
      )
      .finally(() => {
        if (this.pending.get(parentId) === request) this.pending.delete(parentId);
      });
    this.pending.set(parentId, request);
    this.set(parentId, { open: true, result: { state: 'loading' } });
    return request;
  }
}

/** Uses the page-native identity summary, without thumbnails or profile reads. */
function ParentAuthor({ author }: { author: PageAuthor | undefined }) {
  if (author?.state === 'deleted')
    return (
      <span>{author.kind === 'organization' ? m.thread_author_deleted_organization() : m.thread_author_deleted()}</span>
    );
  const name = author?.displayName || (author?.handle ? `@${author.handle}` : m.thread_author_unknown());
  return author?.handle ? (
    <a
      href={`/${getLocale()}/@${encodeURIComponent(author.handle)}`}
      className="min-w-0 rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      {name}
    </a>
  ) : (
    <span>{name}</span>
  );
}

/** A relationship summary uses only the current page's disclosed identities and documents. */
export function ReplyContext({
  parentId,
  parents,
  authors,
  reader,
}: {
  parentId: string | null;
  parents: ReplyParents;
  authors?: PageAuthors;
  reader?: ReplyParentReader | undefined;
}) {
  const navigation = useReplyParentNavigation();
  if (parentId === null) return null;
  const parent = parents.get(parentId);
  const label =
    parent?.availability === 'erased'
      ? m.thread_reply_parent_deleted()
      : parent?.availability === 'withheld'
        ? m.thread_reply_parent_unavailable()
        : m.thread_reply_parent();
  const disclosed = parent?.availability === 'available' && parent.body && authors !== undefined;
  const excerpt = disclosed ? replyParentExcerpt(parent.body!) : '';
  return (
    <div
      data-slot="reply-context"
      className="mb-3 min-w-0 space-y-2 text-sm text-muted-foreground [overflow-wrap:anywhere]"
    >
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <ReplyIcon aria-hidden="true" className="size-4 shrink-0 self-center" />
        {parent ? (
          <a
            href={`#post-${parent.id}`}
            className="inline-flex min-h-11 min-w-11 min-w-0 items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {label}
          </a>
        ) : (
          <span>{label}</span>
        )}
        {disclosed ? <ParentAuthor author={parent.authorId ? authors?.[parent.authorId] : undefined} /> : null}
      </p>
      {excerpt ? <p className="line-clamp-2 [overflow-wrap:anywhere]">{excerpt}</p> : null}
      {!parent && navigation ? (
        <a
          href={navigation.exactHref(parentId)}
          className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-md px-3 py-2 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.thread_branch_parent_destination()}
        </a>
      ) : null}
      {!parent && reader ? <OffPageParent key={parentId} parentId={parentId} reader={reader} /> : null}
    </div>
  );
}

function OffPageParent({ parentId, reader }: { parentId: string; reader: ReplyParentReader }) {
  const regionId = `reply-parent-${useId().replaceAll(':', '')}`;
  const subscribe = useCallback((listener: () => void) => reader.subscribe(parentId, listener), [reader, parentId]);
  const view = useSyncExternalStore(
    subscribe,
    () => reader.get(parentId),
    () => reader.get(parentId),
  );
  const { result, open } = view;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 text-left leading-snug whitespace-normal [overflow-wrap:anywhere]"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => reader.toggle(parentId)}
      >
        {open ? m.thread_reply_parent_close() : m.thread_reply_parent_view()}
      </Button>
      {open ? (
        <section id={regionId} aria-label={m.thread_reply_parent()} className="min-w-0 space-y-2 rounded-lg border p-3">
          {result.state === 'loading' ? <p role="status">{m.thread_reply_parent_loading()}</p> : null}
          {result.state === 'unavailable' ? (
            <>
              <p role="status">{m.thread_reply_parent_unavailable()}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 text-left leading-snug whitespace-normal [overflow-wrap:anywhere]"
                onClick={() => void reader.load(parentId)}
              >
                {m.exact_revision_retry()}
              </Button>
            </>
          ) : null}
          {result.state === 'available' ? (
            <>
              <p className="font-medium">
                <ParentAuthor author={result.author} />
              </p>
              {result.excerpt ? <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{result.excerpt}</p> : null}
              <p className="text-xs">
                {m.thread_history_licence()}: {result.licence}
              </p>
              {result.revisionId ? (
                <a
                  href={exactRevisionHref({ postId: result.id, revisionId: result.revisionId }, getLocale())}
                  className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {m.exact_revision_heading()}
                </a>
              ) : null}
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

export function ReplyButton({ disabled, onReply }: { disabled: boolean; onReply: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 text-left leading-snug whitespace-normal [overflow-wrap:anywhere]"
      disabled={disabled}
      onClick={onReply}
    >
      <ReplyIcon aria-hidden="true" />
      <span className="min-w-0">{m.thread_reply_to_post()}</span>
    </Button>
  );
}
