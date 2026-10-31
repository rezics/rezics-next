import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { initials } from '../threads/initials';
import { readManagedAccountsInventory } from './actions';
import { usePreferenceRetry } from './preference-failure-retry';
import {
  ManagedAccountsInventory,
  managedAccountHref,
  type ManagedAccountsFailure,
  type ManagedAccountsIO,
  type ManagedAccountsSnapshot,
  type ManagedFeed,
  type ManagedIdentity,
} from './managed-accounts-read';

const nativeIO: ManagedAccountsIO = (data) => readManagedAccountsInventory({ data });

function IdentityRow({
  account,
  settingsHref,
  children,
}: {
  account: ManagedIdentity;
  settingsHref: string;
  children?: ReactNode;
}) {
  const name = account.displayName || (account.handle ? `@${account.handle}` : m.managed_unnamed());
  return (
    <ListRow className="flex min-h-16 min-w-0 flex-wrap items-center gap-3 py-3">
      <ListRowLink href={managedAccountHref(settingsHref, account.id)}>{name}</ListRowLink>
      <Avatar aria-hidden="true">
        <AvatarFallback>{initials(account.displayName || account.handle || '')}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 basis-32">
        <p aria-hidden="true" className="break-words font-medium text-primary">
          {name}
        </p>
        {account.handle && account.displayName ? (
          <p className="break-words text-sm text-muted-foreground">@{account.handle}</p>
        ) : null}
      </div>
      {children}
    </ListRow>
  );
}

