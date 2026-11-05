import type { RefObject } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { SecurityTargetReturnOutcome } from './security-target-return';

export function SecurityTargetReturnView({
  outcome,
  statusRef,
  dismiss,
}: {
  outcome: SecurityTargetReturnOutcome;
  statusRef: RefObject<HTMLDivElement | null>;
  dismiss: () => void;
}) {
  const message =
    outcome === 'acknowledged'
      ? m.auth_security_target_return_acknowledged()
      : outcome === 'refused'
        ? m.auth_security_target_return_refused()
        : m.auth_security_target_return_unknown();
  return (
    <section className="auth-login-form rounded-lg border p-4 sm:p-6" aria-labelledby="security-return-heading">
      <h2 id="security-return-heading">{m.auth_security_target_return_heading()}</h2>
      <div ref={statusRef} tabIndex={-1} role="status">
        {message}
      </div>
      <p className="mt-2 text-sm">{m.auth_security_target_return_dismiss_help()}</p>
      <Button type="button" variant="outline" onClick={dismiss}>
        {m.auth_security_target_return_dismiss()}
      </Button>
    </section>
  );
}
