import { m } from '../paraglide/messages.js';

export type AccountReference = { handle: string | null; displayName: string | null };

/** A curator handle and display name, or the shared deleted-account label when the account is gone. */
function initials(account: AccountReference): string {
  const value = account.displayName?.trim() || account.handle?.trim() || '?';
  return value
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? '')
    .join('')
    .toLocaleUpperCase();
}

export function AccountRef({ account, avatar = false }: { account: AccountReference | null; avatar?: boolean }) {
  if (!account)
    return (
      <span className="inline-flex items-center gap-2">
        {avatar ? <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-muted text-xs">?</span> : null}
        <span>{m.library_account_deleted()}</span>
      </span>
    );
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {avatar ? (
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {initials(account)}
        </span>
      ) : null}
      <span className="min-w-0">
        {account.displayName ? <span>{account.displayName}</span> : null}
        {account.displayName && account.handle ? ' ' : null}
        {account.handle ? <span>@{account.handle}</span> : null}
      </span>
    </span>
  );
}
