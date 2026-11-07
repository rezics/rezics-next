import { WatchesSection } from './watches';
import type { WatchManagementIO } from './watch-native';
import {
  productionSettingsShellPort,
  useSettingsOperation,
  useSettingsOperationAdmission,
  useSettingsSession,
  useSettingsShell,
} from './adapters/shell';
import type { SettingsSessionObservation } from './ports/shell';
import { useQueryClient, type QueryClient, type QueryState } from '@tanstack/react-query';
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  useCallback,
  type MouseEventHandler,
  type ReactNode,
} from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { m } from '../paraglide/messages.js';
import { ProfileSection } from './profile';
import { ReadingCard } from './reading-card';
import { BoundCollectionPrivacySection, BoundShelfPreferencesCard } from './adapters/library-view.tsx';
import { ReadingNavigation, SettingsNavigationProvider, useSettingsNavigationOwner } from './reading-navigation';
import { DisplayPreferences } from './display-preferences';
import { NotificationsCard } from './notifications';
import { PublicViewsSection } from './public-views';
import type { NativePreferenceFailure, SettingsPage } from './preferences';
import { usePreferenceRetry } from './preferences';
import { VerificationSection } from './verification';
import { observeVerificationRead, verificationQueryKey } from './verification-recovery';
import { AccountSafetyCard, AccountSafetySection } from './account-safety';
import { ManagedAccountsSection } from './managed-accounts';
import type { ManagedAccountsIO } from './managed-accounts-read';
import { SectionsNavigation, settingsSections, type SettingsSection } from './sections-navigation';
import { ManagedAccountDetail } from './managed-account-detail';
import { managedAccountTarget, managedAccountsBackHref } from './managed-account-detail-read';
import { readSettingsPage, saveNotifications, savePreferences } from './actions';
import type { ReadingIO } from './reading-preferences';
import type { NotificationEditorIO } from './notification-recovery';
import { SettingsSessionContext, useSettingsSessionOwner } from './settings-session-owner';
import { isWatchReturnReceipt, type WatchReturnReceipt } from './watch-controller';
import {
  readSettingsWatchReturn,
  settingsWatchReturnCarrier,
  settingsWatchReturnKey,
  withoutSettingsWatchReturn,
} from './settings-return';
import {
  SettingsReturnProvider,
  useSettingsProfileReturn,
  useSettingsSectionFocus,
  type SettingsSectionFocus,
} from './settings-return-context';
import type { SettingsContentPort } from './ports/content';

type PreferenceIO = {
  read: ReadingIO['read'];
  saveReading: (input: Parameters<ReadingIO['save']>[0], csrfToken: string) => ReturnType<ReadingIO['save']>;
  saveNotifications: (
    input: Parameters<NotificationEditorIO['save']>[0],
    csrfToken: string,
  ) => ReturnType<NotificationEditorIO['save']>;
};

export function ManagedAccountSelectionUnavailable({
  backHref,
  onBack,
}: {
  backHref: string;
  onBack?: MouseEventHandler<HTMLAnchorElement> | undefined;
}) {
  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader className="min-w-0">
        <a
          className="inline-flex min-h-11 max-w-full items-center rounded-2xl px-3 py-2 text-sm leading-5 whitespace-normal break-words text-primary underline underline-offset-4 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          href={backHref}
          onClick={onBack}
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
  const lastFocus = useRef<HTMLElement | null>(null);
  const sectionFocus = useSettingsSectionFocus();
  if (selected && !visited) setVisited(true);
  useLayoutEffect(() => {
    setHydrated(true);
    if (selected && !previous.current) {
      const heading = panel.current?.querySelector<HTMLElement>('h2, [data-settings-focus-region]') ?? panel.current;
      const returned = panel.current?.querySelector<HTMLElement>('[data-settings-return-focus]');
      const remembered = lastFocus.current;
      const exact =
        returned &&
        returned.isConnected &&
        !returned.hasAttribute('disabled') &&
        returned.getAttribute('aria-disabled') !== 'true'
          ? returned
          : remembered &&
              remembered.isConnected &&
              panel.current?.contains(remembered) &&
              !remembered.hasAttribute('disabled') &&
              remembered.getAttribute('aria-disabled') !== 'true'
            ? remembered
            : null;
      if (sectionFocus === 'keyboard') {
        const target = exact ?? heading;
        if (target) {
          if (target.tabIndex < 0) target.tabIndex = -1;
          target.focus();
        }
        returned?.removeAttribute('data-settings-return-focus');
      }
    }
    previous.current = selected;
  }, [selected, sectionFocus]);
  if (!selected && !visited) return null;
  const inactive = hydrated && !selected;
  return (
    <div
      ref={panel}
      data-settings-panel={id}
      hidden={inactive}
      inert={inactive}
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) lastFocus.current = event.target;
      }}
    >
      {children}
    </div>
  );
}

