import type { MouseEventHandler } from 'react';
import { m } from '../../paraglide/messages.js';

/** A failed public text read stays distinct from a subject with no summary. Retry is a document link. */
export function SubjectReadingState({
  locale,
  href = '',
  onRetry,
}: {
  locale: string;
  href?: string;
  onRetry?: MouseEventHandler<HTMLAnchorElement>;
}) {
  return (
    <div
      data-slot="subject-text-unavailable"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground"
    >
      <p>{m.subject_section_failed({}, { locale: locale as never })}</p>
      <a href={href} onClick={onRetry} className="rounded-sm underline underline-offset-4 focus-visible:outline-2">
        {m.subject_section_retry({}, { locale: locale as never })}
      </a>
    </div>
  );
}
