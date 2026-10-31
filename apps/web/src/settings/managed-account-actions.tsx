import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { accountProfileHref } from '../accounts/profile-editor/page';
import { usePreferenceRetry } from './preference-failure-retry';
import {
  ManagedAccountActionsRead,
  managedAccountActionNames,
  readManagedAccountActions,
  type ManagedAccountActionsIO,
  type ManagedAccountActionsTarget,
  type ManagedActionName,
} from './managed-account-actions-read';

const nativeIO: ManagedAccountActionsIO = (data) => readManagedAccountActions({ data });
const labels: Record<ManagedActionName, () => string> = {
  profile: () => m.managed_actions_profile(),
  rename: () => m.managed_actions_rename(),
  members: () => m.managed_actions_members(),
  transfer: () => m.managed_actions_transfer(),
  delete: () => m.managed_actions_delete(),
};

type ViewerProps = ManagedAccountActionsTarget & { viewerId: string; io?: ManagedAccountActionsIO };

function TargetActions({ viewerId, io = nativeIO, ...target }: ViewerProps) {
  const [read] = useState(() => new ManagedAccountActionsRead({ accountId: target.accountId, viewerId }, io));
  const { result, pending } = useSyncExternalStore(read.subscribe, read.snapshot, read.snapshot);
  const retryFailure = useMemo(
    () =>
      result?.state === 'unavailable'
        ? { status: result.status, ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) }
        : undefined,
    [result],
  );
  const waiting = usePreferenceRetry(retryFailure);
  useEffect(() => {
    void read.load();
  }, [read]);
  return (
    <Card data-slot="managed-account-actions" aria-busy={pending || result === null}>
      <CardHeader>
        <CardTitle>
          <h3>{m.managed_actions_title()}</h3>
        </CardTitle>
        <CardDescription>{m.managed_actions_selection()}</CardDescription>
      </CardHeader>
      <CardContent>
        {result?.state === 'ready' ? (
          <ul className="space-y-3" aria-label={m.managed_actions_title()}>
            {managedAccountActionNames(target, viewerId).map((name) => {
              const action = result.actions[name];
              // Only the installed Accounts-owned local profile route is currently mapped.
              const href =
                name === 'profile' && action.state === 'available' ? accountProfileHref(target.accountId) : null;
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
        ) : (
          <div className="space-y-3">
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
        )}
      </CardContent>
    </Card>
  );
}

/** Actual region, also used by isolated component stories with explicit viewer-owned read IO. */
export function ManagedAccountActionsForViewer(props: ViewerProps) {
  return (
    <TargetActions
      key={JSON.stringify([props.viewerId, props.accountId, props.nativeAccountKind, props.operated, props.self])}
      {...props}
    />
  );
}

/** Session changes and target selection discard previous capabilities before any new private read. */
export function ManagedAccountActions(props: ManagedAccountActionsTarget) {
  const session = useSession();
  if (session.state !== 'signed-in' || !session.subject || !session.csrfToken)
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
    />
  );
}
