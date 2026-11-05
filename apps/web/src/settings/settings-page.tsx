import { WatchesSection } from './watches';
import type { WatchManagementIO } from './watch-native';
import { sessionQuery, useSession } from '../session/query';
import { useQueryClient, type QueryClient, type QueryState } from '@tanstack/react-query';
import { useState, useEffect, useLayoutEffect, useRef, useSyncExternalStore, useCallback, type ReactNode } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { ProfileSection } from './profile';
import { ReadingCard } from './reading-card';
import { ShelfPreferencesCard } from './shelf-preferences';
import { ReadingNavigation, SettingsNavigationProvider, useSettingsNavigationOwner } from './reading-navigation';
import { DisplayPreferences } from './display-preferences';
import { NotificationsCard } from './notifications';
import { PublicViewsSection } from './public-views';
import type { NativePreferenceFailure, SettingsPage } from './preferences';
import { usePreferenceRetry } from './preference-failure-retry';
import { CollectionPrivacySection } from './collection-privacy';
import { VerificationSection } from './verification';
import { observeVerificationRead, verificationQueryKey } from './verification-recovery';
import { useOperation, useOperationAdmission } from '../kernel/exposure';
import { AccountSafetyCard, AccountSafetySection } from './account-safety';
import { ManagedAccountsSection } from './managed-accounts';
import type { ManagedAccountsIO } from './managed-accounts-read';
import { SectionsNavigation, settingsSections, type SettingsSection } from './sections-navigation';
import { ManagedAccountDetail } from './managed-account-detail';
import {
  managedAccountTarget,
  managedAccountsBackHref,
  selectAdmittedManagedAccountTarget,
} from './managed-account-detail-read';
import { readSettingsPage, saveNotifications, savePreferences } from './actions';
import type { ReadingIO } from './reading-preferences';
import type { NotificationEditorIO } from './notification-recovery';
import { SettingsSessionContext, useSettingsSessionOwner } from './settings-session-owner';
import { isWatchReturnReceipt, type WatchReturnReceipt } from './watch-controller';

const settingsWatchReturnKey = '__rezicsSettingsWatchReturn';
type SettingsWatchReturnCarrier = Readonly<{
  version: 1;
  origin: string;
  pathname: string;
  hash: string;
  locale: string;
  receipt: WatchReturnReceipt;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSettingsWatchReturn(state: unknown): { receipt: WatchReturnReceipt | null; present: boolean } {
  if (typeof globalThis.window === 'undefined' || !record(state)) return { receipt: null, present: false };
  const value = state[settingsWatchReturnKey];
  if (value === undefined) return { receipt: null, present: false };
  const keys = record(value) ? Object.keys(value).sort().join(',') : '';
  const carrier = value as Partial<SettingsWatchReturnCarrier>;
  const current = globalThis.window.location;
  const valid = keys === 'hash,locale,origin,pathname,receipt,version';
  if (
    !valid ||
    carrier.version !== 1 ||
    carrier.origin !== current.origin ||
    carrier.pathname !== current.pathname ||
    carrier.hash !== current.hash ||
    carrier.locale !== getLocale() ||
    !isWatchReturnReceipt(carrier.receipt)
  )
    return { receipt: null, present: true };
  return { receipt: carrier.receipt, present: true };
}

function withoutSettingsWatchReturn(state: unknown): Record<string, unknown> {
  const next = record(state) ? { ...state } : {};
  delete next[settingsWatchReturnKey];
  return next;
}

type PreferenceIO = {
  read: ReadingIO['read'];
  saveReading: (input: Parameters<ReadingIO['save']>[0], csrfToken: string) => ReturnType<ReadingIO['save']>;
  saveNotifications: (
    input: Parameters<NotificationEditorIO['save']>[0],
    csrfToken: string,
  ) => ReturnType<NotificationEditorIO['save']>;
};

export function ManagedAccountSelectionUnavailable({ backHref }: { backHref: string }) {
  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader className="min-w-0">
        <a
          className="inline-flex min-h-11 max-w-full items-center rounded-2xl px-3 py-2 text-sm leading-5 whitespace-normal break-words text-primary underline underline-offset-4 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          href={backHref}
        >
          {m.managed_back()}
        </a>
        <CardTitle>
          <h2 id="settings-account-heading">{m.managed_detail_title()}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p role="status">{m.settings_managed_navigation_unavailable()}</p>
      </CardContent>
    </Card>
  );
}

