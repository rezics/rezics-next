import { AuthButton as Button } from './button';
import type { AccountDeletionAttempt } from './account-deletion-attempt';
import { m } from './paraglide/messages.js';

export function AccountDeletionRecovery({
  attempt,
  visible,
  refreshing,
  onRefresh,
}: {
  attempt: AccountDeletionAttempt | null;
  visible: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (!attempt || !visible) return null;

  const unknown = attempt.uncertain || attempt.phase === 'unknown';
  const progress =
    attempt.phase === 'approval'
      ? m.auth_account_delete_approval_pending()
      : attempt.phase === 'execution'
        ? m.auth_account_delete_execution_pending()
        : null;

  return (
    <section
      aria-labelledby="account-delete-recovery-heading"
      className="mt-6 grid gap-3 rounded-lg border border-border p-4"
      data-account-deletion-recovery={unknown ? 'unknown' : attempt.phase}
    >
      {unknown ? (
        <>
          <h2 id="account-delete-recovery-heading" className="font-semibold">
            {m.auth_account_delete_recovery_title()}
          </h2>
          <p role="status">{m.auth_account_delete_recovery_description()}</p>
          {attempt.hintOnly ? <p>{m.auth_account_delete_recovery_precision()}</p> : null}
        </>
      ) : progress ? (
        <p id="account-delete-recovery-heading" role="status">
          {progress}
        </p>
      ) : null}
      {refreshing ? <p role="status">{m.auth_account_delete_recovery_refreshing()}</p> : null}
      <Button
        type="button"
        variant="outline"
        disabled={refreshing || attempt.phase === 'approval' || attempt.phase === 'execution'}
        onClick={onRefresh}
      >
        {m.auth_account_delete_recovery_refresh()}
      </Button>
    </section>
  );
}
