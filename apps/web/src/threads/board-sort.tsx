import { m } from '../paraglide/messages.js';
import { Link } from '@tanstack/react-router';

export type BoardSort = 'active' | 'hot' | 'new';
export const boardSorts: readonly BoardSort[] = ['active', 'hot', 'new'];

// Active is the default and has no parameter; anything unknown falls back to it.
export function boardSortFromSearch(value: unknown): 'hot' | 'new' | undefined {
  return value === 'hot' || value === 'new' ? value : undefined;
}

function label(sort: BoardSort): string {
  return sort === 'hot' ? m.board_sort_hot() : sort === 'new' ? m.board_sort_new() : m.board_sort_active();
}

const linkClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-lg px-4 py-2 text-start whitespace-normal font-medium text-primary underline-offset-4 [overflow-wrap:anywhere] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring';
const currentClass = 'bg-muted text-foreground';

// Plain links, one address per sort, so the control works without JavaScript. Changing the sort drops the cursor.
export function BoardSortNav({
  boardId,
  sort,
  returnTo,
}: {
  boardId: string;
  sort: BoardSort;
  returnTo?: string | undefined;
}) {
  return (
    <nav aria-label={m.board_sort_label()} className="flex min-w-0 max-w-full flex-wrap gap-1">
      {boardSorts.map((option) => (
        <Link
          key={option}
          to="/boards/$id"
          params={{ id: boardId }}
          search={{ ...(option === 'active' ? {} : { sort: option }), ...(returnTo ? { returnTo } : {}) }}
          aria-current={option === sort ? 'page' : undefined}
          className={option === sort ? `${linkClass} ${currentClass}` : linkClass}
        >
          {label(option)}
        </Link>
      ))}
    </nav>
  );
}
