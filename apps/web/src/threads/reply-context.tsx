import { Button } from '@rezics/ui/shadcn/button';
import { ReplyIcon } from 'lucide-react';
import { useCallback, useId, useSyncExternalStore } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { PageAuthor, PageAuthors } from '../identity/read';
import { exactRevisionHref } from './exact-revision-href';
import { replyParentExcerpt, type ReplyParentResult } from './reply-parent-read';
import type { ThreadPost } from './thread-page';

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
  constructor(
    readonly threadId: string,
    private read: (parentId: string) => Promise<ReplyParentResult>,
  ) {}
  get = (parentId: string): ParentView => this.views.get(parentId) ?? idle;
  subscribe = (parentId: string, listener: () => void) => {
    const listeners = this.listeners.get(parentId) ?? new Set<() => void>();
    this.listeners.set(parentId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
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
    this.active = true;
  }
  dispose() {
    this.active = false;
    this.generation++;
    this.views.clear();
    this.pending.clear();
  }
  toggle(parentId: string) {
    if (!this.active) return;
    const view = this.get(parentId);
    this.set(parentId, { ...view, open: !view.open });
    if (!view.open && view.result.state === 'idle') void this.load(parentId);
  }
  load(parentId: string): Promise<void> {
    if (!this.active) return Promise.resolve();
    const pending = this.pending.get(parentId);
    if (pending) return pending;
    const generation = this.generation;
    this.set(parentId, { open: true, result: { state: 'loading' } });
    const request = Promise.resolve()
      .then(() => this.read(parentId))
      .then(
        (result) => {
          if (!this.active || generation !== this.generation || this.pending.get(parentId) !== request) return;
          // Keep the selected address exact even if a reader returns an unrelated response.
          const admitted =
            result.state === 'available' && (result.id !== parentId || result.threadId !== this.threadId)
              ? { state: 'unavailable' as const }
              : result;
          this.set(parentId, { open: this.get(parentId).open, result: admitted });
        },
        () => {
          if (this.active && generation === this.generation && this.pending.get(parentId) === request)
            this.set(parentId, { open: this.get(parentId).open, result: { state: 'unavailable' } });
        },
      )
      .finally(() => {
        if (this.pending.get(parentId) === request) this.pending.delete(parentId);
      });
    this.pending.set(parentId, request);
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
    <a href={`/${getLocale()}/@${encodeURIComponent(author.handle)}`} className="underline-offset-4 hover:underline">
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
    <div data-slot="reply-context" className="mb-3 min-w-0 space-y-2 text-sm text-muted-foreground">
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <ReplyIcon aria-hidden="true" className="size-4 shrink-0 self-center" />
        {parent ? (
          <a href={`#post-${parent.id}`} className="underline-offset-4 hover:underline">
            {label}
          </a>
        ) : (
          <span>{label}</span>
        )}
        {disclosed ? <ParentAuthor author={parent.authorId ? authors?.[parent.authorId] : undefined} /> : null}
      </p>
      {excerpt ? <p className="line-clamp-2 [overflow-wrap:anywhere]">{excerpt}</p> : null}
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
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => reader.toggle(parentId)}
      >
        {open ? m.thread_reply_parent_close() : m.thread_reply_parent_view()}
      </Button>
      {open ? (
        <section id={regionId} aria-label={m.thread_reply_parent()} className="space-y-2 rounded-lg border p-3">
          {result.state === 'loading' ? <p role="status">{m.thread_reply_parent_loading()}</p> : null}
          {result.state === 'unavailable' ? (
            <>
              <p role="status">{m.thread_reply_parent_unavailable()}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => void reader.load(parentId)}>
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
                  className="inline-flex min-h-11 items-center underline underline-offset-4"
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
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onReply}>
      <ReplyIcon aria-hidden="true" />
      {m.thread_reply_to_post()}
    </Button>
  );
}
