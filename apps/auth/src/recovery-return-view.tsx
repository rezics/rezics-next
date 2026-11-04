import { useLayoutEffect, useRef } from 'react';
import { AuthButton as Button } from './button';
import { ErrorAlert } from './alert';
import { m } from './paraglide/messages.js';
import type { RecoveryReturnSummary } from './recovery-return';

export function RecoveryHistory({ summary }: { summary: RecoveryReturnSummary }) {
  return (
    <div role="status">
      {summary.start ? (
        <p>{summary.start === 'acknowledged' ? m.auth_recovery_start_success() : m.auth_recovery_start_unknown()}</p>
      ) : null}
      {summary.complete ? (
        <p>
          {summary.complete === 'acknowledged'
            ? m.auth_recovery_return_complete_acknowledged()
            : m.auth_recovery_return_complete_unknown()}
        </p>
      ) : null}
    </div>
  );
}

export function RecoveryReturnView({
  summary,
  status,
  retry,
  fresh,
}: {
  summary: RecoveryReturnSummary;
  status: 'loading' | 'unavailable' | 'ready';
  retry: () => void;
  fresh: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => heading.current?.focus(), [status]);
  return (
    <section className="auth-login-form" aria-busy={status === 'loading'}>
      <h2 id="recovery-return-heading" ref={heading} tabIndex={-1}>
        {m.auth_recovery_return_heading()}
      </h2>
      <RecoveryHistory summary={summary} />
      <p>{m.auth_recovery_return_credentials_cleared()}</p>
      {status === 'loading' ? <p role="status">{m.auth_recovery_advice_loading()}</p> : null}
      {status === 'unavailable' ? (
        <>
          <ErrorAlert>{m.auth_failure_unavailable()}</ErrorAlert>
          <Button type="button" onClick={retry}>
            {m.auth_login_retry()}
          </Button>
        </>
      ) : null}
      {status === 'ready' ? <p>{m.auth_recovery_return_advice()}</p> : null}
      <a href="/login">{m.auth_login_heading()}</a>
      <Button type="button" disabled={status !== 'ready'} onClick={fresh}>
        {m.auth_recovery_new_link()}
      </Button>
    </section>
  );
}
