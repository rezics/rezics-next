import { m } from '../../paraglide/messages.js';
import { useSearchRetryWait } from '../../search/search-recovery-retry';
import { memberRetryAt } from './member-retry-admission';
import { useState } from 'react';

export type NativePageFailure = {
  status?: number | undefined;
  code?: string | undefined;
  retryAfter?: string | undefined;
  retryAt?: number | undefined;
};

/** Native status is the authority; preparation is never a successful empty page. */
export function nativePageState(failure: NativePageFailure) {
  if (failure.status === 202 || failure.code === 'presentation_not_ready') return 'preparing';
  if (failure.status === 204) return 'unrequested';
  if (failure.status === 401 || failure.status === 403) return 'denied';
  if (failure.status === 404) return 'missing';
  if (failure.status === 409) return 'changed';
  if (failure.status === 400 || failure.status === 422) return 'invalid';
  return 'unavailable';
}

/** One localized failure vocabulary for composed sections, with no producer details in the DOM. */
export function nativePageMessage(failure: NativePageFailure, locale: string): string {
  const o = { locale: locale as never };
  switch (nativePageState(failure)) {
    case 'preparing':
      return m.public_read_preparing({}, o);
    case 'denied':
      return m.public_read_denied({}, o);
    case 'missing':
      return m.not_found_heading({}, o);
    case 'changed':
      return m.subject_relation_changed({}, o);
    case 'invalid':
      return m.subject_relation_invalid({}, o);
    default:
      return m.subject_section_failed({}, o);
  }
}

const actionClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm px-2 py-2 text-primary underline underline-offset-4 whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Retry the original address explicitly; the native minimum delay only enables the action. */
export function PageReadState({
  failure,
  locale,
  href = '',
  describedBy,
}: {
  failure: NativePageFailure;
  locale: string;
  href?: string;
  describedBy?: string;
}) {
  // This component is keyed by its native reading, so rerenders never extend the deadline.
  const [retryAt] = useState(() => failure.retryAt ?? memberRetryAt(failure.retryAfter));
  const waiting = useSearchRetryWait(retryAt);
  const state = nativePageState(failure);
  if (state === 'unrequested') return null;
  return (
    <div data-page-read-state={state} data-response-status={failure.status} className="min-w-0 space-y-2">
      <p
        role={state === 'preparing' ? 'status' : 'alert'}
        className="text-sm text-muted-foreground [overflow-wrap:anywhere]"
      >
        {nativePageMessage(failure, locale)}
      </p>
      {waiting ? (
        <button type="button" disabled aria-describedby={describedBy} className={actionClass}>
          {m.subject_section_retry({}, { locale: locale as never })}
        </button>
      ) : (
        <a data-slot="retry" href={href} aria-describedby={describedBy} className={actionClass}>
          {m.subject_section_retry({}, { locale: locale as never })}
        </a>
      )}
    </div>
  );
}
