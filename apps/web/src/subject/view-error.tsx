import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { Link, useLocation, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import { m } from '../paraglide/messages.js';

const actionClass = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words px-4 py-3 text-center';

type SubjectViewRecoveryRouter = {
  invalidate: () => Promise<unknown>;
  state: { location: object; matches: readonly { status: string }[] };
};

export function createSubjectViewRecovery() {
  let active: { visit: object; promise: Promise<void> } | null = null;
  return (router: SubjectViewRecoveryRouter, visit: object, reset: () => void) => {
    if (active?.visit === visit) return active.promise;
    let attempt: { visit: object; promise: Promise<void> };
    const promise = Promise.resolve()
      .then(() => router.invalidate())
      .then(() => {
        if (router.state.location === visit && router.state.matches.every((match) => match.status === 'success'))
          reset();
      })
      .finally(() => {
        if (active === attempt) active = null;
      });
    attempt = { visit, promise };
    active = attempt;
    return promise;
  };
}

/** Restart requests a new authorized first page; it supplies no successful read or permission. */
export function SubjectViewError({ reset }: ErrorComponentProps) {
  const location = useLocation();
  const router = useRouter();
  const headingId = useId();
  const recovery = useRef<ReturnType<typeof createSubjectViewRecovery> | null>(null);
  const [retryingVisit, setRetryingVisit] = useState<object | null>(null);
  recovery.current ??= createSubjectViewRecovery();
  const retrying = retryingVisit === location;
  const retry = async () => {
    const visit = location;
    setRetryingVisit(visit);
    try {
      await recovery.current!(router, visit, reset);
    } catch {
      // Keep failures unavailable and retryable without exposing their causes.
    } finally {
      setRetryingVisit((current) => (current === visit ? null : current));
    }
  };
  return (
    <article aria-labelledby={headingId} className="mx-auto w-full max-w-2xl space-y-6 px-6 py-12">
      <h1 id={headingId} className="text-2xl font-semibold text-balance break-words">
        {m.subject_view_unavailable()}
      </h1>
      <div className="flex flex-wrap items-center gap-3">
        {/* Keep the action label stable while disabled, avoiding new locale copy for pending state. */}
        <Button
          type="button"
          onClick={() => void retry()}
          disabled={retrying}
          aria-busy={retrying}
          className={actionClass}
        >
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
