import { useLayoutEffect, useRef } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { SecurityAdvice } from './security-inventory';
import type { PasswordChangeReturnHistory } from './password-change-return';

type Props = {
  history: PasswordChangeReturnHistory;
  acknowledged: boolean;
  reading: boolean;
  canReview: boolean;
  canStartNew: boolean;
  advice: SecurityAdvice | undefined;
  onReview: () => void;
  onAcknowledge: () => void;
};

function interrupted(phase: PasswordChangeReturnHistory['unknownPhase']) {
  if (phase === 'stage') return m.auth_security_password_return_stage();
  if (phase === 'approve') return m.auth_security_password_return_approval();
  if (phase === 'apply') return m.auth_security_password_return_apply();
  return m.auth_security_password_changed();
}

export function PasswordChangeReturnView({
  history,
  acknowledged,
  reading,
  canReview,
  canStartNew,
  advice,
  onReview,
  onAcknowledge,
}: Props) {
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    status.current?.focus();
  }, [history.unknownPhase, history.applicationConfirmed, reading]);

  return (
    <section className="auth-login-form" aria-labelledby="security-password-return-heading">
      <h2 id="security-password-return-heading">{m.auth_security_password_return_heading()}</h2>
      <div ref={status} tabIndex={-1} role="status" data-password-return-status>
        <p>{interrupted(history.unknownPhase)}</p>
        {history.unknownPhase && history.applicationConfirmed ? (
          <p>{m.auth_security_password_return_applied_after_unknown()}</p>
        ) : null}
        <p className="auth-security-hint">{m.auth_security_password_return_readback()}</p>
        <p className="auth-security-hint">{m.auth_security_password_consequences()}</p>
      </div>
      {advice === 'step-up-required' ? (
        <p className="auth-security-hint">{m.auth_security_step_up_advice()}</p>
      ) : advice && advice !== 'allowed' ? (
        <p className="auth-security-hint">{m.auth_inventory_unavailable()}</p>
      ) : null}
      {reading ? <p role="status">{m.auth_inventory_loading()}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={!canReview || reading}
          onClick={onReview}
          data-password-return-review
        >
          {m.auth_security_check_current()}
        </Button>
        {history.unknownPhase && !acknowledged ? (
          <Button type="button" disabled={!canStartNew} onClick={onAcknowledge} data-password-return-acknowledge>
            {m.auth_security_password_return_acknowledge()}
          </Button>
        ) : null}
        {!history.unknownPhase && history.applicationConfirmed && !acknowledged ? (
          <Button type="button" disabled={!canStartNew} onClick={onAcknowledge} data-password-return-acknowledge>
            {m.auth_security_change_password()}
          </Button>
        ) : null}
      </div>
      {acknowledged ? (
        <p className="auth-security-hint">{m.auth_security_password_return_new_attempt()}</p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <a href="/login">{m.auth_security_sign_in()}</a>
        <a href="/recovery">{m.auth_signup_recovery()}</a>
      </div>
    </section>
  );
}
