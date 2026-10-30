import { Tombstone } from '@rezics/ui/tombstone';
import { Withheld } from '@rezics/ui/withheld';
import { Button } from '@rezics/ui/shadcn/button';
import { Menu } from '@rezics/ui/menu';
import { EllipsisIcon } from 'lucide-react';
import type { Ref } from 'react';
import { m } from '../paraglide/messages.js';
import type { PageAuthors } from '../identity/read';
import { Byline } from './byline';
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
  onCopyLink,
  onRestore,
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
  onCopyLink: () => void | Promise<void>;
  onRestore?: () => void;
}) {
  const authorId = 'authorId' in post ? post.authorId : undefined;
  const author = authorId ? authors?.[authorId] : undefined;
  const canRestorePost = post.availability === 'erased' && 'restorableUntil' in post && Boolean(post.restorableUntil);
  const owner = (viewerId !== undefined && authorId === viewerId) || canRestorePost;
  const common = {
    id: anchorId,
    ref: itemRef,
    tabIndex: -1 as const,
    className: 'scroll-mt-24 py-5 target:bg-muted/50',
    style: minHeight === undefined ? undefined : { minHeight },
  };

  if (post.availability === 'withheld') {
    return (
      <li {...common}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <Byline
            author={author}
            createdAt={post.createdAt}
            now={now}
            showAuthor={authors !== null}
            className="min-h-8 flex-1"
          />
        </div>
        <Withheld shape="passage" labels={{ withheld: m.thread_post_withheld() }} />
        {owner && post.decisionId ? (
          <a
            className="mt-3 inline-block underline-offset-4 hover:underline"
            href={`/moderation/decisions/${encodeURIComponent(post.decisionId)}`}
          >
            {m.thread_post_decision_link()}
          </a>
        ) : null}
      </li>
    );
  }

  const deleted = post.availability === 'erased' || ('removed' in post && post.removed === true);
  const reason = deleted ? 'deleted' : 'unavailable';
  const restorableUntil = owner && deleted && 'restorableUntil' in post ? post.restorableUntil : undefined;
  return (
    <li {...common}>
      <div className="relative">
        <Tombstone
          shape="post"
          reason={reason}
          {...(restorableUntil && onRestore ? { restoreUntil: restorableUntil, onRestore } : {})}
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
                <Button aria-label={m.thread_content_more_actions()} ref={menuButton} size="icon-sm" variant="ghost">
                  <EllipsisIcon aria-hidden="true" />
                </Button>
              }
              entries={[{ type: 'item', label: m.thread_content_copy_link(), onSelect: onCopyLink }]}
            />
          </div>
        ) : null}
      </div>
      {restoreError ? (
        <p className="mt-3 text-sm text-destructive" role="alert">
          {restoreError}
        </p>
      ) : null}
    </li>
  );
}
