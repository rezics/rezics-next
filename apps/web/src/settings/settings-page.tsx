import { exposureQuery, useSession } from '../session/query';
import { useQuery } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { ProfileSection } from './profile';
import { ReadingCard } from './reading-card';
import { DisplayPreferences } from './display-preferences';
import { NotificationsCard } from './notifications';
import { PublicViewsSection } from './public-views';
import type { NativePreferenceFailure, SettingsPage } from './preferences';
import { usePreferenceRetry } from './preference-failure-retry';
import { CollectionPrivacySection } from './collection-privacy';
import { VerificationSection } from './verification';
import { useOperation } from '../kernel/exposure';
import { AccountSafetyCard } from './account-safety';
import { ManagedAccountsSection } from './managed-accounts';
import type { ManagedAccountsIO } from './managed-accounts-read';
import { SectionsNavigation, settingsSections } from './sections-navigation';

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
            <Button type="button" variant="outline" disabled={waiting} onClick={onRetry}>
              {m.settings_retry()}
            </Button>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function SettingsSections({
  page,
  csrfToken,
  managedAccountsIO,
}: {
  page: Extract<SettingsPage, { signedIn: true }>;
  csrfToken: string | null;
  managedAccountsIO?: ManagedAccountsIO | undefined;
}) {
  const collectionsAdmitted = useOperation('account.collections');
  const verificationAdmitted = useOperation('agent_verification.request');
  const { state: sessionState } = useSession();
  // Observe the same admission and verification reads as the sections, without adding requests.
  const exposure = useQuery({ ...exposureQuery, enabled: false });
  const verification = useQuery({ queryKey: ['settings', 'verification'], enabled: false });
  const showVerification = verificationAdmitted && verification.error?.message !== 'rezics-platform-closed';
  const location = useLocation();
  const router = useRouter();
  const [version, setVersion] = useState('preferences' in page ? page.preferences.version : 0);
  const formCsrfToken = page.csrfToken ?? csrfToken;
  const notificationError = new URL(location.publicHref, 'https://rezics.local').searchParams.has('notificationError');
  useEffect(() => {
    if ('preferences' in page) setVersion((current) => Math.max(current, page.preferences.version));
  }, [page]);
  return (
    <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,48rem)] lg:justify-center">
      <SectionsNavigation
        sections={settingsSections({
          display: true,
          notifications: 'preferences' in page,
          collections: collectionsAdmitted,
          verification: showVerification,
          readingState: 'preferences' in page ? undefined : page.state,
        })}
        pending={sessionState === 'unknown' || (sessionState === 'signed-in' && exposure.isPending)}
      />
      <div className="min-w-0 space-y-8">
        <section id="reading" aria-labelledby="settings-reading-heading" className="scroll-mt-6">
          {'preferences' in page ? (
            <ReadingCard
              initial={page.preferences}
              version={version}
              csrfToken={formCsrfToken}
              onVersionChange={(next) => setVersion((current) => Math.max(current, next))}
            />
          ) : (
            <SettingsFailure state={page.state} failure={page.failure} onRetry={() => void router.invalidate()} />
          )}
        </section>
        <section id="display" aria-labelledby="settings-display-heading" className="scroll-mt-6">
          <DisplayPreferences />
        </section>
        {'preferences' in page ? (
          <section id="notifications" aria-labelledby="settings-notifications-heading" className="scroll-mt-6">
            {page.notifications ? (
              <NotificationsCard
                initial={page.notifications}
                version={version}
                csrfToken={formCsrfToken}
                action={location.publicHref.split(/[?#]/, 1)[0]!}
                initialFailed={notificationError}
                onVersionChange={(next) => setVersion((current) => Math.max(current, next))}
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
                    <AlertDescription>
                      <p>{m.settings_unavailable_text()}</p>
                      <Button type="button" variant="outline" onClick={() => void router.invalidate()}>
                        {m.settings_retry()}
                      </Button>
                    </AlertDescription>
                  </Alert>
                </CardContent>
              </Card>
            )}
          </section>
        ) : null}
        <CollectionPrivacySection />
        {showVerification ? (
          <section
            id="verification"
            aria-label={m.settings_verification_heading()}
            className="scroll-mt-6"
            tabIndex={-1}
          >
            <VerificationSection />
          </section>
        ) : null}
        <section id="profile" aria-label={m.settings_profile_heading()} className="scroll-mt-6">
          <ProfileSection />
        </section>
        <section id="public-activity" aria-label={m.settings_public_activity_heading()} className="scroll-mt-6">
          <PublicViewsSection />
        </section>
        <section id="account" aria-labelledby="settings-account-heading" className="scroll-mt-6 space-y-6">
          <AccountSafetyCard
            state="signed-in"
            securityHref={page.securityHref}
            renameAccount={page.renameAccount ?? null}
            csrfToken={formCsrfToken}
            onReload={() => window.location.reload()}
          />
          <ManagedAccountsSection io={managedAccountsIO} />
        </section>
      </div>
    </div>
  );
}

export function SettingsPageView({
  page,
  csrfToken,
  managedAccountsIO,
}: {
  page: SettingsPage;
  csrfToken: string | null;
  managedAccountsIO?: ManagedAccountsIO | undefined;
}) {
  const location = useLocation();
  return (
    <article className="mx-auto w-full max-w-6xl space-y-8 px-4 text-foreground sm:px-6">
      <header>
        <PageHeading>{m.settings_heading()}</PageHeading>
      </header>
      {page.signedIn ? (
        <SettingsSections page={page} csrfToken={csrfToken} managedAccountsIO={managedAccountsIO} />
      ) : (
        <AccountSafetyCard state="signed-out" returnTo={location.publicHref} />
      )}
    </article>
  );
}
