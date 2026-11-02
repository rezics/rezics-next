import { useEffect, useId, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { ContentItem, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import { initials } from '../threads/initials';
import { readManagedAccountsInventory } from './actions';
import {
  managedNavigationGuard,
  useManagedReaderLifetime,
  useManagedSessionReader,
  type ManagedSessionReader,
} from './managed-session-reader';
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

const nativeIO: ManagedAccountsIO = (data, signal) =>
  readManagedAccountsInventory({ data, ...(signal ? { signal } : {}) });
// Grow with translated labels while retaining native button and focus behavior.
const recoveryButtonClassName =
  'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal wrap-anywhere py-2 text-center';
const stateClassName = 'h-auto min-h-5 max-w-full shrink whitespace-normal wrap-anywhere';
const identityRowClassName =
  'min-h-14 max-w-full wrap-anywhere [&_[data-content-item-slot=title]]:line-clamp-none [&_[data-slot=list-row-link]]:min-h-11';

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
    <ContentItem
      className={identityRowClassName}
      title={name}
      headingLevel={4}
      href={managedAccountHref(settingsHref, account.id)}
      visual={
        <Avatar aria-hidden="true">
          <AvatarFallback>{initials(account.displayName || account.handle || '')}</AvatarFallback>
        </Avatar>
      }
      metadata={
        account.handle && account.displayName ? (
          <p className="min-w-0 max-w-full wrap-anywhere text-sm text-muted-foreground">@{account.handle}</p>
        ) : null
      }
      state={children}
    />
  );
}

