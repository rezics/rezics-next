import type { RefObject } from 'react';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { m } from './paraglide/messages.js';
import type { StepUpHistory, StepUpReturnState } from './step-up-return';

export function StepUpHistoryNotice({ history }: { history: StepUpHistory }) {
  const message =
    history === 'unknown'
      ? m.auth_step_up_return_unknown()
      : history === 'acknowledged'
        ? m.auth_step_up_return_acknowledged()
        : history === 'refused'
          ? m.auth_step_up_return_refused()
          : m.auth_step_up_return_unsent();
  return <p role="status">{message}</p>;
}

export function StepUpReturnView({
  history,
  review,
  canAuthenticate,
  continuing,
  statusRef,
  alertRef,
  onRetry,
  onContinue,
  onAuthenticate,
}: {
  history: StepUpHistory;
  review: StepUpReturnState;
  canAuthenticate: boolean;
  continuing: boolean;
  statusRef: RefObject<HTMLParagraphElement | null>;
  alertRef: RefObject<HTMLDivElement | null>;
  onRetry: () => void;
  onContinue: () => void;
  onAuthenticate: () => void;
}) {
  return (
    <section className="auth-login-form" aria-label={m.auth_step_up_return_heading()}>
      <StepUpHistoryNotice history={history} />
      <p ref={statusRef} role="status" tabIndex={-1} aria-live="polite">
        {review.kind === 'checking'
          ? m.auth_step_up_return_pending()
          : review.kind === 'continue'
            ? m.auth_step_up_return_ready()
            : review.kind === 'none'
              ? m.auth_step_up_return_no_continue()
              : ''}
      </p>
      {review.kind === 'unavailable' ? <ErrorAlert tabIndex={-1} ref={alertRef}>{m.auth_failure_unavailable()}</ErrorAlert> : null}
      {review.kind === 'changed' ? <ErrorAlert tabIndex={-1} ref={alertRef}>{m.auth_step_up_continuation_changed()}</ErrorAlert> : null}
      {review.kind === 'account-changed' ? <ErrorAlert tabIndex={-1} ref={alertRef}>{m.auth_step_up_account_changed()}</ErrorAlert> : null}
      {review.kind === 'continue' ? (
        <Button type="button" disabled={continuing} aria-busy={continuing} onClick={onContinue}>
          {m.auth_step_up_return_continue()}
        </Button>
      ) : null}
      {canAuthenticate ? (
        <Button type="button" variant="outline" disabled={review.kind === 'checking'} onClick={onAuthenticate}>
          {m.auth_step_up_return_start()}
        </Button>
      ) : null}
      {review.kind !== 'checking' ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          {m.auth_login_retry()}
        </Button>
      ) : null}
      <a className="auth-link" href="/security">
        {m.auth_step_up_return_exit()}
      </a>
    </section>
  );
}
