import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

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
  'inline-flex min-h-10 items-center rounded-lg px-4 font-medium text-primary underline-offset-4 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring';
const currentClass = 'bg-muted text-foreground';

// Plain links, one address per sort, so the control works without JavaScript. Changing the sort drops the cursor.
export function BoardSortNav({ boardId, sort }: { boardId: string; sort: BoardSort }) {
  const base = `/${getLocale()}/boards/${boardId}`;
  return (
    <nav aria-label={m.board_sort_label()} className="flex flex-wrap gap-1">
      {boardSorts.map((option) => (
        <a
          key={option}
          href={option === 'active' ? base : `${base}?sort=${option}`}
          aria-current={option === sort ? 'page' : undefined}
          className={option === sort ? `${linkClass} ${currentClass}` : linkClass}
        >
          {label(option)}
        </a>
      ))}
    </nav>
  );
}
