import type { Ref } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@rezics/ui/shadcn/alert-dialog';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { OrganizationDeletionLoad } from './organization-deletion';

/** Advice is deliberately presented without private labels or command controls. */
export function OrganizationDeletionRecovery({
  advice,
  pending,
  readback,
  headingRef,
}: {
  advice: OrganizationDeletionLoad | null;
  pending: boolean;
  readback: (() => void) | undefined;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const kind = advice?.kind;
  const authentication = kind === 'authentication-required' || kind === 'signed-out';
  const feedback =
    pending
      ? m.auth_organization_delete_recovery_pending()
      : !advice
        ? m.auth_organization_delete_recovery_not_started()
        : kind === 'ready'
          ? m.auth_organization_delete_still_readable()
          : kind === 'signed-out'
            ? m.auth_account_operation_sign_in_required()
            : kind === 'authentication-required'
              ? m.auth_organization_delete_recovery_authentication()
              : kind === 'denied'
                ? m.auth_organization_delete_recovery_denied()
                : kind === 'hidden'
                  ? m.auth_organization_delete_recovery_hidden()
                  : kind === 'missing'
                    ? m.auth_organization_delete_recovery_missing()
                    : kind === 'changed'
                      ? m.auth_organization_delete_recovery_changed()
                      : m.auth_organization_delete_recovery_unavailable();
  return (
    <section aria-labelledby="organization-delete-recovery-heading" className="auth-login-form min-w-0 break-words">
      <h2 id="organization-delete-recovery-heading" tabIndex={-1} ref={headingRef}>
        {m.auth_organization_delete_recovery_heading()}
      </h2>
      <p>{m.auth_organization_delete_unknown()}</p>
      <p>{m.auth_organization_delete_recovery_fence()}</p>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p>{feedback}</p>
      </div>
      <Button
        id="organization-delete-return-review"
        type="button"
        disabled={pending || !readback}
        aria-busy={pending}
        onClick={readback}
      >
        {m.auth_organization_delete_readback()}
      </Button>
      {authentication ? (
        <a id="organization-delete-return-sign-in" href="/login">
          {m.auth_security_sign_in()}
        </a>
      ) : null}
      <p>{m.auth_account_operation_leave_notice()}</p>
    </section>
  );
}

/** The route owns blocking and retirement; this dialog only presents that decision. */
export function OrganizationDeletionDeparturePrompt({
  open,
  unknown,
  stay,
  leave,
  focus,
}: {
  open: boolean;
  unknown: boolean;
  stay: () => void;
  leave: () => void;
  focus: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) stay();
      }}
    >
      <AlertDialogContent
        finalFocus={() => {
          focus();
          return false;
        }}
      >
        <AlertDialogTitle>{m.auth_organization_delete_departure_heading()}</AlertDialogTitle>
        <AlertDialogDescription>
          {unknown
            ? m.auth_organization_delete_recovery_departure()
            : m.auth_organization_delete_departure_description()}{' '}
          {m.auth_account_operation_leave_notice()}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={stay}>{m.auth_organization_departure_stay()}</AlertDialogCancel>
          <AlertDialogAction onClick={leave}>{m.auth_organization_departure_leave()}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
