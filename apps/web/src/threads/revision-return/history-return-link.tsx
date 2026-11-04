import { Link } from '@tanstack/react-router';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { markHistoryReturnCommand, type HistoryReturnTarget } from './history-return';

export function HistoryReturnLink({
  target,
  revisionId,
  className,
}: {
  target: HistoryReturnTarget;
  revisionId: string;
  className: string;
}) {
  return (
    <Link
      to="/threads/$id_/$slug"
      params={{ id: target.threadId, slug: target.slug }}
      search={{
        ...(target.threadCursor !== undefined ? { cursor: target.threadCursor } : {}),
        post: target.postId,
        historyReturn: target.token,
        historyRevision: revisionId,
      }}
      hash={`post-${encodeURIComponent(target.postId)}`}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!markHistoryReturnCommand(target, revisionId, true)) event.preventDefault();
      }}
      className={className}
    >
      {m.revision_return_to_history()}
    </Link>
  );
}

export function ExactRevisionInHistoryButton({
  onOpen,
  className,
}: {
  onOpen: () => void;
  className: string;
}) {
  return (
    <Button type="button" variant="ghost" onClick={onOpen} className={className}>
      {m.revision_return_open_here()}
    </Button>
  );
}
