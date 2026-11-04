import type { Ref } from 'react';
import { AuthButton as Button } from './button';
import { m } from './paraglide/messages.js';
import type { AccountDeletionReturnHistory } from './account-deletion-return';

export function AccountDeletionReturnView({
  history,
  onDismiss,
  focusRef,
}: {
  history: AccountDeletionReturnHistory;
  onDismiss: () => void;
  focusRef?: Ref<HTMLElement>;
}) {
  if (history.dismissed) return null;

  const message =
    history.kind === 'acknowledged'
      ? m.auth_account_delete_return_acknowledged()
      : history.kind === 'unknown'
        ? m.auth_account_delete_return_unknown()
        : m.auth_account_delete_return_unsent();

  return (
    <section
      ref={focusRef}
      aria-labelledby="account-delete-return-heading"
      className="mt-6 grid gap-3 rounded-lg border border-border p-4"
      data-account-deletion-return={history.kind}
      tabIndex={-1}
    >
      <h2 id="account-delete-return-heading" className="font-semibold">
        {m.auth_account_delete_return_heading()}
      </h2>
      <p role="status">{message}</p>
      {history.kind === 'acknowledged' ? (
        <>
          <p>{m.auth_account_delete_cleanup_pending()}</p>
          <p>{m.auth_account_delete_finality()}</p>
        </>
      ) : null}
      <Button type="button" variant="outline" onClick={onDismiss}>
        {m.auth_account_delete_return_dismiss()}
      </Button>
    </section>
  );
}