/** The Settings route owns the one-shot browser-history locator for a disclosed watch visit. */
export function SettingsWatchesOwner({
  io,
  initialReturn,
}: {
  io?: WatchManagementIO | undefined;
  initialReturn?: WatchReturnReceipt | null;
}) {
  const location = useLocation();
  const navigation = useSettingsNavigationOwner();
  const profileReturn = useSettingsProfileReturn();
  const [localReturn] = useState(() =>
    initialReturn !== undefined
      ? { receipt: initialReturn, present: false }
      : typeof globalThis.window === 'undefined'
        ? { receipt: null, present: false }
        : readSettingsWatchReturn(window.history.state),
  );
  useLayoutEffect(() => {
    if (localReturn.present && typeof globalThis.window !== 'undefined') {
      window.history.replaceState(withoutSettingsWatchReturn(window.history.state), '', window.location.href);
    }
  }, [localReturn]);
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
      const carrier = settingsWatchReturnCarrier(receipt, profileReturn?.capture() ?? null);
      if (!carrier) return false;
      const commit = () => {
        const state = withoutSettingsWatchReturn(window.history.state);
        state[settingsWatchReturnKey] = carrier;
        window.history.replaceState(state, '', window.location.href);
      };
      return navigation?.prepareDeparture(location.pathname, target.pathname, commit) ?? (commit(), true);
    },
    [location.pathname, navigation, profileReturn],
  );
  return <WatchesSection io={io} initialReturn={localReturn.receipt} onVisitTarget={visitWatchTarget} />;
}

function SettingsSections({
  page,
  csrfToken,
  managedAccountsIO,
  watchesIO,
  preferenceIO,
  content,
  watchReturn = null,
  profileReturn = null,
  ShelfCard = BoundShelfPreferencesCard,
  PrivacySection = BoundCollectionPrivacySection,
}: {
  page: Extract<SettingsPage, { signedIn: true }> & { accountId: string };
  csrfToken: string | null;
  managedAccountsIO?: ManagedAccountsIO | undefined;
  watchesIO?: WatchManagementIO | undefined;
  preferenceIO: PreferenceIO;
  content: SettingsContentPort;
  watchReturn?: WatchReturnReceipt | null;
  profileReturn?: import('./settings-return').ProfileReturnSnapshot | null;
  ShelfCard?: typeof BoundShelfPreferencesCard;
  PrivacySection?: typeof BoundCollectionPrivacySection;
}) {
  const collectionsAdmission = useSettingsOperationAdmission('account.collections');
  const collectionsAdmitted = collectionsAdmission === 'available';
  const verificationAdmitted = useSettingsOperation('agent_verification.request');
  const { subject: verificationAccountId } = useSettingsSession();
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
  const [sectionFocus, setSectionFocus] = useState<SettingsSectionFocus>(null);
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
  // Native management GET independently authorizes direct selections; URL identity grants no access.
  const managedTarget = requestedManagedTarget ?? undefined;
  const managedSelectionUnavailable = requestedManagedTarget !== undefined && managedTarget === undefined;
  const managedBackHref = managedAccountsBackHref(location.publicHref);
  const returnToManagedDirectory: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    void router.navigate({ href: managedBackHref, hashScrollIntoView: false });
  };
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
          <ShelfCard
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
    watches: <SettingsWatchesOwner io={watchesIO} initialReturn={watchReturn} />,
    privacy: <PrivacySection />,
    verification: (
      <section id="verification" aria-label={m.settings_verification_heading()} className="scroll-mt-6" tabIndex={-1}>
        <VerificationSection />
      </section>
    ),
    profile: (
      <section id="profile" aria-label={m.settings_profile_heading()} className="scroll-mt-6">
        <ProfileSection content={content} />
      </section>
    ),
    'public-activity': (
      <section id="public-activity" aria-label={m.settings_public_activity_heading()} className="scroll-mt-6">
        <PublicViewsSection mediaFailure={content.mediaFailure} />
      </section>
    ),
    account: (
      <section id="account" aria-labelledby="settings-account-heading" className="scroll-mt-6 space-y-6">
        {managedTarget !== undefined ? (
          <ManagedAccountDetail
            accountId={managedTarget}
            backHref={managedBackHref}
            onBack={returnToManagedDirectory}
            initials={content.initials}
            mediaFailure={content.mediaFailure}
          />
        ) : managedSelectionUnavailable ? (
          <ManagedAccountSelectionUnavailable backHref={managedBackHref} onBack={returnToManagedDirectory} />
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
          </>
        )}
        <ManagedAccountsSection io={managedAccountsIO} initials={content.initials} />
      </section>
    ),
  };
  return (
    <SettingsReturnProvider initialProfile={profileReturn} sectionFocus={sectionFocus}>
      <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,48rem)] lg:justify-center">
        <SectionsNavigation
          sections={sections}
          selected={selected}
          onSelect={(id, event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            event.preventDefault();
            setSectionFocus(event.detail === 0 ? 'keyboard' : 'pointer');
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
    </SettingsReturnProvider>
  );
}