function Failure({
  failure,
  retry,
  firstPage,
  busy,
  scope,
  headingId,
}: {
  failure: ManagedAccountsFailure;
  retry: () => void;
  firstPage?: (() => void) | undefined;
  busy: boolean;
  scope: 'inventory' | ManagedFeed;
  headingId: string;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const waitId = `${id}-wait`;
  const retryMetadata = useMemo(
    () => ({ status: failure.status, ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}) }),
    [failure],
  );
  const waiting = usePreferenceRetry(retryMetadata);
  return (
    <Alert
      variant="destructive"
      className="min-w-0 max-w-full wrap-anywhere"
      aria-labelledby={headingId}
      data-response-status={failure.status ?? ''}
      data-response-code={failure.code ?? ''}
      data-retry-after={failure.retryAfter}
    >
      <AlertTitle className="min-w-0">
        {failure.kind === 'denied' ? m.managed_denied_title() : m.managed_unavailable_title()}
      </AlertTitle>
      <AlertDescription className="min-w-0 space-y-3">
        <p id={descriptionId}>{failure.kind === 'denied' ? m.managed_denied_text() : m.managed_unavailable_text()}</p>
        {waiting ? (
          <p id={waitId} role="status" aria-labelledby={headingId}>
            {scope === 'inventory'
              ? m.settings_managed_inventory_retry_wait()
              : scope === 'organizations'
                ? m.settings_managed_organizations_retry_wait()
                : m.settings_managed_responsibilities_retry_wait()}
          </p>
        ) : null}
        <div role="group" aria-labelledby={headingId} className="flex min-w-0 max-w-full flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className={recoveryButtonClassName}
            aria-describedby={`${headingId} ${descriptionId}${waiting ? ` ${waitId}` : ''}`}
            disabled={busy || waiting}
            onClick={retry}
          >
            {m.settings_retry()}
          </Button>
          {firstPage ? (
            <Button
              type="button"
              variant="outline"
              className={recoveryButtonClassName}
              aria-describedby={`${headingId} ${descriptionId}${waiting ? ` ${waitId}` : ''}`}
              disabled={busy || waiting}
              onClick={firstPage}
            >
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
  headingId,
}: {
  feed: Pick<ManagedAccountsSnapshot['responsibilities'], 'next' | 'busy' | 'failure' | 'restartable'>;
  scope: ManagedFeed;
  preparing?: boolean;
  retry: () => void;
  firstPage: () => void;
  headingId: string;
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
          headingId={headingId}
        />
      ) : null}
      {!feed.failure && (feed.next !== null || preparing) ? (
        <div role="group" aria-labelledby={headingId}>
          <div
            role={feed.busy && !preparing ? 'status' : undefined}
            aria-labelledby={feed.busy && !preparing ? headingId : undefined}
          >
            <Button
              type="button"
              variant="outline"
              className={recoveryButtonClassName}
              aria-describedby={headingId}
              disabled={feed.busy}
              onClick={retry}
            >
              {feed.busy
                ? m.settings_managed_loading()
                : preparing
                  ? m.settings_retry()
                  : m.settings_managed_load_more()}
            </Button>
          </div>
        </div>
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
  current = () => true,
}: {
  current?: () => boolean;
  snapshot: ManagedAccountsSnapshot;
  settingsHref: string;
  more: (feed: ManagedFeed) => void;
  firstPage: (feed: ManagedFeed) => void;
  retry: () => void;
}) {
  const id = useId();
  const viewerHeadingId = `${id}-viewer`;
  const organizationsHeadingId = `${id}-organizations`;
  const responsibilitiesHeadingId = `${id}-responsibilities`;
  const { account, organizations, responsibilities } = snapshot;
  return (
    <div
      className="min-w-0 max-w-full space-y-6 wrap-anywhere"
      data-slot="managed-accounts"
      onClickCapture={managedNavigationGuard(current)}
      onAuxClickCapture={managedNavigationGuard(current)}
    >
      <Card className="min-w-0 max-w-full" role="region" aria-labelledby={viewerHeadingId} aria-busy={snapshot.loading}>
        <CardHeader className="min-w-0">
          <CardTitle className="min-w-0 wrap-anywhere">
            <ContentItemHeading level={3} id={viewerHeadingId}>
              {m.managed_your_account()}
            </ContentItemHeading>
          </CardTitle>
        </CardHeader>
        <CardContent className="min-w-0">
          {snapshot.loading || (!account && !snapshot.failure) ? (
            <p role="status" aria-labelledby={viewerHeadingId}>
              {m.settings_managed_loading()}
            </p>
          ) : null}
          {snapshot.failure ? (
            <Failure
              failure={snapshot.failure}
              retry={retry}
              busy={snapshot.loading}
              scope="inventory"
              headingId={viewerHeadingId}
            />
          ) : null}
          {account ? (
            <ul className="min-w-0 max-w-full" aria-label={m.managed_your_account()}>
              <IdentityRow account={account} settingsHref={settingsHref} />
            </ul>
          ) : null}
        </CardContent>
      </Card>
      {account ? (
        <>
          <Card
            className="min-w-0 max-w-full"
            role="region"
            aria-labelledby={organizationsHeadingId}
            aria-busy={organizations.busy}
          >
            <CardHeader className="min-w-0">
              <CardTitle className="min-w-0 wrap-anywhere">
                <ContentItemHeading level={3} id={organizationsHeadingId}>
                  {m.managed_organizations_title()}
                </ContentItemHeading>
              </CardTitle>
              <CardDescription className="min-w-0 wrap-anywhere">{m.managed_membership_text()}</CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-4">
              {organizations.state === 'preparing' ? (
                <p role="status" aria-labelledby={organizationsHeadingId}>
                  {m.managed_preparing_text()}
                </p>
              ) : organizations.items.length ? (
                <ul className="min-w-0 max-w-full" aria-label={m.managed_organizations_title()}>
                  {organizations.items.map(({ account, role }) => (
                    <IdentityRow key={account.id} account={account} settingsHref={settingsHref}>
                      <Badge variant="secondary" className={stateClassName}>
                        {role === 'owner' ? m.managed_owner() : m.managed_member()}
                      </Badge>
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
                headingId={organizationsHeadingId}
              />
            </CardContent>
          </Card>
          <Card
            className="min-w-0 max-w-full"
            role="region"
            aria-labelledby={responsibilitiesHeadingId}
            aria-busy={responsibilities.busy}
          >
            <CardHeader className="min-w-0">
              <CardTitle className="min-w-0 wrap-anywhere">
                <ContentItemHeading level={3} id={responsibilitiesHeadingId}>
                  {m.managed_operated_title()}
                </ContentItemHeading>
              </CardTitle>
              <CardDescription className="min-w-0 wrap-anywhere">
                {m.managed_responsibility_text()} {m.settings_managed_authority_text()}
              </CardDescription>
            </CardHeader>
            <CardContent className="min-w-0 space-y-4">
              {responsibilities.items.length ? (
                <ul className="min-w-0 max-w-full" aria-label={m.managed_operated_title()}>
                  {responsibilities.items.map((item) =>
                    item.account ? (
                      <IdentityRow key={item.reservationId} account={item.account} settingsHref={settingsHref}>
                        <Badge variant="secondary" className={stateClassName}>
                          {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                        </Badge>
                      </IdentityRow>
                    ) : (
                      <ContentItem
                        key={item.reservationId}
                        className={identityRowClassName}
                        title={m.settings_managed_identity_unavailable()}
                        headingLevel={4}
                        state={
                          <Badge variant="secondary" className={stateClassName}>
                            {item.state === 'current' ? m.managed_current() : m.managed_reconciling()}
                          </Badge>
                        }
                      />
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
                headingId={responsibilitiesHeadingId}
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
  owner,
}: {
  viewerId: string;
  settingsHref: string;
  io?: ManagedAccountsIO | undefined;
  owner?: ManagedSessionReader | undefined;
}) {
  const inventory = useMemo(() => new ManagedAccountsInventory(viewerId, io, owner?.isCurrent), [viewerId, io, owner]);
  const snapshot = useSyncExternalStore(inventory.subscribe, inventory.snapshot, inventory.snapshot);
  useManagedReaderLifetime(inventory.dispose, owner);
  useEffect(() => {
    void inventory.load();
  }, [inventory]);
  return (
    <ManagedAccountsView
      snapshot={snapshot}
      current={() => (!owner || owner.isCurrent()) && inventory.snapshot().account !== null}
      settingsHref={settingsHref}
      more={(feed) => void inventory.more(feed)}
      firstPage={(feed) => void inventory.firstPage(feed)}
      retry={() => void inventory.load()}
    />
  );
}

/** Viewer changes synchronously remove old pages, even before effect cleanup discards their pending reads. */
export function ManagedAccounts(props: {
  viewerId: string;
  settingsHref: string;
  io?: ManagedAccountsIO | undefined;
  owner?: ManagedSessionReader | undefined;
}) {
  return <ViewerInventory key={props.viewerId} {...props} />;
}

/** The public/SSR page never starts a private read. A session transition removes the entire prior inventory. */
export function ManagedAccountsSection({ io }: { io?: ManagedAccountsIO | undefined }) {
  const session = useSession();
  const location = useLocation();
  const owner = useManagedSessionReader(session.subject, session.subject);
  if (!owner.isCurrent()) return null;
  if (session.state !== 'signed-in' || !session.subject) return null;
  return (
    <ViewerInventory
      key={session.subject}
      viewerId={session.subject}
      settingsHref={location.publicHref}
      io={io}
      owner={owner}
    />
  );
}
