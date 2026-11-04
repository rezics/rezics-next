import type { RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from './paraglide/messages.js';
import type { PasskeyEnrollmentHistory, PasskeyEnrollmentSnapshot } from './passkey-enrollment';

export function PasskeyEnrollmentView({
  state,
  reading,
  truncated,
  canReview,
  statusRef,
  check,
  finish,
}: {
  state: PasskeyEnrollmentSnapshot | null;
  reading: boolean;
  truncated: boolean;
  canReview: boolean;
  statusRef: RefObject<HTMLDivElement | null>;
  check: () => void;
  finish: () => void;
}) {
  if (!state) return null;
  const message =
    state.phase === 'options'
      ? m.auth_security_passkey_options_pending()
      : state.phase === 'prompt'
        ? m.auth_security_passkey_prompt_pending()
        : state.phase === 'saving'
          ? m.auth_security_passkey_registration_saving()
          : state.phase === 'confirmed'
            ? m.auth_security_passkey_registration_confirmed()
            : state.phase === 'reviewing'
              ? m.auth_security_passkey_registration_checking()
              : state.phase === 'reviewed'
                ? m.auth_security_passkey_registration_reviewed()
                : state.phase === 'changed-account'
                  ? m.auth_security_passkey_account_changed()
                  : m.auth_security_passkey_registration_unknown();

  return (
    <div className="auth-login-form" aria-busy={reading || state.phase === 'saving' || state.phase === 'reviewing'}>
      <div ref={statusRef} tabIndex={-1} role="status" data-passkey-enrollment-status>
        {message}
      </div>
      {state.phase === 'reviewed' && truncated ? <p>{m.auth_security_inventory_truncated()}</p> : null}
      {state.reviewRequired && canReview && state.phase !== 'changed-account' ? (
        <>
          <Button type="button" variant="outline" onClick={check} disabled={reading} aria-busy={reading}>
            {m.auth_security_passkey_check_current()}
          </Button>
          {state.phase === 'reviewed' ? (
            <Button type="button" variant="outline" onClick={finish}>
              {m.auth_security_passkey_registration_continue()}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function PasskeyEnrollmentHistoryView({
  history,
  statusRef,
  dismiss,
}: {
  history: PasskeyEnrollmentHistory | null;
  statusRef: RefObject<HTMLDivElement | null>;
  dismiss: () => void;
}) {
  if (!history) return null;
  return (
    <div className="auth-login-form" data-passkey-enrollment-history>
      <div ref={statusRef} tabIndex={-1} role="status">
        {history === 'acknowledged'
          ? m.auth_security_passkey_history_acknowledged()
          : m.auth_security_passkey_history_unknown()}
      </div>
      <Button type="button" variant="outline" onClick={dismiss}>
        {m.auth_security_passkey_dismiss_history()}
      </Button>
    </div>
  );
}
