import { useLayoutEffect, useRef, type RefObject } from 'react';
import type { ConsentNotice, ConsentNotices } from './consent-request-return';
import { ConsentRecoveryView } from './consent-recovery-view';
import { m } from './paraglide/messages.js';

export function ConsentRequestReturnView({
  notices,
  dismiss,
  current,
}: {
  notices: ConsentNotices;
  dismiss: (notice: ConsentNotice) => void;
  current: RefObject<HTMLDivElement | null>;
}) {
  const first = useRef<HTMLElement>(null);
  const latest = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    // A fresh document has no historical assertion and keeps ordinary review focus.
    if (mounted.current) (latest.current ?? first.current ?? current.current)?.focus();
    mounted.current = true;
  }, [notices, current]);
  return (
    <>
      {notices.first ? (
        <section ref={first} tabIndex={-1} aria-label={m.auth_consent_history_first()} className="auth-login-form">
          <h2 className="font-semibold">{m.auth_consent_history_first()}</h2>
          <ConsentRecoveryView outcome={notices.first.outcome} dismiss={() => dismiss(notices.first!)} />
        </section>
      ) : null}
      {notices.latest ? (
        <section ref={latest} tabIndex={-1} aria-label={m.auth_consent_history_latest()} className="auth-login-form">
          <h2 className="font-semibold">{m.auth_consent_history_latest()}</h2>
          <ConsentRecoveryView outcome={notices.latest.outcome} dismiss={() => dismiss(notices.latest!)} />
        </section>
      ) : null}
    </>
  );
}