const nativePreferences: PreferenceIO = {
  read: () => readSettingsPage(),
  saveReading: (data, token) => savePreferences({ data, headers: { 'X-CSRF-Token': token } }),
  saveNotifications: (data, token) => saveNotifications({ data, headers: { 'X-CSRF-Token': token } }),
};

/** Every callback belongs to one mounted viewer, including recovery reads and late receipts. */
export function accountPreferenceIO(
  accountId: string,
  credential: () => string | null,
  confirmed: (version: number) => void,
  transport: PreferenceIO = nativePreferences,
  readCurrent: () => boolean = () => !!credential(),
): {
  reading: ReadingIO;
  shelf: ReadingIO;
  notifications: NotificationEditorIO & { confirmed: (version: number) => void };
} {
  const read = async () => {
    if (!readCurrent()) throw new Error('Settings viewer unavailable');
    const page = await transport.read();
    if (!readCurrent() || (page.signedIn && page.accountId !== accountId)) throw new Error('Settings viewer changed');
    return page;
  };
  const notify = (version: number) => {
    if (readCurrent()) confirmed(version);
  };
  const save: ReadingIO['save'] = async (input) => {
    const token = credential();
    if (!token) return { ok: false, reason: 'forbidden' };
    const result = await transport.saveReading(input, token);
    if (credential() !== token) throw new Error('Settings viewer changed');
    return result;
  };
  const reading = { read, save };
  return {
    reading,
    shelf: reading,
    notifications: {
      read,
      confirmed: notify,
      save: async (input) => {
        const token = credential();
        if (!token) return { ok: false, reason: 'forbidden' };
        const result = await transport.saveNotifications(input, token);
        if (credential() !== token) throw new Error('Settings viewer changed');
        return result;
      },
    },
  };
}

