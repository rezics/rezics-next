import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
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

const sortLinkClass = 'h-auto min-h-6 max-w-full whitespace-normal';

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
    <nav
      aria-label={m.board_sort_label()}
      className="flex min-w-0 max-w-full flex-wrap items-center gap-1 rounded-xl bg-muted/50 p-1"
    >
      {boardSorts.map((option) => (
        <Link
          key={option}
          to="/boards/$id"
          params={{ id: boardId }}
          search={{ ...(option === 'active' ? {} : { sort: option }), ...(returnTo ? { returnTo } : {}) }}
          aria-current={option === sort ? 'page' : undefined}
          className={cn(buttonVariants({ variant: option === sort ? 'secondary' : 'ghost', size: 'sm' }), sortLinkClass)}
        >
          {label(option)}
        </Link>
      ))}
    </nav>
  );
}
