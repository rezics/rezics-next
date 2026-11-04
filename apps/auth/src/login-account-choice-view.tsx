import { useLayoutEffect, useRef } from 'react';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { m } from './paraglide/messages.js';
import { loginCanContinue, type LoginAccountChoice } from './login-account-choice';

/** The real route and its mounted stories share the same private account presentation. */
export function LoginAccountChoiceView({
  choice,
  pending,
  passkeyPending,
  onContinue,
  onSwitch,
  onReview,
  allowContinue = true,
}: {
  choice: LoginAccountChoice;
  pending: boolean;
  passkeyPending: boolean;
  onContinue: () => void;
  onSwitch: () => void;
  onReview: () => void;
  allowContinue?: boolean;
}) {
  const status = useRef<HTMLDivElement>(null);
  const uncertain = choice.kind === 'ready' ? choice.uncertain : choice.review.uncertain;
  useLayoutEffect(() => {
    if (
      choice.kind !== 'loading' &&
      (choice.kind !== 'ready' || choice.observation !== 'initial' || choice.mode === 'credentials')
    )
      status.current?.focus();
  }, [choice]);
  const viewer =
    choice.kind === 'ready' && choice.mode === 'current' && choice.page.viewer.kind === 'signed-in'
      ? choice.page.viewer
      : null;
  return (
    <section
      className="auth-login-form"
      aria-label={m.auth_login_heading()}
      aria-busy={pending || choice.kind === 'loading'}
    >
      <div ref={status} tabIndex={-1} role="status">
        {uncertain ? <p>{m.auth_login_uncertain()}</p> : null}
        {choice.kind === 'loading' ? <p>{m.auth_inventory_loading()}</p> : null}
        {choice.kind === 'ready' && choice.observation === 'changed' ? <p>{m.auth_login_viewer_changed()}</p> : null}
        {choice.kind === 'ready' && choice.observation === 'signed-out' ? (
          <p>{m.auth_login_review_signed_out()}</p>
        ) : null}
        {choice.kind === 'ready' && choice.observation === 'reviewed' ? <p>{m.auth_login_reviewed()}</p> : null}
        {viewer ? (
          <p>{m.auth_login_current_account({ account: viewer.email ?? m.auth_security_rezics_account() })}</p>
        ) : null}
        {choice.kind === 'ready' && choice.mode === 'credentials' && choice.page.viewer.kind === 'signed-in' ? (
          <p>{m.auth_login_switching()}</p>
        ) : null}
        {choice.kind === 'ready' && choice.page.continuation.requires_sign_in ? (
          <p>{m.auth_login_sign_in_required()}</p>
        ) : null}
        {pending ? <p>{passkeyPending ? m.auth_login_pending_passkey() : m.auth_login_pending_password()}</p> : null}
      </div>
      {choice.kind === 'unavailable' ? <ErrorAlert>{m.auth_login_page_unavailable()}</ErrorAlert> : null}
      {allowContinue && loginCanContinue(choice) ? (
        <Button type="button" disabled={pending} onClick={onContinue}>
          {m.auth_login_continue()}
        </Button>
      ) : null}
      {viewer ? (
        <Button type="button" variant="outline" disabled={pending} onClick={onSwitch}>
          {m.auth_login_switch_account()}
        </Button>
      ) : null}
      {choice.kind !== 'loading' ? (
        <Button type="button" variant="outline" disabled={pending} onClick={onReview}>
          {choice.kind === 'unavailable' ? m.auth_login_page_retry() : m.auth_login_review_session()}
        </Button>
      ) : null}
    </section>
  );
}
