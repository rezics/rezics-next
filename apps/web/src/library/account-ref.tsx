import { m } from '../paraglide/messages.js';

export type AccountReference = { handle: string | null; displayName: string | null };

/** A curator handle and display name, or the shared deleted-account label when the account is gone. */
export function AccountRef({ account }: { account: AccountReference | null }) {
  if (!account) return <span>{m.library_account_deleted()}</span>;
  return (
    <span>
      {account.displayName ? <span>{account.displayName}</span> : null}
      {account.displayName && account.handle ? ' ' : null}
      {account.handle ? <span>{account.handle}</span> : null}
    </span>
  );
}
