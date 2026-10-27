import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@rezics/ui/shadcn/breadcrumb';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import type { BoardRealm } from './board-context';

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
    <Breadcrumb aria-label={m.board_context_label()}>
      <BreadcrumbList className="gap-1.5 sm:gap-1.5">
        {realm ? (
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/realms/$id" params={{ id: realm.id }} />} className="hover:underline">
              {realm.title}
            </BreadcrumbLink>
          </BreadcrumbItem>
        ) : null}
        {realm && board ? <BreadcrumbSeparator /> : null}
        {board ? (
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/boards/$id" params={{ id: board.id }} />} className="hover:underline">
              {board.title ?? m.threads_untitled()}
            </BreadcrumbLink>
          </BreadcrumbItem>
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
