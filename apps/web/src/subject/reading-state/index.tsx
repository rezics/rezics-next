import type { MouseEventHandler } from 'react';
import { m } from '../../paraglide/messages.js';

export type SubjectTextRetryToken<Target extends object> = { target: Target };

/** Tracks one retry for the current page visit and invalidates results after its target changes. */
export function createSubjectTextRetryController<Target extends object>() {
  let selected: Target | null = null;
  let pending: SubjectTextRetryToken<Target> | null = null;

  return {
    select(target: Target | null) {
      selected = target;
    },
    begin(target: Target): SubjectTextRetryToken<Target> | null {
      if (selected !== target || pending) return null;
      return (pending = { target });
    },
    isCurrent(token: SubjectTextRetryToken<Target>) {
      return selected === token.target && pending === token;
    },
    finish(token: SubjectTextRetryToken<Target>) {
      if (pending === token) pending = null;
    },
  };
}

/** A failed public text read stays distinct from a subject with no summary. The document link remains a fallback. */
export function SubjectReadingState({
  locale,
  href = '',
  onRetry,
  busy = false,
  message,
  retryLabel,
}: {
  locale: string;
  href?: string;
  onRetry?: MouseEventHandler<HTMLAnchorElement> | undefined;
  busy?: boolean;
  /** Optional copy for a concrete reading state; existing callers keep the section defaults. */
  message?: string | undefined;
  retryLabel?: string | undefined;
}) {
  return (
    <div
      data-slot="subject-text-unavailable"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground"
    >
      <p>{message ?? m.subject_section_failed({}, { locale: locale as never })}</p>
      <a
        href={href}
        onClick={onRetry}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        className="rounded-sm underline underline-offset-4 focus-visible:outline-2"
      >
        {retryLabel ?? m.subject_section_retry({}, { locale: locale as never })}
      </a>
    </div>
  );
}
