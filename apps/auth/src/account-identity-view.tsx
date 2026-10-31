import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { AccountIdentityState } from './account-identity';

/** Page-specific identity prose and native diagnostic disclosure have no shadcn counterpart. */
export function AccountIdentitySummary({
  accountId,
  state,
  action,
  retry,
}: {
  accountId: string;
  state: AccountIdentityState;
  action: 'security' | 'delete';
  retry: () => void;
}) {
  const email = state.kind === 'ready' && state.accountId === accountId ? state.email : null;
  return (
    <section className="auth-account-identity" aria-labelledby="auth-account-identity-heading">
      <h2 id="auth-account-identity-heading">{m.auth_account_identity_heading()}</h2>
      {email ? (
        <p className="auth-account-identity-value">
          <bdi dir="auto">{email}</bdi>
        </p>
      ) : (
        <p aria-live="polite">
          {state.kind === 'loading'
            ? m.auth_account_identity_loading()
            : state.kind === 'ready'
              ? m.auth_account_identity_missing()
              : m.auth_account_identity_unavailable()}
        </p>
      )}
      <p id="auth-account-identity-description">
        {accountId
          ? action === 'delete'
            ? m.auth_account_identity_delete_target({ account: email ?? accountId })
            : m.auth_account_identity_security_target({ account: email ?? accountId })
          : m.auth_account_identity_checking()}
      </p>
      {accountId ? (
        email ? (
          <details>
            <summary>{m.auth_account_identity_details()}</summary>
            <p>{m.auth_account_identity_account_id({ accountId })}</p>
          </details>
        ) : (
          <p className="auth-account-identity-secondary">{m.auth_account_identity_account_id({ accountId })}</p>
        )
      ) : null}
      {state.kind === 'unavailable' ? (
        <Button type="button" variant="outline" onClick={retry}>
          {m.auth_account_identity_retry()}
        </Button>
      ) : null}
    </section>
  );
}