function SettingsFailure({
  state,
  failure,
  onRetry,
}: {
  state: 'closed' | 'preparing' | 'unavailable';
  failure: NativePreferenceFailure;
  onRetry: () => void;
}) {
  const waiting = usePreferenceRetry(failure);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-reading-heading">{m.settings_reading_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_reading_text()}</CardDescription>
      </CardHeader>
      <CardContent>
        <Alert
          variant={state === 'preparing' ? 'default' : 'destructive'}
          data-response-status={failure.status ?? ''}
          data-response-code={failure.code ?? ''}
          data-retry-after={failure.retryAfter}
        >
          <AlertTitle>
            {state === 'closed'
              ? m.settings_closed_title()
              : state === 'preparing'
                ? m.settings_preparing_title()
                : m.settings_unavailable_title()}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {state === 'closed'
                ? m.settings_closed_text()
                : state === 'preparing'
                  ? m.settings_preparing_text()
                  : m.settings_unavailable_text()}
            </p>
            {waiting ? <p>{m.settings_retry_wait()}</p> : null}
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-5"
              disabled={waiting}
              onClick={onRetry}
            >
              {m.settings_retry()}
            </Button>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

/** Keep visited editors and command identities alive, while excluding inactive jobs from focus and reading. */
function RetainedSettingsPanel({
  id,
  selected,
  children,
}: {
  id: SettingsSection['id'];
  selected: boolean;
  children: ReactNode;
}) {
  // Notification forms must exist in the first HTML for no-JavaScript save; other jobs stay lazy.
  const [visited, setVisited] = useState(selected || id === 'notifications');
  const [hydrated, setHydrated] = useState(false);
  const previous = useRef(selected);
  const panel = useRef<HTMLDivElement>(null);
  if (selected && !visited) setVisited(true);
  useLayoutEffect(() => {
    setHydrated(true);
    if (selected && !previous.current) {
      const heading = panel.current?.querySelector<HTMLElement>('h2') ?? panel.current;
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
    previous.current = selected;
  }, [selected]);
  if (!selected && !visited) return null;
  const inactive = hydrated && !selected;
  return (
    <div ref={panel} data-settings-panel={id} hidden={inactive} inert={inactive}>
      {children}
    </div>
  );
}

/** The Settings route owns the one-shot browser-history locator for a disclosed watch visit. */
export function SettingsWatchesOwner({ io }: { io?: WatchManagementIO | undefined }) {
  const location = useLocation();
  const navigation = useSettingsNavigationOwner();
  const [watchReturnEntry] = useState(() =>
    typeof globalThis.window === 'undefined'
      ? { receipt: null, present: false }
      : readSettingsWatchReturn(window.history.state),
  );
  useLayoutEffect(() => {
    if (watchReturnEntry.present && typeof globalThis.window !== 'undefined') {
      window.history.replaceState(withoutSettingsWatchReturn(window.history.state), '', window.location.href);
    }
  }, [watchReturnEntry]);
  const visitWatchTarget = useCallback(
    (receipt: WatchReturnReceipt, href: string) => {
      if (typeof globalThis.window === 'undefined') return true;
      const current = globalThis.window.location;
      let target: URL;
      try {
        if (!href.startsWith('/') || href.startsWith('//')) return false;
        target = new URL(href, current.origin);
      } catch {
        return false;
      }
      if (target.origin !== current.origin || !isWatchReturnReceipt(receipt)) return false;
      const carrier: SettingsWatchReturnCarrier = {
        version: 1,
        origin: current.origin,
        pathname: current.pathname,
        hash: current.hash,
        locale: getLocale(),
        receipt,
      };
      const commit = () => {
        const state = withoutSettingsWatchReturn(window.history.state);
        state[settingsWatchReturnKey] = carrier;
        window.history.replaceState(state, '', window.location.href);
      };
      return navigation?.prepareDeparture(location.pathname, target.pathname, commit) ?? (commit(), true);
    },
    [location.pathname, navigation],
  );
  return <WatchesSection io={io} initialReturn={watchReturnEntry.receipt} onVisitTarget={visitWatchTarget} />;
}

function SettingsSections({
  page,
  csrfToken,
  managedAccountsIO,
  watchesIO,
  preferenceIO,
}: {
  page: Extract<SettingsPage, { signedIn: true }> & { accountId: string };
  csrfToken: string | null;
  managedAccountsIO?: ManagedAccountsIO | undefined;
  watchesIO?: WatchManagementIO | undefined;
  preferenceIO: PreferenceIO;
}) {
  const collectionsAdmission = useOperationAdmission('account.collections');
  const collectionsAdmitted = collectionsAdmission === 'available';
  const verificationAdmitted = useOperation('agent_verification.request');
  const { subject: verificationAccountId } = useSession();
  const queryClient = useQueryClient();
  // The shared operation hook observes the enrolled viewer exposure used by these sections.
  const observeVerification = useCallback(
    (changed: () => void) => observeVerificationRead(queryClient, verificationAccountId, changed),
    [queryClient, verificationAccountId],
  );
  const verification = useSyncExternalStore(
    observeVerification,
    () => (verificationAccountId ? queryClient.getQueryState(verificationQueryKey(verificationAccountId)) : undefined),
    serverSessionRead,
  );
  const showVerification = verificationAdmitted && verification?.error?.message !== 'rezics-platform-closed';
  const location = useLocation();
  const router = useRouter();
  const [version, setVersion] = useState('preferences' in page ? page.preferences.version : 0);
  const owner = useSettingsSessionOwner(csrfToken, page.accountId)!;
  const [io] = useState(() => {
    return accountPreferenceIO(
      page.accountId,
      owner.credential,
      (next) => setVersion((current) => Math.max(current, next)),
      preferenceIO,
      owner.readCurrent,
    );
  });
  const notificationError = new URL(location.publicHref, 'https://rezics.local').searchParams.has('notificationError');
  const requestedManagedTarget = managedAccountTarget(location.publicHref);
  // The official generated native viewer/navigation callable is not installed yet.
  const managedTarget = selectAdmittedManagedAccountTarget(requestedManagedTarget, null);
  const managedSelectionUnavailable = requestedManagedTarget !== undefined && managedTarget === undefined;
  useEffect(() => {
    if (owner.readCurrent() && 'preferences' in page)
      setVersion((current) => Math.max(current, page.preferences.version));
  }, [page, owner]);
  const sections = settingsSections({
    display: true,
    notifications: 'preferences' in page,
    collections: collectionsAdmitted,
    verification: showVerification,
    readingState: 'preferences' in page ? undefined : page.state,
  });
  const hash = new URL(location.publicHref, 'https://rezics.local').hash.slice(1);
  // Query-only managed links are also destinations; an explicit category still permits navigating away.
  const selected =
    sections.find((section) => section.id === hash)?.id ??
    (!hash && managedTarget !== undefined ? 'account' : 'reading');
  const panels: Record<SettingsSection['id'], ReactNode> = {
    reading: (
      <section id="reading" aria-labelledby="settings-reading-heading" className="scroll-mt-6">
        {'preferences' in page ? (
          <ReadingNavigation csrfToken={csrfToken}>
            <ReadingCard
              initial={page.preferences}
              version={version}
              csrfToken={csrfToken}
              io={io.reading}
              onVersionChange={io.notifications.confirmed}
            />
          </ReadingNavigation>
        ) : (
          <SettingsFailure state={page.state} failure={page.failure} onRetry={() => void router.invalidate()} />
        )}
      </section>
    ),
    display: (
      <div id="display" className="scroll-mt-6 space-y-6">
        <DisplayPreferences />
        {'preferences' in page ? (
          <ShelfPreferencesCard
            initial={page.preferences}
            version={version}
            csrfToken={csrfToken}
            io={io.shelf}
            onVersionChange={io.notifications.confirmed}
          />
        ) : null}
      </div>
    ),
    notifications:
      'preferences' in page ? (
        <section id="notifications" aria-labelledby="settings-notifications-heading" className="scroll-mt-6">
          {page.page && page.notifications ? (
            <NotificationsCard
              key={csrfToken}
              initial={page.page}
              version={version}
              csrfToken={csrfToken}
              io={io.notifications}
              action={location.publicHref.split(/[?#]/, 1)[0]!}
              initialFailed={notificationError}
              onVersionChange={io.notifications.confirmed}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2 id="settings-notifications-heading">{m.settings_notifications_heading()}</h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Alert variant="destructive">
                  <AlertTitle>{m.settings_unavailable_title()}</AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>{m.settings_unavailable_text()}</p>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-5"
                      onClick={() => void router.invalidate()}
                    >
                      {m.settings_retry()}
                    </Button>
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          )}
        </section>
      ) : null,
    watches: <SettingsWatchesOwner io={watchesIO} />,
    privacy: <CollectionPrivacySection />,
    verification: (
      <section id="verification" aria-label={m.settings_verification_heading()} className="scroll-mt-6" tabIndex={-1}>
        <VerificationSection />
      </section>
    ),
    profile: (
      <section id="profile" aria-label={m.settings_profile_heading()} className="scroll-mt-6">
        <ProfileSection />
      </section>
    ),
    'public-activity': (
      <section id="public-activity" aria-label={m.settings_public_activity_heading()} className="scroll-mt-6">
        <PublicViewsSection />
      </section>
    ),
    account: (
      <section id="account" aria-labelledby="settings-account-heading" className="scroll-mt-6 space-y-6">
        {managedTarget !== undefined ? (
          <ManagedAccountDetail accountId={managedTarget} backHref={managedAccountsBackHref(location.publicHref)} />
        ) : managedSelectionUnavailable ? (
          <ManagedAccountSelectionUnavailable backHref={managedAccountsBackHref(location.publicHref)} />
        ) : (
          <>
            <AccountSafetySection
              state="signed-in"
              accountId={page.accountId}
              securityHref={page.securityHref}
              renameAccount={page.renameAccount ?? null}
              csrfToken={csrfToken}
              onReload={() => window.location.reload()}
            />
            <ManagedAccountsSection io={managedAccountsIO} />
          </>
        )}
      </section>
    ),
  };
  return (
    <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,48rem)] lg:justify-center">
      <SectionsNavigation
        sections={sections}
        selected={selected}
        onSelect={(id, event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          event.preventDefault();
          void router.navigate({ hash: id, search: true, resetScroll: false, hashScrollIntoView: false });
        }}
        admission={collectionsAdmission}
      />
      <div className="min-w-0">
        {sections.map(({ id }) => (
          <RetainedSettingsPanel key={id} id={id} selected={id === selected}>
            {panels[id]}
          </RetainedSettingsPanel>
        ))}
      </div>
    </div>
  );
}

const subscribeHydration = () => () => {};
const serverSessionRead = () => undefined;
const sessionRetries = new WeakMap<QueryClient, Promise<void>>();

/** Coalesce the deliberate native session read and the subsequent guarded page reload. */
export function retrySettingsSession(client: QueryClient, invalidate: () => Promise<unknown>): Promise<void> {
  const pending = sessionRetries.get(client);
  if (pending) return pending;
  const retry = client
    .fetchQuery({ ...sessionQuery, staleTime: 0 })
    .then((session) => {
      // Unavailable or identity-less responses cannot authorize another private page read.
      if (session.state === 'unavailable' || (session.state === 'signed-in' && !session.subject)) return;
      return invalidate();
    })
    .then(() => {})
    .finally(() => sessionRetries.delete(client));
  sessionRetries.set(client, retry);
  return retry;
}

/** The same fallback is used by the page and illustrative isolated recovery stories. */
export function SettingsSessionRecovery({
  state,
  sessionRead,
  retrying = false,
  retryFailed = false,
  onRetry,
}: {
  state: ReturnType<typeof useSession>['state'];
  sessionRead?: Pick<QueryState, 'status' | 'fetchStatus'> | undefined;
  retrying?: boolean;
  retryFailed?: boolean;
  onRetry: () => void;
}) {
  const failed = retryFailed || state === 'unavailable' || sessionRead?.status === 'error';
  const retryable = failed || retrying || state !== 'unknown';
  const pending = retrying || sessionRead?.fetchStatus === 'fetching' || !retryable;
  return (
    <div className="space-y-3">
      <p role="status" aria-busy={pending} className="text-sm text-muted-foreground">
        {failed ? m.settings_session_unavailable() : m.settings_sections_loading()}
      </p>
      {retryable ? (
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 max-w-full whitespace-normal break-words px-4 py-2 text-start leading-5"
          disabled={pending}
          onClick={onRetry}
        >
          {m.settings_retry()}
        </Button>
      ) : null}
      <div id="display" className="scroll-mt-6">
        <DisplayPreferences />
      </div>
    </div>
  );
}

/** Local browser choices remain available after the account session ends. */
export function SignedOutSettings({ returnTo }: { returnTo: string }) {
  return (
    <div className="space-y-8">
      <div id="display" className="scroll-mt-6">
        <DisplayPreferences />
      </div>
      <AccountSafetyCard state="signed-out" returnTo={returnTo} />
    </div>
  );
}

function OwnedSettingsPage({
  page,
  csrfToken,
  preferenceIO,
  managedAccountsIO,
  watchesIO,
  onRetry,
}: {
  page: Extract<SettingsPage, { signedIn: true }> & { accountId: string };
  csrfToken: string | null;
  preferenceIO: PreferenceIO;
  managedAccountsIO?: ManagedAccountsIO | undefined;
  watchesIO?: WatchManagementIO | undefined;
  onRetry: () => void;
}) {
  const owner = useSettingsSessionOwner(csrfToken, page.accountId)!;
  if (!owner.readCurrent()) return <SettingsSessionRecovery state="unavailable" onRetry={onRetry} />;
  return (
    <SettingsSessionContext.Provider value={owner}>
      <SettingsNavigationProvider>
        <SettingsSections
          page={page}
          csrfToken={csrfToken}
          preferenceIO={preferenceIO}
          managedAccountsIO={managedAccountsIO}
          watchesIO={watchesIO}
        />
      </SettingsNavigationProvider>
    </SettingsSessionContext.Provider>
  );
}

export function SettingsPageView({
  page,
  requestSession,
  managedAccountsIO,
  watchesIO,
  preferenceIO = nativePreferences,
}: {
  page: SettingsPage;
  csrfToken: string | null;
  /** Supplied only by the guarded route, from its request's established session query. */
  requestSession?: ReturnType<typeof useSession> | null;
  managedAccountsIO?: ManagedAccountsIO | undefined;
  watchesIO?: WatchManagementIO | undefined;
  preferenceIO?: PreferenceIO;
}) {
  const location = useLocation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false,
  );
  const browserSession = useSession();
  // Observe the installed query, as Inbox does; useSession owns the initial request.
  const observeSession = useCallback(
    (changed: () => void) =>
      queryClient.getQueryCache().subscribe(({ query }) => {
        if (query.queryKey.length === 1 && query.queryKey[0] === sessionQuery.queryKey[0]) changed();
      }),
    [queryClient],
  );
  const sessionRead = useSyncExternalStore(
    observeSession,
    () => queryClient.getQueryState(sessionQuery.queryKey),
    serverSessionRead,
  );
  const [generation, setGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  // Match the server snapshot on first hydration; later renders require the live browser identity.
  // A loader page or a seeded cache alone never establishes this route-bound session.
  const session = hydrated ? browserSession : (requestSession ?? browserSession);
  const requestedManagedTarget = managedAccountTarget(location.publicHref);
  // A direct or stale query parameter cannot substitute for native admission.
  const managedTarget = selectAdmittedManagedAccountTarget(requestedManagedTarget, null);
  const managedSelectionUnavailable = requestedManagedTarget !== undefined && managedTarget === undefined;
  const signedOut =
    !retrying && (session.state === 'signed-out' || (!hydrated && !page.signedIn && session.state === 'unknown'));
  const ready =
    !retrying &&
    !retryFailed &&
    sessionRead?.status !== 'error' &&
    page.signedIn &&
    session.state === 'signed-in' &&
    !!session.subject &&
    page.accountId === session.subject;
  const retry = () => {
    setRetrying(true);
    setRetryFailed(false);
    void retrySettingsSession(queryClient, () => router.invalidate())
      .then(() => setGeneration((current) => current + 1))
      .catch(() => setRetryFailed(true))
      .finally(() => setRetrying(false));
  };
  return (
    <article className="mx-auto w-full max-w-6xl space-y-8 px-4 text-foreground sm:px-6">
      <header>
        <PageHeading>{m.settings_heading()}</PageHeading>
      </header>
      {ready ? (
        <OwnedSettingsPage
          key={JSON.stringify([session.subject, session.csrfToken, generation])}
          page={{ ...page, accountId: page.accountId! }}
          csrfToken={session.csrfToken}
          preferenceIO={preferenceIO}
          managedAccountsIO={managedAccountsIO}
          watchesIO={watchesIO}
          onRetry={retry}
        />
      ) : signedOut ? (
        <SignedOutSettings returnTo={location.publicHref} />
      ) : (
        <div className="space-y-3">
          <SettingsSessionRecovery
            state={session.state}
            sessionRead={sessionRead}
            retrying={retrying}
            retryFailed={retryFailed}
            onRetry={retry}
          />
          {page.signedIn && managedSelectionUnavailable ? (
            <section id="account" aria-labelledby="settings-account-heading" className="scroll-mt-6 space-y-6">
              <ManagedAccountSelectionUnavailable backHref={managedAccountsBackHref(location.publicHref)} />
            </section>
          ) : null}
        </div>
      )}
    </article>
  );
}
