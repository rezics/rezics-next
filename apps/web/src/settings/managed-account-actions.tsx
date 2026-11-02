import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { accountProfileHref } from '../accounts/profile-editor/page';
import {
  managedNavigationGuard,
  useManagedReaderLifetime,
  useManagedSessionReader,
  type ManagedSessionReader,
} from './managed-session-reader';
import { usePreferenceRetry } from './preference-failure-retry';
import {
  ManagedAccountActionsRead,
  managedAccountActionNames,
  readManagedAccountActions,
  type ManagedAccountActionsIO,
  type ManagedAccountActionsTarget,
  type ManagedActionName,
  type ManagedAuthNavigation,
} from './managed-account-actions-read';

const nativeIO: ManagedAccountActionsIO = (data, signal) => readManagedAccountActions({ data, signal });
const labels: Record<ManagedActionName, () => string> = {
  profile: () => m.managed_actions_profile(),
  rename: () => m.managed_actions_rename(),
  members: () => m.managed_actions_members(),
  transfer: () => m.managed_actions_transfer(),
  delete: () => m.managed_actions_delete(),
};

type ActionsProps = ManagedAccountActionsTarget & {
  authNavigation?: ManagedAuthNavigation | undefined;
  authCsrfToken?: string | null | undefined;
};
type ViewerProps = ActionsProps & {
  viewerId: string;
  csrfToken?: string | null;
  io?: ManagedAccountActionsIO;
  owner?: ManagedSessionReader;
};

function TargetActions({
  viewerId,
  csrfToken,
  authCsrfToken,
  io = nativeIO,
  authNavigation,
  owner,
  ...target
}: ViewerProps) {
  const read = useMemo(
    () => new ManagedAccountActionsRead({ accountId: target.accountId, viewerId }, io, owner?.isCurrent),
    [target.accountId, viewerId, io, owner],
  );
  useManagedReaderLifetime(read.dispose, owner);
  const { result, pending } = useSyncExternalStore(read.subscribe, read.snapshot, read.snapshot);
  const retryFailure = useMemo(
    () =>
      result?.state === 'unavailable'
        ? { status: result.status, ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) }
        : undefined,
    [result],
  );
  const waiting = usePreferenceRetry(retryFailure);
  const navigation =
    (!owner || owner.isCurrent()) &&
    authNavigation?.viewerId === viewerId &&
    authNavigation.accountId === target.accountId &&
    authCsrfToken === csrfToken
      ? authNavigation
      : undefined;
  useEffect(() => {
    void read.load();
  }, [read]);
  return (
    <Card
      data-slot="managed-account-actions"
      aria-busy={pending || result === null}
      onClickCapture={managedNavigationGuard(() => read.isCurrent())}
      onAuxClickCapture={managedNavigationGuard(() => read.isCurrent())}
    >
      <CardHeader>
        <CardTitle>
          <h3>{m.managed_actions_title()}</h3>
        </CardTitle>
        <CardDescription>{m.managed_actions_selection()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {result?.state !== 'ready' ? (
          <div className="space-y-3">
            {navigation ? <p className="font-medium">{m.managed_actions_profile()}</p> : null}
            <p
              role="status"
              data-response-status={result?.status ?? ''}
              data-response-code={result?.code ?? ''}
              data-retry-after={result?.retryAfter}
            >
              {pending || result === null
                ? m.managed_actions_loading()
                : result.state === 'denied'
                  ? m.managed_actions_denied()
                  : m.managed_actions_unavailable()}
            </p>
            {result?.state === 'unavailable' ? (
              <>
                {waiting ? <p role="status">{m.settings_retry_wait()}</p> : null}
                <Button type="button" variant="outline" disabled={pending || waiting} onClick={() => void read.retry()}>
                  {m.managed_actions_retry()}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {result?.state === 'ready' || navigation ? (
          <ul className="space-y-3" aria-label={m.managed_actions_title()}>
            {managedAccountActionNames(target, viewerId).map((name) => {
              // Profile and Auth entry observations have independent sources and failure/retry lifetimes.
              if (name === 'profile' && result?.state !== 'ready') return null;
              const authAction = name === 'profile' ? undefined : navigation?.actions[name];
              const action =
                name === 'profile' && result?.state === 'ready'
                  ? result.actions.profile
                  : (authAction ?? { state: 'unavailable' as const, owner: 'Accounts authActions' });
              const href =
                action.state === 'available'
                  ? name === 'profile'
                    ? accountProfileHref(target.accountId)
                    : authAction?.state === 'available'
                      ? authAction.href
                      : null
                  : null;
              return (
                <li key={name} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  {href ? (
                    <a
                      href={href}
                      referrerPolicy="no-referrer"
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'lg' }),
                        'h-auto min-h-11 max-w-full whitespace-normal py-2 text-start',
                      )}
                    >
                      {labels[name]()}
                    </a>
                  ) : (
                    <div
                      className="min-w-0 py-2"
                      data-unavailable-owner={action.state === 'unavailable' ? action.owner : undefined}
                    >
                      <p className="break-words font-medium">{labels[name]()}</p>
                      <p className="text-sm text-muted-foreground">
                        {action.state === 'denied' ? m.managed_actions_denied() : m.managed_actions_unavailable()}
                      </p>
                    </div>
                  )}
                  {href ? <span className="text-sm text-muted-foreground">{m.managed_actions_available()}</span> : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Actual region, also used by isolated component stories with explicit viewer-owned read IO. */
export function ManagedAccountActionsForViewer(props: ViewerProps) {
  return (
    <TargetActions
      key={JSON.stringify([
        props.viewerId,
        props.csrfToken,
        props.accountId,
        props.nativeAccountKind,
        props.operated,
        props.self,
      ])}
      {...props}
    />
  );
}

/** Session changes and target selection discard previous capabilities before any new private read. */
export function ManagedAccountActions(props: ActionsProps) {
  const session = useSession();
  const owner = useManagedSessionReader(
    session.subject,
    JSON.stringify([props.accountId, props.nativeAccountKind, props.operated, props.self]),
    session.csrfToken,
  );
  const proof = useRef<{ navigation: typeof props.authNavigation; owner: ManagedSessionReader } | null>(null);
  if (props.authNavigation && proof.current?.navigation !== props.authNavigation && owner.isCurrent())
    proof.current = { navigation: props.authNavigation, owner };
  if (!owner.isCurrent() || session.state !== 'signed-in' || !session.subject || !session.csrfToken)
    return (
      <p role="status">{session.state === 'unknown' ? m.managed_actions_loading() : m.managed_actions_denied()}</p>
    );
  return (
    <ManagedAccountActionsForViewer
      key={JSON.stringify([
        session.subject,
        session.csrfToken,
        props.accountId,
        props.nativeAccountKind,
        props.operated,
        props.self,
      ])}
      {...props}
      viewerId={session.subject}
      owner={owner}
      authNavigation={proof.current?.owner === owner ? props.authNavigation : undefined}
      csrfToken={session.csrfToken}
    />
  );
}
