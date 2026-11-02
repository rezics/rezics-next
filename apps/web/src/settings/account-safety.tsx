import { withManagedReadDeadline } from './managed-read-deadline';
import { useContext, useEffect, useId, useSyncExternalStore, useMemo, useRef, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
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
import {
  managedNavigationGuard,
  useManagedReaderLifetime,
  useManagedSessionReader,
  type ManagedReaderCurrent,
} from './managed-session-reader';
import { preferenceRetryDeadline, usePreferenceRetry } from './preference-failure-retry';
import { sessionQuery } from '../session/query';

export type AccountSafetyProps =
  | {
      state: 'signed-in';
      accountId?: string | null;
      securityHref: string | null;
      csrfToken: string | null;
      onReload: () => void | Promise<unknown>;
      isCurrent?: ManagedReaderCurrent;
      renameAccount?: AccountRenameNavigation | null;
      renameRead?: {
        loading: boolean;
        reload: () => void;
        failures?: AccountRenameFailure[];
        retryAt?: number;
        isCurrent?: ManagedReaderCurrent;
      };
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
  private retired = false;
  private readonly lifetime = new AbortController();
  private listeners = new Set<() => void>();
  constructor(
    private readonly read: (signal?: AbortSignal) => Promise<AccountRenameResult>,
    private readonly accountId?: string | null,
    private readonly current: ManagedReaderCurrent = () => true,
    private readonly refreshSession?: () => Promise<unknown>,
  ) {}
  snapshot = () => {
    this.live();
    return this.value;
  };
  dispose = () => {
    if (this.retired) return;
    this.retired = true;
    this.lifetime.abort();
    this.active = false;
    this.publish({ loading: false, context: null, retryAt: 0 });
  };
  isCurrent = () => this.live() && this.active;
  private live() {
    if (!this.retired && !this.current()) this.dispose();
    return !this.retired;
  }
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
    if (!this.live()) return () => {};
    this.active = true;
    if (this.value.loading) void this.request();
    return () => {
      this.active = false;
      queueMicrotask(() => {
        if (!this.active) this.dispose();
      });
    };
  };
  reload = (): Promise<void> => {
    if (!this.live() || !this.active || this.value.loading || Date.now() < this.value.retryAt)
      return this.pending ?? Promise.resolve();
    return this.request(true);
  };
  private request(refresh = false): Promise<void> {
    if (!this.live() || !this.active) return Promise.resolve();
    if (this.pending) return this.pending;
    // Clear all old identity, links and failure metadata before awaiting a fresh read.
    this.publish({ loading: true, context: null, retryAt: 0 });
    this.pending = withManagedReadDeadline(async (signal) => {
      const ready =
        refresh && this.refreshSession
          ? Promise.resolve().then(() => (this.live() && this.active ? this.refreshSession!() : undefined))
          : Promise.resolve();
      await ready;
      signal.throwIfAborted();
      return this.live() && this.active ? this.read(signal) : { context: null };
    }, this.lifetime.signal)
      .catch((): AccountRenameResult => ({ context: null, failures: [{ kind: 'failed', status: null }] }))
      .then((result) => {
        if (!this.live() || !this.active) return;
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

/** Check both sides of module loading; the original explicit token never comes from a newer session. */
export async function readCurrentAccountRename(
  csrfToken: string,
  current: ManagedReaderCurrent,
  load = () => import('./account-rename-actions'),
  signal?: AbortSignal,
): Promise<AccountRenameResult> {
  if (!csrfToken || !current()) return { context: null };
  const { readAccountRename } = await load();
  if (!current() || signal?.aborted) return { context: null };
  const result = await readAccountRename({ headers: { 'X-CSRF-Token': csrfToken }, signal });
  return current() ? result : { context: null };
}

function CurrentAccountSafety(props: Extract<AccountSafetyProps, { state: 'signed-in' }>) {
  const client = useContext(QueryClientContext);
  const owner = useManagedSessionReader(props.accountId, props.accountId, props.csrfToken);
  const refreshSession = useMemo(
    () => async () => {
      if (owner.isCurrent() && client) await client.fetchQuery({ ...sessionQuery, staleTime: 0 });
    },
    [client, owner],
  );
  const region = useMemo(
    () =>
      new AccountRenameRegion(
        (signal) =>
          props.csrfToken
            ? readCurrentAccountRename(props.csrfToken, owner.isCurrent, undefined, signal)
            : Promise.resolve({ context: null }),
        props.accountId,
        owner.isCurrent,
        refreshSession,
      ),
    [props.accountId, props.csrfToken, owner, refreshSession],
  );
  useManagedReaderLifetime(region.dispose, owner);
  const snapshot = useSyncExternalStore(region.subscribe, region.snapshot, region.snapshot);
  const result: RenameSnapshot = owner.isCurrent() ? snapshot : { context: null, loading: true, retryAt: 0 };
  useEffect(region.mount, [region]);
  return (
    <AccountSafetyCard
      {...props}
      onReload={refreshSession}
      isCurrent={owner.isCurrent}
      renameAccount={result.context}
      renameRead={{
        loading: result.loading,
        reload: region.reload,
        isCurrent: region.isCurrent,
        ...(result.failures ? { failures: result.failures } : {}),
        retryAt: result.retryAt,
      }}
    />
  );
}

/** Native document submission has no in-page success receipt. Recovery never resubmits it. */
function AccountSignOut({
  props,
  id,
  actionClass,
}: {
  props: Extract<AccountSafetyProps, { state: 'signed-in' }>;
  id: string;
  actionClass: string;
}) {
  const [phase, setPhase] = useState<'idle' | 'csrf' | 'failed' | 'uncertain'>('idle');
  const [recovering, setRecovering] = useState(false);
  const locked = useRef(false);
  const unavailable = !props.csrfToken || phase === 'csrf';
  const recover = async () => {
    if (recovering) return;
    setRecovering(true);
    try {
      await props.onReload();
      locked.current = false;
      setPhase('idle');
    } catch {
      // Keep the original failure/uncertainty visible until a session read succeeds.
    } finally {
      setRecovering(false);
    }
  };
  return (
    <div className="space-y-3">
      <p id={`${id}-sign-out`} className="text-sm text-muted-foreground">
        {m.settings_account_sign_out_text()}
      </p>
      <form
        method="post"
        action="/auth/sign-out"
        className="m-0"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.csrfToken || !(props.isCurrent ?? alwaysCurrent)()) {
            setPhase('csrf');
            return;
          }
          if (locked.current || recovering) return;
          locked.current = true;
          setPhase('uncertain');
          try {
            // Keep the browser's ordinary POST/redirect, including the no-JavaScript fallback.
            HTMLFormElement.prototype.submit.call(event.currentTarget);
          } catch {
            setPhase('failed');
          }
        }}
      >
        <input type="hidden" name="csrf_token" value={props.csrfToken ?? ''} />
        <Button
          type="submit"
          variant="outline"
          size="lg"
          className={actionClass}
          disabled={unavailable || phase !== 'idle' || recovering}
          aria-describedby={`${id}-sign-out${unavailable || phase !== 'idle' ? ` ${id}-csrf` : ''}`}
        >
          {m.account_sign_out()}
        </Button>
      </form>
      {unavailable || phase !== 'idle' ? (
        <div className="space-y-2" aria-busy={recovering}>
          <p id={`${id}-csrf`} role="status" className="text-sm text-muted-foreground">
            {unavailable
              ? m.settings_account_csrf_unavailable()
              : phase === 'failed'
                ? m.settings_account_sign_out_failed()
                : m.settings_account_sign_out_uncertain()}
          </p>
          <Button
            type="button"
            variant="outline"
            className={actionClass}
            disabled={recovering}
            aria-label={`${m.settings_reload()}: ${m.account_sign_out()}`}
            onClick={() => void recover()}
          >
            {m.settings_reload()}
          </Button>
        </div>
      ) : null}
    </div>
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
            <div
              className="contents"
              onClickCapture={managedNavigationGuard(read?.isCurrent ?? alwaysCurrent)}
              onAuxClickCapture={managedNavigationGuard(read?.isCurrent ?? alwaysCurrent)}
            >
              <AccountRenameLink
                context={props.renameAccount ?? null}
                loading={read?.loading ?? false}
                failure={failure}
              />
            </div>
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
            <AccountSignOut props={props} id={id} actionClass={actionClass} />
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

const alwaysCurrent = () => true;
