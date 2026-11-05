import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { m } from '../paraglide/messages.js';
import type { BoardRealm } from './board-context';
import { admittedBoardReturn, boardReturnMatches } from './board-navigation';
import { getLocale } from '../paraglide/runtime.js';
import { initials } from './initials';

const linkClass =
  'inline-flex h-auto min-h-11 min-w-11 max-w-full items-center rounded-sm px-2 py-2.5 whitespace-normal [overflow-wrap:anywhere] hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** The quiet line above a page title: the Realm, then the board, each linked to its page. */
export function BoardContext({
  realm,
  board,
  prominent = false,
  boardReturn,
}: {
  realm?: BoardRealm | undefined;
  board?: { id: string; title: string | null } | undefined;
  prominent?: boolean;
  boardReturn?: string | undefined;
}) {
  if (!realm && !board) return null;
  const origin = admittedBoardReturn(boardReturn);
  const boardHref = origin && boardReturnMatches(origin, board?.id, getLocale()) ? origin : undefined;
  return (
    <nav
      aria-label={m.board_context_label()}
      className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground"
    >
      {prominent ? (
        <Avatar aria-hidden="true" size="sm">
          <AvatarFallback>{initials(realm?.title ?? board?.title ?? '')}</AvatarFallback>
        </Avatar>
      ) : null}
      {realm ? (
        <Link to="/realms/$id" params={{ id: realm.id }} className={linkClass}>
          <span className="min-w-0">{realm.title}</span>
        </Link>
      ) : null}
      {realm && board ? <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      {board && boardHref ? (
        <a href={boardHref} className={linkClass}>
          <span className="min-w-0">{board.title ?? m.threads_untitled()}</span>
        </a>
      ) : board ? (
        <Link to="/boards/$id" params={{ id: board.id }} className={linkClass}>
          <span className="min-w-0">{board.title ?? m.threads_untitled()}</span>
        </Link>
      ) : null}
    </nav>
  );
}
