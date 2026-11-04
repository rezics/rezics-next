import { AuthButton as Button } from './button';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { m } from './paraglide/messages.js';
import { membershipId } from './organization-membership';
import type { OrganizationCreatePhase } from './organization-create-return';
import type { Ref } from 'react';

export type OrganizationCreateReturnViewProps = {
  phase: OrganizationCreatePhase;
  history?: 'none' | 'unconfirmed' | 'acknowledged';
  pending?: boolean;
  handle?: string;
  accountId?: string;
  canRetryCreation?: boolean;
  canRetryRead?: boolean;
  signedOut?: boolean;
  readRetry?: () => void;
  creationRetry?: () => void;
  focusRef?: Ref<HTMLDivElement>;
};

export function OrganizationCreateReturnView({
  phase,
  history = 'none',
  pending = false,
  handle,
  accountId,
  canRetryCreation = false,
  canRetryRead = false,
  signedOut = false,
  readRetry,
  creationRetry,
  focusRef,
}: OrganizationCreateReturnViewProps) {
  const currentSuccess = phase === 'acknowledged' && Boolean(handle);
  const hasUnknownHistory =
    history === 'unconfirmed' && !['preflight', 'approval', 'execution'].includes(phase);
  const hasAcknowledgedHistory = history === 'acknowledged';
  const showUnknown = phase === 'unknown' || phase === 'unresumable' || hasUnknownHistory;
  const view = (() => {
    switch (phase) {
      case 'review':
      case 'refused':
        return null;
      case 'preflight':
        return <Alert role="status"><AlertDescription>{m.auth_organization_creation_checking()}</AlertDescription></Alert>;
      case 'approval':
        return (
          <Alert role="status">
            <AlertDescription>
              {pending ? m.auth_organization_creation_approving() : m.auth_account_operation_reconfirm()}
            </AlertDescription>
          </Alert>
        );
      case 'execution':
        return <Alert role="status"><AlertDescription>{m.auth_organization_creation_sending()}</AlertDescription></Alert>;
      case 'unknown':
        return <Alert role="status"><AlertDescription>{m.auth_organization_creation_unknown()}</AlertDescription></Alert>;
      case 'unavailable':
        return <Alert role="alert"><AlertDescription>{m.auth_account_operation_unavailable()}</AlertDescription></Alert>;
      case 'unresumable':
        return <Alert role="alert"><AlertDescription>{m.auth_organization_return_unresumable()}</AlertDescription></Alert>;
      case 'acknowledged':
        return currentSuccess ? (
          <div className="auth-account-operation-success" role="status">
            <p>{m.auth_organization_created({ handle: handle! })}</p>
            {membershipId(accountId ?? '') ? (
              <p>
                <a href={`/organizations/members?${new URLSearchParams({ organizationId: accountId! })}`}>
                  {m.auth_members_heading()}
                </a>
              </p>
            ) : null}
            <a href="/security">{m.auth_security_heading()}</a>
          </div>
        ) : (
          <Alert role="status"><AlertDescription>{m.auth_organization_return_acknowledged()}</AlertDescription></Alert>
        );
    }
  })();

  if (!view && !hasUnknownHistory && !canRetryRead && !canRetryCreation && !signedOut) return null;
  return (
    <div ref={focusRef} tabIndex={-1} className="flex flex-col gap-3 outline-none" data-organization-create-return>
      {hasUnknownHistory && phase !== 'unknown' ? (
        <Alert role="status"><AlertDescription>{m.auth_organization_creation_unknown()}</AlertDescription></Alert>
      ) : null}
      {hasAcknowledgedHistory && phase !== 'acknowledged' ? (
        <Alert role="status"><AlertDescription>{m.auth_organization_return_acknowledged()}</AlertDescription></Alert>
      ) : null}
      {view}
      {showUnknown || phase === 'unavailable' || phase === 'unresumable' || signedOut ? (
        <div className="flex flex-wrap items-center gap-3">
          {canRetryRead && readRetry ? (
            <Button type="button" variant="outline" onClick={readRetry}>
              {m.auth_organization_return_read_retry()}
            </Button>
          ) : null}
          {canRetryCreation && creationRetry ? (
            <Button type="button" onClick={creationRetry}>
              {m.auth_organization_return_creation_retry()}
            </Button>
          ) : null}
          {signedOut ? <a href="/login">{m.auth_security_sign_in()}</a> : null}
          {!signedOut ? <a href="/security">{m.auth_security_heading()}</a> : null}
        </div>
      ) : null}
    </div>
  );
}
