import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Link, useLocation, type ErrorComponentProps } from '@tanstack/react-router';
import { cn } from 'cn';
import { useId } from 'react';
import { m } from '../paraglide/messages.js';

const actionClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-3 text-center';

/** Restart requests a new authorized first page; it supplies no successful read or permission. */
export function SubjectViewError({ error, reset }: ErrorComponentProps) {
  const location = useLocation();
  const headingId = useId();
  return (
    <article aria-labelledby={headingId} className="mx-auto w-full max-w-2xl space-y-6 px-6 py-12">
      <h1 id={headingId} className="text-2xl font-semibold text-balance break-words">
        {error instanceof Error && error.message === 'dependency_unavailable'
          ? m.subject_view_changed()
          : m.subject_view_unavailable()}
      </h1>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={reset} className={actionClass}>
          {m.subject_view_retry()}
        </Button>
        <Link
          to={location.pathname}
          search={(previous) => {
            const next = { ...previous };
            delete next.cursor;
            return next;
          }}
          hash={location.hash}
          className={cn(buttonVariants({ variant: 'outline' }), actionClass)}
        >
          {m.subject_view_restart()}
        </Link>
      </div>
    </article>
  );
}
