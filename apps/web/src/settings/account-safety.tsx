import { useEffect, useId, useState, useSyncExternalStore, useMemo } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Separator } from '@rezics/ui/shadcn/separator';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from '../threads/write-prompts';
import { accountSafetyLinks } from './account-safety-links';
import { AccountRenameLink } from './account-rename-link';
import type { AccountRenameNavigation, AccountRenameResult } from './account-rename-actions';
import type { AccountRenameFailure } from './account-rename-data';
import { preferenceRetryDeadline, usePreferenceRetry } from './preference-failure-retry';

export type AccountSafetyProps =
  | {
      state: 'signed-in';
      accountId?: string | null;
      securityHref: string | null;
      csrfToken: string | null;
      onReload: () => void;
      renameAccount?: AccountRenameNavigation | null;
      renameRead?: { loading: boolean; reload: () => void; failures?: AccountRenameFailure[]; retryAt?: number };
    }
  | { state: 'signed-out'; returnTo: string };

/** This mounted region never seeds capability from a historical settings response. */
export function AccountSafetySection(props: AccountSafetyProps) {
  return props.state === 'signed-in' ? (
    <CurrentAccountSafety key={JSON.stringify([props.accountId, props.csrfToken])} {...props} />
  ) : (
    <AccountSafetyCard {...props} />
  );
}

type RenameSnapshot = AccountRenameResult & { loading: boolean; retryAt: number };

