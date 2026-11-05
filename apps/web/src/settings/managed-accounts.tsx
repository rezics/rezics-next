import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { Avatar, AvatarFallback } from '@rezics/ui/shadcn/avatar';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { ContentItem, ContentItemHeading } from '@rezics/ui/content-item';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { initials } from '../threads/initials';
import { readManagedAccountsInventory } from './actions';
import {
  useManagedReaderLifetime,
  useManagedSessionReader,
  type ManagedSessionReader,
} from './managed-session-reader';
import { usePreferenceRetry } from './preference-failure-retry';
import {
  managedAccountHref,
  ManagedAccountsInventory,
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

type RowFeed = 'self' | ManagedFeed;
function IdentityRow({ account, children, href, feed, rowKey }: {
  account: ManagedIdentity; children?: ReactNode; href?: string | undefined; feed: RowFeed; rowKey: string;
}) {
  const name = account.displayName || (account.handle ? `@${account.handle}` : m.managed_unnamed());
  return (
    <ContentItem
      className={identityRowClassName}
      href={href}
      data-managed-feed={feed}
      data-managed-key={rowKey}
      title={name}
      headingLevel={4}
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
      state={<>
        {children}
        {href === undefined ? <p className="text-sm text-muted-foreground">{m.settings_managed_navigation_unavailable()}</p> : null}
      </>}
    />
  );
}

type Activation = (event: MouseEvent<HTMLButtonElement>) => void;

function Failure({
  failure,
  retry,
  firstPage,
  previous,
  busy,
  scope,
  headingId,
  waiting,
}: {
  failure: ManagedAccountsFailure;
  retry: Activation;
  firstPage?: Activation | undefined;
  previous?: Activation | undefined;
  busy: boolean;
  scope: 'inventory' | ManagedFeed;
  headingId: string;
  waiting: boolean;
}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const waitId = `${id}-wait`;
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
        {scope === 'organizations'
          ? m.managed_organizations_title()
          : scope === 'responsibilities'
            ? m.managed_operated_title()
            : failure.kind === 'denied'
              ? m.managed_denied_title()
              : m.managed_unavailable_title()}
      </AlertTitle>
      <AlertDescription className="min-w-0 space-y-3">
        <p id={descriptionId}>
          {failure.kind === 'denied'
            ? m.managed_denied_text()
            : scope === 'inventory'
              ? m.managed_unavailable_text()
              : m.settings_managed_page_failed()}
        </p>
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
          {previous ? (
            <Button
              type="button"
              variant="outline"
              className={recoveryButtonClassName}
              aria-describedby={`${headingId} ${descriptionId}${waiting ? ` ${waitId}` : ''}`}
              disabled={busy || waiting}
              onClick={previous}
            >
              {m.prq_previous()}
            </Button>
          ) : null}
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
  previous,
  headingId,
  waiting,
}: {
  feed: Pick<ManagedAccountsSnapshot['responsibilities'], 'next' | 'busy' | 'failure' | 'restartable' | 'previous'>;
  scope: ManagedFeed;
  preparing?: boolean;
  retry: Activation;
  firstPage: Activation;
  previous: Activation;
  headingId: string;
  waiting: boolean;
}) {
  const waitId = `${headingId}-wait`;
  return (
    <>
      {feed.failure ? (
        <Failure
          failure={feed.failure}
          retry={retry}
          firstPage={feed.restartable ? firstPage : undefined}
          previous={feed.previous ? previous : undefined}
          busy={feed.busy}
          scope={scope}
          headingId={headingId}
          waiting={waiting}
        />
      ) : null}
      {!feed.failure && (feed.next !== null || preparing || feed.previous || feed.restartable) ? (
        <div role="group" aria-labelledby={headingId} className="flex min-w-0 flex-wrap items-start gap-2">
          {waiting ? (
            <p id={waitId} role="status" aria-labelledby={headingId}>
              {scope === 'organizations'
                ? m.settings_managed_organizations_retry_wait()
                : m.settings_managed_responsibilities_retry_wait()}
            </p>
          ) : null}
          <div
            role={feed.busy && !preparing ? 'status' : undefined}
            aria-labelledby={feed.busy && !preparing ? headingId : undefined}
          >
            <Button
              type="button"
              variant="outline"
              className={recoveryButtonClassName}
              aria-describedby={`${headingId}${waiting ? ` ${waitId}` : ''}`}
              disabled={feed.busy || waiting || (feed.next === null && !preparing)}
              onClick={retry}
            >
              {feed.busy ? m.settings_managed_loading() : preparing ? m.settings_retry() : m.managed_next()}
            </Button>
          </div>
          {feed.previous ? (
            <Button
              type="button"
              variant="outline"
              className={recoveryButtonClassName}
              aria-describedby={`${headingId}${waiting ? ` ${waitId}` : ''}`}
              disabled={feed.busy || waiting}
              onClick={previous}
            >
              {m.prq_previous()}
            </Button>
          ) : null}
          {feed.restartable ? (
            <Button
              type="button"
              variant="outline"
              className={recoveryButtonClassName}
              aria-describedby={`${headingId}${waiting ? ` ${waitId}` : ''}`}
              disabled={feed.busy || waiting}
              onClick={firstPage}
            >
              {m.settings_managed_restart_list()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function ManagedAccountsView({
  snapshot,
  settingsHref,
  active = true,
  onVisit,
  navigation = () => snapshot.navigation,
  reader,
  more,
  previousPage,
  firstPage,
  retry,
  current = () => true,
}: {
  current?: () => boolean;
  active?: boolean | undefined;
  onVisit?: ((href: string) => void) | undefined;
  navigation?: (() => ManagedAccountsSnapshot['navigation']) | undefined;
  reader?: ManagedAccountsInventory | undefined;
  snapshot: ManagedAccountsSnapshot;
  settingsHref: string;
  more: (feed: ManagedFeed) => void;
  previousPage: (feed: ManagedFeed) => void;
  firstPage: (feed: ManagedFeed) => void;
  retry: () => void;
}) {
  const id = useId();
  const viewerHeadingId = `${id}-viewer`;
  const organizationsHeadingId = `${id}-organizations`;
  const responsibilitiesHeadingId = `${id}-responsibilities`;
  const { account, organizations, responsibilities } = snapshot;
  // One presentation timer only re-enables deliberate directory controls; it never dispatches a read.
  const waiting = usePreferenceRetry(undefined, snapshot.retryAt ?? 0);
  const inventoryWaitId = `${id}-inventory-wait`;
  const container = useRef<HTMLDivElement>(null);
  const source = useRef<{ feed: RowFeed; key: string; keyboard: boolean } | null>(null);
  const wasActive = useRef(active);
  useLayoutEffect(() => { source.current = null; }, [reader]);
  const admitted = (feed: RowFeed, key: string) => {
    const latest = navigation();
    return current() && (feed === 'self' ? latest?.self === key : latest?.[feed].includes(key) === true);
  };
  const destination = (feed: RowFeed, key: string, account: ManagedIdentity) =>
    admitted(feed, key) ? managedAccountHref(settingsHref, account.id) : undefined;
  const visit = (event: MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest('a');
    if (!anchor) return;
    const row = anchor.closest<HTMLElement>('[data-managed-key]')!;
    const feed = row.dataset.managedFeed as RowFeed;
    const key = row.dataset.managedKey!;
    if (!admitted(feed, key)) { event.preventDefault(); return; }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    source.current = { feed, key, keyboard: event.detail === 0 && document.activeElement === anchor };
    if (onVisit) { event.preventDefault(); onVisit(anchor.getAttribute('href')!); }
  };
  useLayoutEffect(() => {
    const returning = active && !wasActive.current;
    wasActive.current = active;
    if (!returning) return;
    const origin = source.current;
    source.current = null;
    if (!origin?.keyboard || !current() || (document.activeElement !== document.body && !container.current?.contains(document.activeElement))) return;
    const row = [...(container.current?.querySelectorAll<HTMLElement>('[data-managed-key]') ?? [])]
      .find((node) => node.dataset.managedFeed === origin.feed && node.dataset.managedKey === origin.key);
    const link = admitted(origin.feed, origin.key) ? row?.querySelector<HTMLAnchorElement>('a') : null;
    const heading = origin.feed === 'self' ? viewerHeadingId : origin.feed === 'organizations' ? organizationsHeadingId : responsibilitiesHeadingId;
    (link ?? document.getElementById(heading))?.focus();
  }, [active, current, navigation, viewerHeadingId, organizationsHeadingId, responsibilitiesHeadingId]);
  const previous = useRef(snapshot);
  const handoff = useRef<{ feed: ManagedFeed; activator: HTMLButtonElement } | null>(null);
  const activate =
    (feed: ManagedFeed, action: (feed: ManagedFeed) => void): Activation =>
    (event) => {
      if (!current() || snapshot.loading || snapshot[feed].busy || waiting) return;
      handoff.current =
        event.detail === 0 && document.activeElement === event.currentTarget
          ? { feed, activator: event.currentTarget }
          : null;
      action(feed);
    };
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = snapshot;
    const pending = handoff.current;
    if (!current() || snapshot.loading || !snapshot.account) {
      handoff.current = null;
      return;
    }
    if (!pending || !before[pending.feed].busy || snapshot[pending.feed].busy) return;
    handoff.current = null;
    if (snapshot[pending.feed].failure) return;
    if (
      document.activeElement !== pending.activator &&
      (pending.activator.isConnected || document.activeElement !== document.body)
    )
      return;
    const heading = pending.feed === 'organizations' ? organizationsHeadingId : responsibilitiesHeadingId;
    document.getElementById(heading)?.focus();
  }, [snapshot, current, organizationsHeadingId, responsibilitiesHeadingId]);
  return (
    <div
      className="min-w-0 max-w-full space-y-6 wrap-anywhere"
      ref={container}
      data-slot="managed-accounts"
      onClickCapture={(event) => {
        handoff.current = null;
        visit(event);
      }}
      onBlurCapture={(event) => {
        if ((event.target as EventTarget) === handoff.current?.activator) handoff.current = null;
      }}
      onAuxClickCapture={visit}
    >
      <Card className="min-w-0 max-w-full" role="region" aria-labelledby={viewerHeadingId} aria-busy={snapshot.loading}>
        <CardHeader className="min-w-0">
          <CardTitle className="min-w-0 wrap-anywhere">
            <ContentItemHeading level={3} id={viewerHeadingId} tabIndex={-1}>
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
              waiting={waiting}
            />
          ) : null}
          {account ? (
            <ul className="min-w-0 max-w-full" aria-label={m.managed_your_account()}>
              <IdentityRow account={account} feed="self" rowKey={account.id} href={destination('self', account.id, account)} />
            </ul>
          ) : null}
          {account ? (
            <div className="mt-3 space-y-3">
              {!snapshot.navigation ? <p className="text-sm text-muted-foreground">{m.settings_managed_navigation_unavailable()}</p> : null}
              {waiting ? (
                <p id={inventoryWaitId} role="status" aria-labelledby={viewerHeadingId}>
                  {m.settings_managed_inventory_retry_wait()}
                </p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className={recoveryButtonClassName}
                aria-describedby={`${viewerHeadingId}${waiting ? ` ${inventoryWaitId}` : ''}`}
                disabled={snapshot.loading || waiting}
                onClick={retry}
              >
                {m.managed_refresh()}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {account ? (
        <>
          <Card
            className="min-w-0 max-w-full"
            role="region"
            aria-labelledby={organizationsHeadingId}
            aria-busy={organizations.busy || snapshot.loading}
          >
            <CardHeader className="min-w-0">
              <CardTitle className="min-w-0 wrap-anywhere">
                <ContentItemHeading level={3} id={organizationsHeadingId} tabIndex={-1}>
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
                    <IdentityRow key={account.id} account={account} feed="organizations" rowKey={account.id} href={destination('organizations', account.id, account)}>
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
                feed={{ ...organizations, busy: organizations.busy || snapshot.loading }}
                scope="organizations"
                preparing={organizations.state === 'preparing'}
                retry={activate('organizations', more)}
                previous={activate('organizations', previousPage)}
                firstPage={activate('organizations', firstPage)}
                headingId={organizationsHeadingId}
                waiting={waiting}
              />
            </CardContent>
          </Card>
          <Card
            className="min-w-0 max-w-full"
            role="region"
            aria-labelledby={responsibilitiesHeadingId}
            aria-busy={responsibilities.busy || snapshot.loading}
          >
            <CardHeader className="min-w-0">
              <CardTitle className="min-w-0 wrap-anywhere">
                <ContentItemHeading level={3} id={responsibilitiesHeadingId} tabIndex={-1}>
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
                      <IdentityRow key={item.reservationId} account={item.account} feed="responsibilities" rowKey={item.reservationId} href={destination('responsibilities', item.reservationId, item.account)}>
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
                feed={{ ...responsibilities, busy: responsibilities.busy || snapshot.loading }}
                scope="responsibilities"
                retry={activate('responsibilities', more)}
                previous={activate('responsibilities', previousPage)}
                firstPage={activate('responsibilities', firstPage)}
                headingId={responsibilitiesHeadingId}
                waiting={waiting}
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
  active,
  onVisit,
}: {
  viewerId: string;
  settingsHref: string;
  active?: boolean | undefined;
  onVisit?: ((href: string) => void) | undefined;
  io?: ManagedAccountsIO | undefined;
  owner?: ManagedSessionReader | undefined;
}) {
  const locale = getLocale();
  const inventory = useMemo(
    () => new ManagedAccountsInventory(viewerId, io, () => (!owner || owner.isCurrent()) && getLocale() === locale),
    [viewerId, io, owner, locale],
  );
  const snapshot = useSyncExternalStore(inventory.subscribe, inventory.snapshot, inventory.snapshot);
  useManagedReaderLifetime(inventory.dispose, owner);
  useEffect(() => {
    void inventory.load();
  }, [inventory]);
  return (
    <ManagedAccountsView
      snapshot={snapshot}
      active={active}
      onVisit={onVisit}
      navigation={() => inventory.snapshot().navigation}
      reader={inventory}
      current={() => (!owner || owner.isCurrent()) && inventory.snapshot().account !== null}
      settingsHref={settingsHref}
      more={(feed) => void inventory.more(feed)}
      previousPage={(feed) => void inventory.previous(feed)}
      firstPage={(feed) => void inventory.firstPage(feed)}
      retry={() => void inventory.load()}
    />
  );
}

/** Viewer changes synchronously remove old pages, even before effect cleanup discards their pending reads. */
export function ManagedAccounts(props: {
  viewerId: string;
  settingsHref: string;
  active?: boolean | undefined;
  onVisit?: ((href: string) => void) | undefined;
  io?: ManagedAccountsIO | undefined;
  owner?: ManagedSessionReader | undefined;
}) {
  return <ViewerInventory key={props.viewerId} {...props} />;
}

/** The public/SSR page never starts a private read. A session transition removes the entire prior inventory. */
export function ManagedAccountsSection({ io }: { io?: ManagedAccountsIO | undefined }) {
  const session = useSession();
  const location = useLocation();
  const router = useRouter();
  const selected = !new URL(location.publicHref, 'https://rezics.local').searchParams.has('managedAccount');
  const owner = useManagedSessionReader(session.subject, session.subject, session.csrfToken);
  const [visited, setVisited] = useState<ManagedSessionReader | null>(() => (selected ? owner : null));
  if (!owner.isCurrent()) return null;
  if (session.state !== 'signed-in' || !session.subject) return null;
  if (selected && visited !== owner) setVisited(owner);
  // A direct detail URL does not fetch the directory to guess admission. Once visited, keep its bounded reader.
  if (visited !== owner) return null;
  return (
    <div hidden={!selected} inert={!selected}>
      <ViewerInventory
        key={session.subject}
        viewerId={session.subject}
        settingsHref={location.publicHref}
        io={io}
        owner={owner}
        active={selected}
        onVisit={(href) => void router.navigate({ href, hashScrollIntoView: false })}
      />
    </div>
  );
}
