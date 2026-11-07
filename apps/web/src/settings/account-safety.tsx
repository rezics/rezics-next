import { withManagedReadDeadline } from './managed-read-deadline';
import { useEffect, useId, useLayoutEffect, useSyncExternalStore, useMemo, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Separator } from '@rezics/ui/shadcn/separator';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { SignInPrompt } from '../threads/write-prompts';
import { accountSafetyLinks } from './account-safety-links';
import { AccountRenameLink } from './account-rename-link';
import type { AccountRenameNavigation, AccountRenameResult } from './account-rename-actions';
import { accountRenamePresentedFailure, type AccountRenameFailure } from './account-rename-data';
import {
  managedNavigationGuard,
  useManagedReaderLifetime,
  useManagedSessionReader,
  type ManagedReaderCurrent,
} from './managed-session-reader';
import { useSettingsAmbient } from './adapters/ambient-view.tsx';
import { preferenceRetryDeadline, usePreferenceRetry } from './preference-failure-retry';
import { useAccounts } from './managed-account-capabilities';
import type { AccountsCapability } from './ports/accounts';
import type { SettingsAmbient } from './ports/ambient';

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
    private readonly ambient: SettingsAmbient,
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
    if (!this.live() || !this.active || this.value.loading || this.ambient.now() < this.value.retryAt)
      return this.pending ?? Promise.resolve();
    return this.request(true);
  };
  private request(refresh = false): Promise<void> {
    if (!this.live() || !this.active) return Promise.resolve();
    if (this.pending) return this.pending;
    // Clear all old identity, links and failure metadata before awaiting a fresh read.
    this.publish({ loading: true, context: null, retryAt: 0 });
    this.pending = withManagedReadDeadline<AccountRenameResult>(
      async (signal) => {
        const ready =
          refresh && this.refreshSession
            ? Promise.resolve().then(() => (this.live() && this.active ? this.refreshSession!() : undefined))
            : Promise.resolve();
        await ready;
        signal.throwIfAborted();
        return this.live() && this.active ? this.read(signal) : { context: null };
      },
      this.lifetime.signal,
      this.ambient.timer,
    )
      .catch((): AccountRenameResult => ({ context: null, failures: [{ kind: 'failed', status: null }] }))
      .then((result) => {
        if (!this.live() || !this.active) return;
        if (this.accountId && result.context && result.context.accountId !== this.accountId) result = { context: null };
        const now = this.ambient.now();
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
  load: AccountsCapability['loadRename'],
  signal?: AbortSignal,
): Promise<AccountRenameResult> {
  if (!csrfToken || !current()) return { context: null };
  const { readAccountRename } = await load();
  if (!current() || signal?.aborted) return { context: null };
  const result = await readAccountRename({ headers: { 'X-CSRF-Token': csrfToken }, ...(signal ? { signal } : {}) });
  return current() ? result : { context: null };
}

function CurrentAccountSafety(props: Extract<AccountSafetyProps, { state: 'signed-in' }>) {
  const accounts = useAccounts();
  const owner = useManagedSessionReader(props.accountId, props.accountId, props.csrfToken);
  const refreshSession = useMemo(
    () => async () => {
      if (owner.isCurrent()) await accounts.refreshSession();
    },
    [accounts.refreshSession, owner],
  );
  const ambient = useSettingsAmbient();
  const region = useMemo(
    () =>
      new AccountRenameRegion(
        (signal) =>
          props.csrfToken
            ? readCurrentAccountRename(props.csrfToken, owner.isCurrent, accounts.loadRename, signal)
            : Promise.resolve({ context: null }),
        ambient,
        props.accountId,
        owner.isCurrent,
        refreshSession,
      ),
    [ambient, props.accountId, props.csrfToken, owner, refreshSession, accounts.loadRename],
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
  const attempt = useRef(0);
  const reloadControl = useRef<HTMLButtonElement>(null);
  const submitControl = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const ambient = useSettingsAmbient();
  const isCurrent = props.isCurrent ?? alwaysCurrent;
  const unavailable = !props.csrfToken || phase === 'csrf';
  const recover = async () => {
    if (recovering || !isCurrent()) return;
    const token = ++attempt.current;
    setRecovering(true);
    try {
      await withManagedReadDeadline(
        async () => {
          await props.onReload();
        },
        undefined,
        ambient.timer,
      );
      if (!isCurrent() || token !== attempt.current) return;
      locked.current = false;
      setPhase('idle');
    } catch {
      // Keep the original failure/uncertainty visible until a session read succeeds.
    } finally {
      if (isCurrent() && token === attempt.current) setRecovering(false);
    }
  };
  useLayoutEffect(() => {
    if (recovering || !restoreFocus.current) return;
    restoreFocus.current = false;
    if (!isCurrent()) return;
    const active = document.activeElement;
    const target = phase === 'idle' ? submitControl.current : reloadControl.current;
    if (active !== document.body && active !== reloadControl.current && active !== submitControl.current) return;
    target?.focus();
  }, [recovering, phase, isCurrent]);
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
          if (!isCurrent()) return;
          if (!props.csrfToken) {
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
          ref={submitControl}
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
            ref={reloadControl}
            type="button"
            variant="outline"
            className={actionClass}
            disabled={recovering}
            aria-label={`${m.settings_reload()}: ${m.account_sign_out()}`}
            onClick={(event) => {
              restoreFocus.current = event.detail === 0;
              if (isCurrent()) void recover();
            }}
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
  const ambient = useSettingsAmbient();
  const read = props.state === 'signed-in' ? props.renameRead : undefined;
  const failure = accountRenamePresentedFailure(read?.failures);
  const retryAt = useMemo(
    () =>
      read?.retryAt ??
      Math.max(0, ...(read?.failures ?? []).map((entry) => preferenceRetryDeadline(entry.retryAfter, ambient.now()))),
    [ambient, read?.retryAt, read?.failures],
  );
  const waiting = usePreferenceRetry(undefined, retryAt);
  const links = props.state === 'signed-in' ? accountSafetyLinks(props.securityHref) : null;
  const isCurrent = props.state === 'signed-in' ? (props.isCurrent ?? alwaysCurrent) : alwaysCurrent;
  const navigationGuard = managedNavigationGuard(isCurrent);
  const renameReload = useRef<HTMLButtonElement>(null);
  const restoreRenameFocus = useRef(false);
  useLayoutEffect(() => {
    if (read?.loading || !restoreRenameFocus.current) return;
    restoreRenameFocus.current = false;
    if (!isCurrent()) return;
    const active = document.activeElement;
    if (active !== document.body && active !== renameReload.current) return;
    renameReload.current?.focus();
  }, [read?.loading, isCurrent]);
  const actionClass =
    'h-auto min-h-11 w-full min-w-0 max-w-full whitespace-normal py-2 text-center [overflow-wrap:anywhere]';
  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader>
        <CardTitle>
          <h2 id="settings-account-heading">{m.settings_account_heading()}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent
        className="min-w-0 max-w-full space-y-6 [overflow-wrap:anywhere]"
        onClickCapture={navigationGuard}
        onAuxClickCapture={navigationGuard}
      >
        {props.state === 'signed-out' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{m.settings_account_sign_in_text()}</p>
            <SignInPrompt returnTo={props.returnTo} />
          </div>
        ) : (
          <>
            <AccountRenameLink
              context={isCurrent() ? (props.renameAccount ?? null) : null}
              loading={read?.loading ?? false}
              failure={isCurrent() ? failure : undefined}
            />
            {props.renameRead ? (
              <div aria-busy={props.renameRead.loading} className="space-y-2">
                <Button
                  ref={renameReload}
                  type="button"
                  variant="outline"
                  className={actionClass}
                  disabled={props.renameRead.loading || waiting}
                  aria-describedby={waiting ? `${id}-rename-wait` : undefined}
                  onClick={(event) => {
                    restoreRenameFocus.current = event.detail === 0;
                    if (isCurrent() && (read?.isCurrent?.() ?? true)) props.renameRead?.reload();
                  }}
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
