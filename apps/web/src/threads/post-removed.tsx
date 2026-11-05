import { Tombstone } from '@rezics/ui/tombstone';
import { Withheld } from '@rezics/ui/withheld';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { EllipsisIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { m } from '../paraglide/messages.js';
import type { PageAuthors } from '../identity/read';
import { Byline } from './byline';
import { ExistingReviewNotice } from './write-prompts';
import type { ThreadPost } from './reads';

export function RemovedPost({
  post,
  authors,
  now,
  viewerId,
  anchorId,
  itemRef,
  menuButton,
  minHeight,
  restoreError,
  existingReviewId,
  deadlineUnknown = false,
  restored = false,
  onRefresh,
  onCopyLink,
  onRestore,
  children,
}: {
  post: ThreadPost;
  authors: PageAuthors;
  now: string;
  viewerId?: string;
  anchorId: string;
  itemRef: Ref<HTMLLIElement>;
  menuButton: Ref<HTMLButtonElement>;
  minHeight?: number | undefined;
  restoreError?: string | undefined;
  existingReviewId?: string | undefined;
  deadlineUnknown?: boolean;
  restored?: boolean;
  onRefresh?: () => void;
  onCopyLink: () => void | Promise<void>;
  onRestore?: () => void;
  children?: ReactNode;
}) {
  const authorId = 'authorId' in post ? post.authorId : undefined;
  const author = authorId === undefined ? undefined : authors?.[authorId];
  const erasedPost = post.availability === 'erased';
  const deleted = erasedPost || ('removed' in post && post.removed === true);
  const restorableUntil = 'restorableUntil' in post ? post.restorableUntil : undefined;
  const owner = viewerId !== undefined && (authorId === viewerId || Boolean(restorableUntil) || deadlineUnknown);
  const common = {
    id: anchorId,
    ref: itemRef,
    tabIndex: -1 as const,
    className:
      'min-w-0 scroll-mt-24 [overflow-wrap:anywhere] target:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    style: minHeight === undefined ? undefined : { minHeight },
  };

  if (post.availability === 'withheld') {
    return (
      <li {...common}>
        <ContentItemFrame as="div" data-slot="content-item-frame" className="min-w-0 rounded-xl px-4 py-5 sm:px-6">
          {'createdAt' in post && typeof post.createdAt === 'string' ? (
            <div className="mb-3 flex items-start justify-between gap-3">
              <Byline
                author={author}
                createdAt={post.createdAt}
                now={now}
                showAuthor={authors !== null && authorId !== undefined}
                className="min-h-8 flex-1"
              />
            </div>
          ) : null}
          {children}
          <Withheld shape="passage" labels={{ withheld: m.thread_post_withheld() }} />
          {owner && 'decisionId' in post && typeof post.decisionId === 'string' && post.decisionId ? (
            <a
              className="mt-3 inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm py-2 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              href={`/moderation/decisions/${encodeURIComponent(post.decisionId)}`}
            >
              {m.thread_post_decision_link()}
            </a>
          ) : null}
        </ContentItemFrame>
      </li>
    );
  }

  const reason = deleted && !restored ? 'deleted' : 'unavailable';
  const ownedRestorableUntil = owner && deleted && !restored ? restorableUntil : undefined;
  return (
    <li {...common}>
      <ContentItemFrame as="div" data-slot="content-item-frame" className="min-w-0 rounded-xl px-4 py-5 sm:px-6">
        {children}
        <div className="relative">
          <Tombstone
            shape="post"
            reason={reason}
            className="pr-16 [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:py-2 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-offset-2 [&_button:focus-visible]:outline-ring [&_time]:min-w-0 [&_time]:max-w-full"
            {...(ownedRestorableUntil && onRestore ? { restoreUntil: ownedRestorableUntil, onRestore } : {})}
            labels={{
              unavailable: m.thread_post_unavailable(),
              deleted: m.thread_post_deleted(),
              restore: m.thread_post_restore(),
              restoreUntil: (relative) => m.thread_post_restore_until({ relative }),
            }}
          />
          {owner && deleted ? (
            <div className="absolute right-2 top-2">
              <Menu
                title={m.thread_content_more_actions()}
                backLabel={m.thread_delete_cancel()}
                trigger={
                  <Button
                    aria-label={m.thread_content_more_actions()}
                    ref={menuButton}
                    size="icon-sm"
                    variant="ghost"
                    className="size-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <EllipsisIcon aria-hidden="true" />
                  </Button>
                }
                entries={[{ type: 'item', label: m.thread_content_copy_link(), onSelect: onCopyLink }]}
              />
            </div>
          ) : null}
        </div>
        {deadlineUnknown ? (
          <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <p>{m.thread_post_restore_deadline_unknown()}</p>
            {onRestore ? (
              <Button
                variant="outline"
                size="sm"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={onRestore}
              >
                {m.thread_post_restore()}
              </Button>
            ) : null}
          </div>
        ) : null}
        {restoreError ? (
          <div className="mt-3 space-y-2 text-sm" role="alert">
            <p className="text-destructive">{restoreError}</p>
            {existingReviewId ? <ExistingReviewNotice reviewId={existingReviewId} /> : null}
            {onRefresh ? (
              <Button
                variant="outline"
                size="sm"
                className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                onClick={onRefresh}
              >
                {m.thread_post_refresh()}
              </Button>
            ) : null}
          </div>
        ) : null}
      </ContentItemFrame>
    </li>
  );
}
