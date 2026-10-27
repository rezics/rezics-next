import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { m } from '../paraglide/messages.js';
import type { BoardRealm } from './board-context';

const linkClass = 'rounded-sm hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring';

/** The quiet line above a page title: the Realm, then the board, each linked to its page. */
export function BoardContext({
  realm,
  board,
}: {
  realm?: BoardRealm | undefined;
  board?: { id: string; title: string | null } | undefined;
}) {
  if (!realm && !board) return null;
  return (
    <nav
      aria-label={m.board_context_label()}
      className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground"
    >
      {realm ? (
        <Link to="/realms/$id" params={{ id: realm.id }} className={linkClass}>
          {realm.title}
        </Link>
      ) : null}
      {realm && board ? <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      {board ? (
        <Link to="/boards/$id" params={{ id: board.id }} className={linkClass}>
          {board.title ?? m.threads_untitled()}
        </Link>
      ) : null}
    </nav>
  );
}
