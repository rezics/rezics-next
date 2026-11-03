import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import type { CreatedPost, WriteFailure } from './actions';
import { PostComposer } from './composer';
import { ReplyContext, type ReplyParents } from './reply-context';
import type { ReplyCommand } from './reply-context-intent';

export function ThreadReplyComposer({
  parentId,
  parents,
  pending,
  onCancel,
  canSubmit = true,
  ...composer
}: {
  parentId: string | null;
  parents: ReplyParents;
  pending: boolean;
  onCancel: () => void;
  initialKey: string;
  canSubmit?: boolean;
  containerId: string;
  boardId?: string;
  focusRequest: number;
  onPendingChange: (pending: boolean) => void;
  onSubmit: (input: ReplyCommand) => Promise<{ ok: true; value: CreatedPost } | WriteFailure>;
  onSuccess: (post: CreatedPost) => void;
}) {
  return (
    <PostComposer<CreatedPost>
      {...composer}
      canSubmit={canSubmit}
      replyTargetId={parentId}
      replyContext={
        parentId === null || !canSubmit ? null : (
          <div className="mb-3 flex min-w-0 flex-wrap items-start gap-2" role="status" aria-atomic="true">
            <div className="min-w-0 flex-1 basis-48">
              <ReplyContext parentId={parentId} parents={parents} />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto min-h-11 min-w-11 max-w-full shrink px-3 py-2 text-left leading-snug whitespace-normal [overflow-wrap:anywhere]"
              disabled={pending}
              onClick={onCancel}
            >
              {m.thread_reply_cancel_target()}
            </Button>
          </div>
        )
      }
    />
  );
}
