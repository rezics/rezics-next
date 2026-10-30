import { Button } from '@rezics/ui/shadcn/button';
import { ReplyIcon } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import type { ThreadPost } from './thread-page';

export type ReplyParents = ReadonlyMap<string, Pick<ThreadPost, 'id' | 'availability'>>;

/** A relationship summary has no shadcn equivalent. It uses only the current page's disclosed identities. */
export function ReplyContext({ parentId, parents }: { parentId: string | null; parents: ReplyParents }) {
  if (parentId === null) return null;
  const parent = parents.get(parentId);
  const label =
    parent?.availability === 'erased'
      ? m.thread_reply_parent_deleted()
      : parent?.availability === 'withheld'
        ? m.thread_reply_parent_unavailable()
        : m.thread_reply_parent();
  return (
    <p className="mb-3 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <ReplyIcon aria-hidden="true" className="size-4 shrink-0" />
      {parent ? (
        <a href={`#post-${parent.id}`} className="underline-offset-4 hover:underline">
          {label}
        </a>
      ) : (
        <span>{label}</span>
      )}
    </p>
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
