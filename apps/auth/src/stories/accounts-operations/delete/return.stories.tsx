import { AccountDeletionRecovery } from '../../../account-deletion-recovery';
import { AccountDeletionReturnView } from '../../../account-deletion-return-view';
import { createAccountDeletionAttempt } from '../../../account-deletion-attempt';
import type { AccountDeletionReturnKind } from '../../../account-deletion-return';
import { m } from '../../../paraglide/messages.js';
import { authLocale, reviewParameters } from '../story';

export default {
  title: 'Account/Delete account return',
  id: 'pages-account-delete-account-return',
  parameters: reviewParameters,
  decorators: [authLocale],
};

function example(kind: AccountDeletionReturnKind) {
  const attempt =
    kind === 'unknown' ? createAccountDeletionAttempt('private-story-account', '0'.repeat(32), true) : null;
  return (
    <main className="auth-login-form mx-auto w-full max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">{m.auth_account_delete_heading()}</h1>
      <AccountDeletionReturnView history={{ kind, dismissed: false }} onDismiss={() => {}} />
      {attempt ? <AccountDeletionRecovery attempt={attempt} visible refreshing={false} onRefresh={() => {}} /> : null}
      <p className="mt-6">
        <a href="/security" className="underline underline-offset-4">
          {m.auth_account_operation_return()}
        </a>
      </p>
    </main>
  );
}

export const Unsent = { render: () => example('unsent') };
export const Unknown = { render: () => example('unknown') };
export const Acknowledged = { render: () => example('acknowledged') };
