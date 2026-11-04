import type { Ref } from 'react';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { m } from './paraglide/messages.js';
import type { OrganizationDeletionLoad } from './organization-deletion';
import type { OrganizationDeletionHistoryView } from './organization-deletion-return';
import { OrganizationDeletionRecovery } from './organization-deletion-recovery';

/** Generic history stays visible beside current advice and contains no target or viewer identity. */
export function OrganizationDeletionReturnView({
  history,
  advice,
  pending,
  readCurrent,
  headingRef,
}: {
  history: OrganizationDeletionHistoryView;
  advice: OrganizationDeletionLoad | null;
  pending: boolean;
  readCurrent: (() => void) | undefined;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  let headingAssigned = false;
  const heading = () => {
    if (headingAssigned) return undefined;
    headingAssigned = true;
    return headingRef;
  };

  return (
    <div className="auth-login-form min-w-0 break-words">
      {history.includes('unresolved') ? (
        <OrganizationDeletionRecovery advice={advice} pending={pending} readback={readCurrent} headingRef={heading()} />
      ) : null}
      {history.includes('unsent') ? (
        <section aria-labelledby="organization-delete-unsent-heading">
          <h2 id="organization-delete-unsent-heading" tabIndex={-1} ref={heading()}>
            {m.auth_organization_delete_return_unsent_heading()}
          </h2>
          <p>{m.auth_organization_delete_return_unsent()}</p>
        </section>
      ) : null}
      {history.includes('acknowledged') ? (
        <Alert role="status" aria-labelledby="organization-delete-acknowledged-heading">
          <h2 id="organization-delete-acknowledged-heading" tabIndex={-1} ref={heading()}>
            {m.auth_organization_delete_accepted()}
          </h2>
          <AlertDescription>{m.auth_organization_delete_return_acknowledged()}</AlertDescription>
        </Alert>
      ) : null}
      {history.includes('refused') ? (
        <section aria-labelledby="organization-delete-refused-heading">
          <h2 id="organization-delete-refused-heading" tabIndex={-1} ref={heading()}>
            {m.auth_organization_delete_return_refused_heading()}
          </h2>
          <p>{m.auth_organization_delete_return_refused()}</p>
        </section>
      ) : null}
    </div>
  );
}
