import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import type { AccountRenameNavigation } from './account-rename-actions';

export function AccountRenameLink({ context }: { context?: AccountRenameNavigation | null }) {
  const href = context?.available ? (context.href ?? null) : null;
  return (
    <div className="space-y-3">
      <h3 className="font-medium">{m.settings_account_rename_heading()}</h3>
      {context ? (
        <p className="break-words text-sm">
          {m.settings_account_rename_identity({ account: context.accountId })}
          {' · '}
          {context.handle ? `@${context.handle}` : m.settings_account_rename_handleless()}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.settings_account_rename_policy()}</p>
      <p className="text-sm text-muted-foreground">{m.settings_account_rename_confirmation()}</p>
      {href ? (
        <a
          href={href}
          referrerPolicy="no-referrer"
          className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'h-auto min-h-11 whitespace-normal py-2')}
        >
          {m.settings_account_rename_continue()}
        </a>
      ) : (
        <p className="text-sm text-muted-foreground">{m.settings_account_rename_unavailable()}</p>
      )}
    </div>
  );
}
