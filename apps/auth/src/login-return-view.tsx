import { useLayoutEffect, useRef } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { LoginPhase, LoginReturnHistory } from './login-return';

/** Historical presentation deliberately has no command, destination or account props. */
export function LoginReturnView({ records, onDismiss }: { records: LoginReturnHistory; onDismiss: () => void }) {
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (records.length) status.current?.focus();
  }, [records]);
  if (!records.length) return null;
  const phases: Record<LoginPhase, () => string> = {
    options: m.auth_login_return_unsent,
    prompt: m.auth_login_return_prompt,
    dispatched: m.auth_login_uncertain,
    unknown: m.auth_login_uncertain,
    acknowledged: m.auth_login_return_acknowledged,
    refused: m.auth_login_return_refused,
    cancelled: m.auth_login_prompt_cancelled,
  };
  return (
    <section className="auth-login-form" aria-label={m.auth_login_return_heading()}>
      <div ref={status} tabIndex={-1} role="status">
        <h2>{m.auth_login_return_heading()}</h2>
        {records.map((record, index) => (
          <div key={index}>
            <p>
              {record.method === 'autofill'
                ? m.auth_login_autofill()
                : record.method === 'passkey'
                  ? m.auth_login_passkey()
                  : m.auth_login_password()}
            </p>
            <p>{phases[record.phase]()}</p>
          </div>
        ))}
        <p>{m.auth_login_return_separate()}</p>
      </div>
      <Button type="button" variant="outline" onClick={onDismiss}>
        {m.auth_login_return_dismiss()}
      </Button>
      <p>{m.auth_login_return_dismiss_help()}</p>
    </section>
  );
}
