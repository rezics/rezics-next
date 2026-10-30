import { useSession } from '../session/query';
import { useId, useLayoutEffect, useState } from 'react';
import { useLocation } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@rezics/ui/shadcn/field';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import { Switch } from '@rezics/ui/shadcn/switch';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { readSettingsPage, saveNotifications, savePreferences } from './actions';
import { ProfileSection } from './profile';
import { PublicViewsSection } from './public-views';
import type { NotificationPreferences, ReadingPreferences, SettingsPage, SpoilerLevel } from './preferences';
import { CollectionPrivacySection } from './collection-privacy';
import { useOperation } from '../kernel/exposure';

type Signal = 'idle' | 'saving' | 'saved' | 'conflict' | 'reloading' | 'failed';

const levels: { value: SpoilerLevel; title: () => string; text: () => string }[] = [
  { value: 0, title: () => m.settings_spoiler_0_title(), text: () => m.settings_spoiler_0_text() },
  { value: 1, title: () => m.settings_spoiler_1_title(), text: () => m.settings_spoiler_1_text() },
  { value: 2, title: () => m.settings_spoiler_2_title(), text: () => m.settings_spoiler_2_text() },
];

function ReadingCard({
  initial,
  version,
  onVersionChange,
}: {
  initial: ReadingPreferences;
  version: number;
  onVersionChange: (version: number) => void;
}) {
  const { csrfToken } = useSession();
  const ids = useId();
  const [hydrated, setHydrated] = useState(false);
  // What the server last confirmed, and what the controls show. They differ after a stale write.
  const [known, setKnown] = useState(initial);
  const [choice, setChoice] = useState(initial);
  const [signal, setSignal] = useState<Signal>('idle');
  // Set in the same commit that marks the document hydrated, so the controls enable with it.
  useLayoutEffect(() => setHydrated(true), []);
  const busy = signal === 'saving' || signal === 'reloading';

  async function change(next: Partial<Pick<ReadingPreferences, 'spoilerLevel' | 'suitability'>>) {
    if (!hydrated || !csrfToken || busy) return;
    setChoice((current) => ({ ...current, ...next }));
    setSignal('saving');
    try {
      const result = await savePreferences({
        data: { expectedVersion: version, idempotencyKey: crypto.randomUUID(), ...next },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        setKnown(result.preferences);
        setChoice(result.preferences);
        onVersionChange(result.preferences.version);
        setSignal('saved');
      } else {
        setSignal(result.reason === 'conflict' ? 'conflict' : 'failed');
      }
    } catch {
      setSignal('failed');
    }
  }

  async function reload() {
    if (busy) return;
    setSignal('reloading');
    try {
      const page = await readSettingsPage();
      if (!('preferences' in page)) throw new Error('Preferences unavailable');
      setKnown(page.preferences);
      setChoice(page.preferences);
      onVersionChange(page.preferences.version);
      setSignal('idle');
    } catch {
      setSignal('failed');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-reading-heading">{m.settings_reading_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_reading_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <FieldGroup>
          <div role="group" aria-labelledby={`${ids}-spoilers`} className="flex flex-col gap-3">
            <div className="space-y-1">
              <div id={`${ids}-spoilers`} className="font-medium">
                {m.settings_spoiler_legend()}
              </div>
              <FieldDescription>{m.settings_spoiler_text()}</FieldDescription>
            </div>
            <RadioGroup
              value={String(choice.spoilerLevel)}
              disabled={!hydrated || !csrfToken || busy}
              onValueChange={(value) => void change({ spoilerLevel: Number(value) as SpoilerLevel })}
              aria-labelledby={`${ids}-spoilers`}
            >
              {levels.map((level) => (
                <FieldLabel key={level.value} htmlFor={`${ids}-level-${level.value}`}>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle id={`${ids}-level-${level.value}-title`}>{level.title()}</FieldTitle>
                      <FieldDescription id={`${ids}-level-${level.value}-text`}>{level.text()}</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem
                      id={`${ids}-level-${level.value}`}
                      value={String(level.value)}
                      aria-labelledby={`${ids}-level-${level.value}-title`}
                      aria-describedby={`${ids}-level-${level.value}-text`}
                    />
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </div>
          <FieldLabel htmlFor={`${ids}-suitability`}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle id={`${ids}-suitability-title`}>{m.settings_suitability_title()}</FieldTitle>
                <FieldDescription id={`${ids}-suitability-text`}>{m.settings_suitability_text()}</FieldDescription>
              </FieldContent>
              <Switch
                id={`${ids}-suitability`}
                checked={choice.suitability === 'show'}
                disabled={!hydrated || !csrfToken || busy}
                onCheckedChange={(checked) => void change({ suitability: checked ? 'show' : 'blur' })}
                aria-labelledby={`${ids}-suitability-title`}
                aria-describedby={`${ids}-suitability-text`}
              />
            </Field>
          </FieldLabel>
        </FieldGroup>
        <div aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
          {signal === 'saving' ? m.settings_saving() : null}
          {signal === 'saved' ? m.settings_saved() : null}
        </div>
        {signal === 'conflict' || signal === 'reloading' ? (
          <Alert>
            <AlertTitle>{m.settings_conflict_title()}</AlertTitle>
            <AlertDescription>
              <p>{m.settings_conflict_text()}</p>
              <Button type="button" variant="outline" className="mt-3" disabled={busy} onClick={() => void reload()}>
                {m.settings_reload()}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {signal === 'failed' ? (
          <Alert variant="destructive">
            <AlertTitle>{m.settings_failed_title()}</AlertTitle>
            <AlertDescription>{m.settings_failed_text()}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function humanizeNotificationKind(kind: string): string {
  return kind
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toLocaleUpperCase() + word.slice(1))
    .join(' ');
}

function notificationName(kind: string): string {
  if (kind === 'reply') return m.settings_notification_reply();
  if (kind === 'mention') return m.settings_notification_mention();
  return humanizeNotificationKind(kind);
}

function NotificationsCard({
  initial,
  version,
  csrfToken,
  action,
  initialFailed,
  onVersionChange,
}: {
  initial: NotificationPreferences;
  version: number;
  csrfToken: string | null;
  action: string;
  initialFailed: boolean;
  onVersionChange: (version: number) => void;
}) {
  const ids = useId();
  const [hydrated, setHydrated] = useState(false);
  const [choice, setChoice] = useState(initial);
  const [signal, setSignal] = useState<Signal>(initialFailed ? 'failed' : 'idle');
  useLayoutEffect(() => setHydrated(true), []);
  const busy = signal === 'saving' || signal === 'reloading';

  async function change(notifications: NotificationPreferences | null) {
    if (!hydrated || busy) return;
    setSignal('saving');
    try {
      const result = await saveNotifications({
        data: { expectedVersion: version, idempotencyKey: crypto.randomUUID(), notifications },
        headers: csrfHeaders(),
      });
      if (result.ok) {
        setChoice(result.notifications);
        onVersionChange(result.version);
        setSignal('saved');
      } else {
        setSignal(result.reason === 'conflict' ? 'conflict' : 'failed');
      }
    } catch {
      setSignal('failed');
    }
  }

  async function reload() {
    if (busy) return;
    setSignal('reloading');
    try {
      const page = await readSettingsPage();
      if (!page.signedIn) throw new Error('signed out');
      setChoice(page.notifications ?? {});
      onVersionChange(page.preferences.version);
      setSignal('idle');
    } catch {
      setSignal('failed');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-notifications-heading">{m.settings_notifications_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_notifications_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div role="group" aria-label={m.settings_notifications_heading()} className="space-y-3">
          <FieldGroup>
            <div className="flex flex-col gap-3">
              {Object.entries(choice).map(([kind, checked]) => {
                const id = `${ids}-${encodeURIComponent(kind)}`;
                const name = notificationName(kind);
                return (
                  <form key={kind} method="post" action={action} className="m-0">
                    <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
                    <input type="hidden" name="expectedVersion" value={version} />
                    <input type="hidden" name="notificationKind" value={kind} />
                    <FieldLabel htmlFor={id}>
                      <Field orientation="horizontal">
                        <FieldContent>
                          <FieldTitle>{name}</FieldTitle>
                        </FieldContent>
                        <span className="relative h-5 w-8 shrink-0">
                          <input
                            id={id}
                            type="checkbox"
                            role="switch"
                            name="enabled"
                            value="true"
                            checked={checked}
                            disabled={busy}
                            onChange={(event) => void change({ [kind]: event.currentTarget.checked })}
                            aria-label={name}
                            className="peer absolute inset-0 h-5 w-8 cursor-pointer appearance-none rounded-2xl border-2 border-transparent bg-input/90 transition-colors checked:border-primary checked:bg-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-3 dark:peer-checked:bg-primary-foreground"
                          />
                        </span>
                      </Field>
                    </FieldLabel>
                    <Button type="submit" size="sm" variant="outline" hidden={hydrated}>
                      {m.settings_notification_save()}
                    </Button>
                    <input type="hidden" name="action" value="save" />
                  </form>
                );
              })}
              <form
                method="post"
                action={action}
                className="m-0"
                onSubmit={(event) => {
                  if (!hydrated) return;
                  event.preventDefault();
                  void change(null);
                }}
              >
                <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
                <input type="hidden" name="expectedVersion" value={version} />
                <input type="hidden" name="action" value="restore" />
                <Button type="submit" variant="outline" disabled={busy}>
                  {m.settings_notifications_restore()}
                </Button>
              </form>
            </div>
          </FieldGroup>
          <div aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
            {signal === 'saving' ? m.settings_saving() : null}
            {signal === 'saved' ? m.settings_saved() : null}
          </div>
          {signal === 'conflict' || signal === 'reloading' ? (
            <Alert>
              <AlertTitle>{m.settings_conflict_title()}</AlertTitle>
              <AlertDescription>
                <p>{m.settings_conflict_text()}</p>
                <Button type="button" variant="outline" className="mt-3" disabled={busy} onClick={() => void reload()}>
                  {m.settings_reload()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {signal === 'failed' ? (
            <Alert variant="destructive">
              <AlertTitle>{m.settings_failed_title()}</AlertTitle>
              <AlertDescription>{m.settings_failed_text()}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm text-muted-foreground">{m.settings_notifications_mandatory()}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function AccountCard({ securityHref, csrfToken }: { securityHref: string | null; csrfToken: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-account-heading">{m.settings_account_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_account_text()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-3">
        {securityHref ? (
          <a href={securityHref} className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}>
            {m.account_security_settings()}
          </a>
        ) : null}
        <form method="post" action="/auth/sign-out" className="m-0">
          <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
          <Button type="submit" variant="outline" size="lg" disabled={!csrfToken}>
            {m.account_sign_out()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function SettingsPageView({
  page,
  csrfToken,
}: {
  page: Extract<SettingsPage, { signedIn: true }>;
  csrfToken: string | null;
}) {
  const collectionsAdmitted = useOperation('account.collections');
  const location = useLocation();
  const [version, setVersion] = useState(page.preferences.version);
  const formCsrfToken = page.csrfToken ?? csrfToken;
  const notificationError = new URL(location.publicHref, 'https://rezics.local').searchParams.has('notificationError');
  return (
    <article className="mx-auto w-full max-w-6xl space-y-8 px-4 text-foreground sm:px-6">
      <header>
        <PageHeading>{m.settings_heading()}</PageHeading>
      </header>
      <div className="grid gap-8 lg:grid-cols-[12rem_minmax(0,48rem)] lg:justify-center">
        <nav aria-label={m.settings_sections_label()} className="hidden lg:block">
          <ul className="sticky top-6 space-y-2 border-l border-border pl-4 text-sm">
            <li>
              <a className="text-muted-foreground hover:text-foreground" href="#reading">
                {m.settings_reading_heading()}
              </a>
            </li>
            <li>
              <a className="text-muted-foreground hover:text-foreground" href="#notifications">
                {m.settings_notifications_heading()}
              </a>
            </li>
            {collectionsAdmitted ? (
              <li>
                <a className="text-muted-foreground hover:text-foreground" href="#privacy">
                  {m.settings_privacy_heading()}
                </a>
              </li>
            ) : null}
            <li>
              <a className="text-muted-foreground hover:text-foreground" href="#profile">
                {m.settings_profile_heading()}
              </a>
            </li>
            <li>
              <a className="text-muted-foreground hover:text-foreground" href="#public-activity">
                {m.settings_public_activity_heading()}
              </a>
            </li>
            <li>
              <a className="text-muted-foreground hover:text-foreground" href="#account">
                {m.settings_account_heading()}
              </a>
            </li>
          </ul>
        </nav>
        <div className="min-w-0 space-y-8">
          <section id="reading" aria-labelledby="settings-reading-heading" className="scroll-mt-6">
            <ReadingCard
              key={page.preferences.version}
              initial={page.preferences}
              version={version}
              onVersionChange={setVersion}
            />
          </section>
          <section id="notifications" aria-labelledby="settings-notifications-heading" className="scroll-mt-6">
            <NotificationsCard
              key={`${page.preferences.version}-notifications`}
              initial={page.notifications ?? {}}
              version={version}
              csrfToken={formCsrfToken}
              action={location.publicHref.split(/[?#]/, 1)[0]!}
              initialFailed={notificationError}
              onVersionChange={setVersion}
            />
          </section>
          <CollectionPrivacySection />
          <section id="profile" aria-label={m.settings_profile_heading()} className="scroll-mt-6">
            <ProfileSection />
          </section>
          <section id="public-activity" aria-label={m.settings_public_activity_heading()} className="scroll-mt-6">
            <PublicViewsSection />
          </section>
          <section id="account" aria-labelledby="settings-account-heading" className="scroll-mt-6">
            <AccountCard securityHref={page.securityHref} csrfToken={formCsrfToken} />
          </section>
        </div>
      </div>
    </article>
  );
}
