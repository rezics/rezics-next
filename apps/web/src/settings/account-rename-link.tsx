import { useId } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import type { AccountRenameNavigation } from './account-rename-actions';
import type { AccountRenameFailure } from './account-rename-data';

export function AccountRenameLink({
  context,
  loading = false,
  failure,
}: {
  context?: AccountRenameNavigation | null;
  loading?: boolean;
  failure?: AccountRenameFailure | undefined;
}) {
  const id = useId();
  const identity = loading ? null : (context ?? null);
  const href = !failure && identity?.available ? (identity.href ?? null) : null;
  return (
    <div
      className="min-w-0 max-w-full space-y-3 [overflow-wrap:anywhere]"
      aria-busy={loading || undefined}
      aria-labelledby={`${id}-heading`}
    >
      <h3 id={`${id}-heading`} className="font-medium">
        {m.settings_account_rename_heading()}
      </h3>
      {identity ? (
        <div className="w-full min-w-0 max-w-full space-y-2">
          <p
            id={`${id}-identity`}
            className="w-full whitespace-normal text-base leading-relaxed font-medium [overflow-wrap:anywhere]"
          >
            {identity.handle ? `@${identity.handle}` : m.settings_account_rename_handleless()}
          </p>
          <details className="min-w-0 max-w-full text-sm text-muted-foreground">
            <summary className="min-h-11 max-w-full cursor-pointer rounded-sm py-2 whitespace-normal focus-visible:outline-2 focus-visible:outline-ring">
              {m.settings_account_reference_details()}
            </summary>
            <p className="max-w-full py-2 [overflow-wrap:anywhere]">
              {m.settings_account_rename_identity({ account: identity.accountId })}
            </p>
          </details>
        </div>
      ) : null}
      <p id={`${id}-policy`} className="text-sm text-muted-foreground">
        {m.settings_account_rename_policy()}
      </p>
      <p id={`${id}-confirmation`} className="text-sm text-muted-foreground">
        {m.settings_account_rename_confirmation()}
      </p>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.settings_profile_loading()}
        </p>
      ) : failure ? (
        <p role="status" className="text-sm text-muted-foreground">
          {failure.kind === 'denied'
            ? m.settings_account_rename_denied()
            : failure.kind === 'unavailable'
              ? m.settings_account_rename_unavailable()
              : m.settings_account_rename_failed()}
        </p>
      ) : href ? (
        <a
          href={href}
          referrerPolicy="no-referrer"
          aria-describedby={`${id}-identity ${id}-policy ${id}-confirmation`}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'lg' }),
            'h-auto min-h-11 w-full min-w-0 max-w-full whitespace-normal py-2 text-center [overflow-wrap:anywhere]',
          )}
        >
          {m.settings_account_rename_continue()}
        </a>
      ) : (
        <p className="text-sm text-muted-foreground">{m.settings_account_rename_unavailable()}</p>
      )}
    </div>
  );
}
