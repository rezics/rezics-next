import { useId } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Separator } from '@rezics/ui/shadcn/separator';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from '../threads/write-prompts';
import { accountSafetyLinks } from './account-safety-links';
import { AccountRenameLink } from './account-rename-link';
import type { AccountRenameContext } from './account-rename-data';

export type AccountSafetyProps =
  | {
      state: 'signed-in';
      securityHref: string | null;
      csrfToken: string | null;
      onReload: () => void;
      renameAccount?: AccountRenameContext | null;
    }
  | { state: 'signed-out'; returnTo: string };

export function AccountSafetyCard(props: AccountSafetyProps) {
  const id = useId();
  const links = props.state === 'signed-in' ? accountSafetyLinks(props.securityHref) : null;
  const linkClass = 'h-auto min-h-11 max-w-full whitespace-normal py-2 text-center';
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-account-heading">{m.settings_account_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_account_safety_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {props.state === 'signed-out' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{m.settings_account_sign_in_text()}</p>
            <SignInPrompt returnTo={props.returnTo} />
          </div>
        ) : (
          <>
            <AccountRenameLink context={props.renameAccount} securityHref={props.securityHref} />
            {links ? (
              <a href={links.security} className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), linkClass)}>
                {m.account_security_settings()}
              </a>
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {m.settings_account_auth_unavailable()}
              </p>
            )}
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{m.settings_account_sign_out_text()}</p>
              <form method="post" action="/auth/sign-out" className="m-0">
                <input type="hidden" name="csrf_token" value={props.csrfToken ?? ''} />
                <Button
                  type="submit"
                  variant="outline"
                  size="lg"
                  className="min-h-11"
                  disabled={!props.csrfToken}
                  aria-describedby={!props.csrfToken ? `${id}-csrf` : undefined}
                >
                  {m.account_sign_out()}
                </Button>
              </form>
              {!props.csrfToken ? (
                <div className="space-y-2">
                  <p id={`${id}-csrf`} role="status" className="text-sm text-muted-foreground">
                    {m.settings_account_csrf_unavailable()}
                  </p>
                  <Button type="button" variant="outline" className="min-h-11" onClick={props.onReload}>
                    {m.settings_reload()}
                  </Button>
                </div>
              ) : null}
            </div>
            <Separator />
            <div className="space-y-3">
              <h3 className="font-medium">{m.settings_account_delete_heading()}</h3>
              <p className="text-sm text-muted-foreground">{m.settings_account_delete_text()}</p>
              {links ? (
                <a
                  href={links.deletion}
                  className={cn(buttonVariants({ variant: 'destructive', size: 'lg' }), linkClass)}
                >
                  {m.settings_account_delete_continue()}
                </a>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