function Failure({
  failure,
  retry,
  firstPage,
  busy,
  scope,
}: {
  failure: ManagedAccountsFailure;
  retry: () => void;
  firstPage?: (() => void) | undefined;
  busy: boolean;
  scope: 'inventory' | ManagedFeed;
}) {
  const retryMetadata = useMemo(
    () => ({ status: failure.status, ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) }),
    [failure],
  );
  const waiting = usePreferenceRetry(retryMetadata);
  return (
    <Alert
      variant="destructive"
      data-response-status={failure.status ?? ''}
      data-response-code={failure.code ?? ''}
      data-retry-after={failure.retryAfter}
    >
      <AlertTitle>{failure.kind === 'denied' ? m.managed_denied_title() : m.managed_unavailable_title()}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{failure.kind === 'denied' ? m.managed_denied_text() : m.managed_unavailable_text()}</p>
        {waiting ? (
          <p role="status">
            {scope === 'inventory'
              ? m.settings_managed_inventory_retry_wait()
              : scope === 'organizations'
                ? m.settings_managed_organizations_retry_wait()
                : m.settings_managed_responsibilities_retry_wait()}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={busy || waiting} onClick={retry}>
            {m.settings_retry()}
          </Button>
          {firstPage ? (
            <Button type="button" variant="outline" className="min-h-11" disabled={busy || waiting} onClick={firstPage}>
              {m.settings_managed_restart_list()}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

function FeedActions({
  feed,
  scope,
  preparing = false,
  retry,
  firstPage,
}: {
  feed: Pick<ManagedAccountsSnapshot['responsibilities'], 'next' | 'busy' | 'failure' | 'restartable'>;
  scope: ManagedFeed;
  preparing?: boolean;
  retry: () => void;
  firstPage: () => void;
}) {
  return (
    <>
      {feed.failure ? (
        <Failure
          failure={feed.failure}
          retry={retry}
          firstPage={feed.restartable && feed.next !== null && !preparing ? firstPage : undefined}
          busy={feed.busy}
          scope={scope}
        />
      ) : null}
      {!feed.failure && (feed.next !== null || preparing) ? (
        <Button type="button" variant="outline" className="min-h-11" disabled={feed.busy} onClick={retry}>
          {feed.busy ? m.settings_managed_loading() : preparing ? m.settings_retry() : m.settings_managed_load_more()}
        </Button>
      ) : null}
    </>
  );
}

export function ManagedAccountsView({
  snapshot,
  settingsHref,
  more,
  firstPage,
  retry,
}: {
  snapshot: ManagedAccountsSnapshot;
  settingsHref: string;
  more: (feed: ManagedFeed) => void;
  firstPage: (feed: ManagedFeed) => void;
  retry: () => void;
}) {
  const { account, organizations, responsibilities } = snapshot;
  return (
    <div className="space-y-6" data-slot="managed-accounts">
      {snapshot.loading || (!account && !snapshot.failure) ? <p role="status">{m.settings_managed_loading()}</p> : null}
      {snapshot.failure ? (
        <Failure failure={snapshot.failure} retry={retry} busy={snapshot.loading} scope="inventory" />
      ) : null}
      {account ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <h3>{m.managed_your_account()}</h3>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul aria-label={m.managed_your_account()}>
                <IdentityRow account={account} settingsHref={settingsHref} />
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h3>{m.managed_organizations_title()}</h3>
              </CardTitle>
              <CardDescription>{m.managed_membership_text()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4" aria-busy={organizations.busy}>
              {organizations.state === 'preparing' ? (
                <p role="status">{m.managed_preparing_text()}</p>
              ) : organizations.items.length ? (
                <ul aria-label={m.managed_organizations_title()}>
                  {organizations.items.map(({ account, role }) => (
                    <IdentityRow key={account.id} account={account} settingsHref={settingsHref}>
                      <Badge variant="secondary">{role === 'owner' ? m.managed_owner() : m.managed_member()}</Badge>
                    </IdentityRow>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {organizations.next !== null ? m.managed_no_current_page() : m.managed_no_organizations()}
                </p>
              )}
              <FeedActions
                feed={organizations}
                scope="organizations"
                preparing={organizations.state === 'preparing'}
                retry={() => more('organizations')}
                firstPage={() => firstPage('organizations')}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>
                <h3>{m.managed_operated_title()}</h3>
              </CardTitle>
              <CardDescription>
                {m.managed_responsibility_text()} {m.settings_managed_authority_text()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4" aria-busy={responsibilities.busy}>
              {responsibilities.items.length ? (
                <ul aria-label={m.managed_operated_title()}>
                  {responsibilities.items.map((item) =>
                    item.account ? (
                      <IdentityRow key={item.reservationId} account={item.account} settingsHref={settingsHref}>
                        <Badge variant="secondary">
                          {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                        </Badge>
                      </IdentityRow>
                    ) : (
                      <ListRow key={item.reservationId} className="space-y-2 py-3">
                        <p className="text-sm text-muted-foreground">{m.settings_managed_identity_unavailable()}</p>
                        <Badge variant="secondary">
                          {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                        </Badge>
                      </ListRow>
                    ),
                  )}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {responsibilities.next !== null
                    ? m.settings_managed_no_responsibilities_page()
                    : m.managed_no_responsibilities()}
                </p>
              )}
              <FeedActions
                feed={responsibilities}
                scope="responsibilities"
                retry={() => more('responsibilities')}
                firstPage={() => firstPage('responsibilities')}
              />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function ViewerInventory({
  viewerId,
  settingsHref,
  io = nativeIO,
}: {
  viewerId: string;
  settingsHref: string;
  io?: ManagedAccountsIO | undefined;
}) {
  const [inventory] = useState(() => new ManagedAccountsInventory(viewerId, io));
  const snapshot = useSyncExternalStore(inventory.subscribe, inventory.snapshot, inventory.snapshot);
  useEffect(() => {
    void inventory.load();
    return () => inventory.dispose();
  }, [inventory]);
  return (
    <ManagedAccountsView
      snapshot={snapshot}
      settingsHref={settingsHref}
      more={(feed) => void inventory.more(feed)}
      firstPage={(feed) => void inventory.firstPage(feed)}
      retry={() => void inventory.load()}
    />
  );
}

/** Viewer changes synchronously remove old pages, even before effect cleanup discards their pending reads. */
export function ManagedAccounts(props: { viewerId: string; settingsHref: string; io?: ManagedAccountsIO | undefined }) {
  return <ViewerInventory key={props.viewerId} {...props} />;
}

/** The public/SSR page never starts a private read. A session transition removes the entire prior inventory. */
export function ManagedAccountsSection({ io }: { io?: ManagedAccountsIO | undefined }) {
  const session = useSession();
  const location = useLocation();
  if (session.state !== 'signed-in' || !session.subject) return null;
  return (
    <ManagedAccounts key={session.subject} viewerId={session.subject} settingsHref={location.publicHref} io={io} />
  );
}
