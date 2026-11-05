import type { Ref } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';

export function MembershipRecoveryView({
  status,
  outcome,
  pending,
  canRetry,
  canSignIn,
  retry,
  signIn,
  headingRef,
}: {
  status: string;
  outcome: string;
  pending: boolean;
  canRetry: boolean;
  canSignIn: boolean;
  retry: () => void;
  signIn: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <section aria-labelledby="membership-recovery-heading" className="space-y-4">
      <h2 id="membership-recovery-heading" ref={headingRef} tabIndex={-1}>
        {m.auth_members_recovery_heading()}
      </h2>
      <p>{outcome}</p>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p>{status}</p>
      </div>
      <Button type="button" disabled={pending || !canRetry} aria-busy={pending} onClick={retry}>
        {m.auth_members_recovery_retry()}
      </Button>
      {canSignIn ? (
        <Button type="button" variant="outline" disabled={pending} onClick={signIn}>
          {m.auth_members_recovery_sign_in()}
        </Button>
      ) : null}
    </section>
  );
}
