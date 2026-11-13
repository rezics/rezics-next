import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { HostedBookStartState } from './hosted-book-start';

/** Compact action stays outside the disabled document controls so an uncertain intent can be retried. */
export function HostedBookStartAction({
  state,
  eligible,
  start,
  retry,
}: {
  state: HostedBookStartState;
  eligible: boolean;
  start: () => Promise<void>;
  retry: () => Promise<void>;
}) {
  const locale = getLocale();
  if (state.kind === 'idle' && !eligible) return null;
  return (
    <section className="studio-stack" aria-label={m.studio_book_start_label({}, { locale })}>
      <div className="studio-action-row">
        {eligible && (state.kind === 'idle' || (state.kind === 'failed' && !state.retryable)) ? (
          <Button type="button" variant="outline" onClick={() => void start()}>
            {m.studio_book_start_label({}, { locale })}
          </Button>
        ) : null}
        {state.kind === 'failed' && state.retryable ? (
          <Button type="button" variant="outline" onClick={() => void retry()}>
            {m.studio_book_start_retry({}, { locale })}
          </Button>
        ) : null}
        <p className="studio-help">{m.studio_book_start_help({}, { locale })}</p>
      </div>
      {state.kind === 'creating' || state.kind === 'confirming' || state.kind === 'ready' ? (
        <p role="status">
          {state.kind === 'creating'
            ? m.studio_book_start_creating({}, { locale })
            : m.studio_book_start_confirming({}, { locale })}
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p role="alert">
          {state.retryable ? m.studio_book_start_uncertain({}, { locale }) : m.studio_book_start_failed({}, { locale })}
        </p>
      ) : null}
      {state.kind === 'ended' ? <p role="status">{m.studio_book_start_ended({}, { locale })}</p> : null}
    </section>
  );
}