const subscribeHydration = () => () => {};
const serverSessionRead = () => undefined;
const sessionRetries = new WeakMap<QueryClient, Promise<void>>();

/** Coalesce the deliberate native session read and the subsequent guarded page reload. */
export function retrySettingsSession(client: QueryClient, invalidate: () => Promise<unknown>): Promise<void> {
  const pending = sessionRetries.get(client);
  if (pending) return pending;
  const retry = productionSettingsShellPort
    .refreshSession(client)
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
  state: SettingsSessionObservation['state'];
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
export function SignedOutSettings({
  returnTo,
  SignInPrompt,
}: {
  returnTo: string;
  SignInPrompt: SettingsContentPort['SignInPrompt'];
}) {
  return (
    <div className="space-y-8">
      <div id="display" className="scroll-mt-6">
        <DisplayPreferences />
      </div>
      <AccountSafetyCard state="signed-out" returnTo={returnTo} SignInPrompt={SignInPrompt} />
    </div>
  );
}

function OwnedSettingsPage({
  page,
  csrfToken,
  preferenceIO,
  managedAccountsIO,
  watchesIO,
  content,
  onRetry,
  ShelfCard = BoundShelfPreferencesCard,
  PrivacySection = BoundCollectionPrivacySection,
}: {
  page: Extract<SettingsPage, { signedIn: true }> & { accountId: string };
  csrfToken: string | null;
  preferenceIO: PreferenceIO;
  managedAccountsIO?: ManagedAccountsIO | undefined;
  watchesIO?: WatchManagementIO | undefined;
  content: SettingsContentPort;
  onRetry: () => void;
  ShelfCard?: typeof BoundShelfPreferencesCard;
  PrivacySection?: typeof BoundCollectionPrivacySection;
}) {
  const owner = useSettingsSessionOwner(csrfToken, page.accountId)!;
  const [returnEntry] = useState(() =>
    typeof globalThis.window === 'undefined'
      ? { receipt: null, profile: null, present: false }
      : readSettingsWatchReturn(window.history.state),
  );
  useLayoutEffect(() => {
    if (returnEntry.present && typeof globalThis.window !== 'undefined') {
      window.history.replaceState(withoutSettingsWatchReturn(window.history.state), '', window.location.href);
    }
  }, [returnEntry]);
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
          content={content}
          watchReturn={returnEntry.receipt}
          profileReturn={returnEntry.profile}
          ShelfCard={ShelfCard}
          PrivacySection={PrivacySection}
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
  content,
  ShelfCard = BoundShelfPreferencesCard,
  PrivacySection = BoundCollectionPrivacySection,
}: {
  page: SettingsPage;
  csrfToken: string | null;
  /** Supplied only by the guarded route, from its request's established session query. */
  requestSession?: SettingsSessionObservation | null;
  managedAccountsIO?: ManagedAccountsIO | undefined;
  watchesIO?: WatchManagementIO | undefined;
  preferenceIO?: PreferenceIO;
  content: SettingsContentPort;
  ShelfCard?: typeof BoundShelfPreferencesCard;
  PrivacySection?: typeof BoundCollectionPrivacySection;
}) {
  const location = useLocation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false,
  );
  const { PageHeading, subscribeSessionQuery, sessionQueryState } = useSettingsShell();
  const browserSession = useSettingsSession();
  // Observe the installed query, as Inbox does; useSession owns the initial request.
  const observeSession = useCallback(
    (changed: () => void) => subscribeSessionQuery(queryClient, changed),
    [queryClient, subscribeSessionQuery],
  );
  const sessionRead = useSyncExternalStore(observeSession, () => sessionQueryState(queryClient), serverSessionRead);
  const [generation, setGeneration] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  // Match the server snapshot on first hydration; later renders require the live browser identity.
  // A loader page or a seeded cache alone never establishes this route-bound session.
  const session = hydrated ? browserSession : (requestSession ?? browserSession);
  const requestedManagedTarget = managedAccountTarget(location.publicHref);
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
          content={content}
          onRetry={retry}
          ShelfCard={ShelfCard}
          PrivacySection={PrivacySection}
        />
      ) : signedOut ? (
        <SignedOutSettings returnTo={location.publicHref} SignInPrompt={content.SignInPrompt} />
      ) : (
        <div className="space-y-3">
          <SettingsSessionRecovery
            state={session.state}
            sessionRead={sessionRead}
            retrying={retrying}
            retryFailed={retryFailed}
            onRetry={retry}
          />
          {/* Any requested account selection keeps its Back link while this session cannot open the detail. */}
          {page.signedIn && requestedManagedTarget !== undefined ? (
            <section id="account" aria-labelledby="settings-account-heading" className="scroll-mt-6 space-y-6">
              <ManagedAccountSelectionUnavailable backHref={managedAccountsBackHref(location.publicHref)} />
            </section>
          ) : null}
        </div>
      )}
    </article>
  );
}