/** One mount/reload read, coalesced during effect replay; expiry only unlocks the explicit handler. */
export class AccountRenameRegion {
  private value: RenameSnapshot = { loading: true, context: null, retryAt: 0 };
  private pending: Promise<void> | null = null;
  private active = false;
  private listeners = new Set<() => void>();
  constructor(
    private readonly read: () => Promise<AccountRenameResult>,
    private readonly accountId?: string | null,
  ) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: RenameSnapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  mount = () => {
    this.active = true;
    if (this.value.loading) void this.request();
    return () => {
      this.active = false;
    };
  };
  reload = (): Promise<void> => {
    if (!this.active || this.value.loading || Date.now() < this.value.retryAt) return this.pending ?? Promise.resolve();
    return this.request();
  };
  private request(): Promise<void> {
    if (this.pending) return this.pending;
    // Clear all old identity, links and failure metadata before awaiting a fresh read.
    this.publish({ loading: true, context: null, retryAt: 0 });
    this.pending = Promise.resolve()
      .then(this.read)
      .catch((): AccountRenameResult => ({ context: null, failures: [{ kind: 'failed', status: null }] }))
      .then((result) => {
        if (!this.active) return;
        if (this.accountId && result.context && result.context.accountId !== this.accountId) result = { context: null };
        const now = Date.now();
        const retryAt = Math.max(
          0,
          ...(result.failures ?? []).map((failure) => preferenceRetryDeadline(failure.retryAfter, now)),
        );
        this.publish({ ...result, loading: false, retryAt });
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

function CurrentAccountSafety(props: Extract<AccountSafetyProps, { state: 'signed-in' }>) {
  const [region] = useState(
    () =>
      new AccountRenameRegion(
        () =>
          props.csrfToken
            ? import('./account-rename-actions').then(({ readAccountRename }) =>
                readAccountRename({ headers: { 'X-CSRF-Token': props.csrfToken! } }),
              )
            : Promise.resolve({ context: null }),
        props.accountId,
      ),
  );
  const result = useSyncExternalStore(region.subscribe, region.snapshot, region.snapshot);
  useEffect(region.mount, [region]);
  return (
    <AccountSafetyCard
      {...props}
      renameAccount={result.context}
      renameRead={{
        loading: result.loading,
        reload: region.reload,
        ...(result.failures ? { failures: result.failures } : {}),
        retryAt: result.retryAt,
      }}
    />
  );
}

export function AccountSafetyCard(props: AccountSafetyProps) {
  const id = useId();
  const read = props.state === 'signed-in' ? props.renameRead : undefined;
  const failure = read?.failures?.find((entry) => entry.kind === 'denied') ?? read?.failures?.[0];
  const retryAt = useMemo(
    () =>
      read?.retryAt ?? Math.max(0, ...(read?.failures ?? []).map((entry) => preferenceRetryDeadline(entry.retryAfter))),
    [read?.retryAt, read?.failures],
  );
  const waiting = usePreferenceRetry(undefined, retryAt);
  const links = props.state === 'signed-in' ? accountSafetyLinks(props.securityHref) : null;
  const actionClass =
    'h-auto min-h-11 w-full min-w-0 max-w-full whitespace-normal py-2 text-center [overflow-wrap:anywhere]';
  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader>
        <CardTitle>
          <h2 id="settings-account-heading">{m.settings_account_heading()}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 max-w-full space-y-6 [overflow-wrap:anywhere]">
        {props.state === 'signed-out' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{m.settings_account_sign_in_text()}</p>
            <SignInPrompt returnTo={props.returnTo} />
          </div>
        ) : (
          <>
            <AccountRenameLink
              context={props.renameAccount ?? null}
              loading={read?.loading ?? false}
              failure={failure}
            />
            {props.renameRead ? (
              <div aria-busy={props.renameRead.loading} className="space-y-2">
                <Button
                  type="button"
                  variant="outline"
                  className={actionClass}
                  disabled={props.renameRead.loading || waiting}
                  aria-describedby={waiting ? `${id}-rename-wait` : undefined}
                  onClick={props.renameRead.reload}
                  aria-label={`${m.settings_reload()}: ${m.settings_account_rename_heading()}`}
                >
                  {m.settings_reload()}
                </Button>
                {waiting ? (
                  <p id={`${id}-rename-wait`} role="status" className="text-sm text-muted-foreground">
                    {m.settings_retry_wait()}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="space-y-3">
              <p id={`${id}-security`} className="text-sm text-muted-foreground">
                {m.settings_account_safety_text()}
              </p>
              {links ? (
                <a
                  href={links.security}
                  referrerPolicy="no-referrer"
                  aria-describedby={`${id}-security`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), actionClass)}
                >
                  {m.account_security_settings()}
                </a>
              ) : (
                <p role="status" className="text-sm text-muted-foreground">
                  {m.settings_account_auth_unavailable()}
                </p>
              )}
            </div>
            <div className="space-y-3">
              <p id={`${id}-sign-out`} className="text-sm text-muted-foreground">
                {m.settings_account_sign_out_text()}
              </p>
              <form method="post" action="/auth/sign-out" className="m-0">
                <input type="hidden" name="csrf_token" value={props.csrfToken ?? ''} />
                <Button
                  type="submit"
                  variant="outline"
                  size="lg"
                  className={actionClass}
                  disabled={!props.csrfToken}
                  aria-describedby={`${id}-sign-out${!props.csrfToken ? ` ${id}-csrf` : ''}`}
                >
                  {m.account_sign_out()}
                </Button>
              </form>
              {!props.csrfToken ? (
                <div className="space-y-2">
                  <p id={`${id}-csrf`} role="status" className="text-sm text-muted-foreground">
                    {m.settings_account_csrf_unavailable()}
                  </p>
                  <Button type="button" variant="outline" className={actionClass} onClick={props.onReload}>
                    {m.settings_reload()}
                  </Button>
                </div>
              ) : null}
            </div>
            <Separator />
            <div className="space-y-3">
              <h3 className="font-medium">{m.settings_account_delete_heading()}</h3>
              <p id={`${id}-deletion`} className="text-sm text-muted-foreground">
                {m.settings_account_delete_text()}
              </p>
              {links ? (
                <a
                  href={links.deletion}
                  referrerPolicy="no-referrer"
                  aria-describedby={`${id}-deletion`}
                  className={cn(buttonVariants({ variant: 'destructive', size: 'lg' }), actionClass)}
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
