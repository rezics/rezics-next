import { useId, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldContent, FieldGroup, FieldLabel, FieldTitle } from '@rezics/ui/shadcn/field';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { readSettingsPage, saveNotifications } from './actions';
import { NotificationEditor, type NotificationEditorIO } from './notification-recovery';
import type { NotificationPreferences } from './preferences';

export function notificationName(kind: string): string {
  if (kind === 'reply') return m.settings_notification_reply();
  if (kind === 'mention') return m.settings_notification_mention();
  return kind
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toLocaleUpperCase() + word.slice(1))
    .join(' ');
}

export function NotificationsCard({
  initial,
  version,
  csrfToken,
  action,
  initialFailed = false,
  onVersionChange,
  io,
}: {
  initial: NotificationPreferences;
  version: number;
  csrfToken: string | null;
  action: string;
  initialFailed?: boolean;
  onVersionChange: (version: number) => void;
  io?: NotificationEditorIO;
}) {
  const ids = useId();
  const [hydrated, setHydrated] = useState(false);
  const [editor] = useState(
    () =>
      new NotificationEditor(
        { notifications: initial, version },
        io ?? {
          save: (data) => saveNotifications({ data, headers: csrfHeaders() }),
          read: () => readSettingsPage(),
          confirmed: onVersionChange,
        },
        initialFailed,
      ),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  useLayoutEffect(() => setHydrated(true), []);
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const disabled = busy || !csrfToken;
  const uncertain = state.phase === 'uncertain' || (state.pending !== null && state.phase === 'reloading');
  const needsReload = state.phase === 'conflict' || state.phase === 'failed';

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 id="settings-notifications-heading">{m.settings_notifications_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_notifications_text()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="group" aria-label={m.settings_notifications_heading()} className="space-y-4">
          <FieldGroup>
            <div className="flex flex-col gap-3">
              {Object.entries(state.draft).map(([kind, checked]) => {
                const id = `${ids}-${encodeURIComponent(kind)}`;
                const name = notificationName(kind);
                return (
                  <form
                    key={kind}
                    method="post"
                    action={action}
                    className="m-0"
                    onSubmit={(event) => {
                      if (!hydrated) return;
                      event.preventDefault();
                    }}
                  >
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
                            disabled={disabled}
                            aria-label={name}
                            onChange={(event) => void editor.edit(kind, event.currentTarget.checked, version)}
                            className="peer absolute inset-0 h-5 w-8 cursor-pointer appearance-none rounded-2xl border-2 border-transparent bg-input/90 transition-colors checked:border-primary checked:bg-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute left-0.5 top-0.5 size-4 rounded-full bg-background shadow-sm transition-transform peer-checked:translate-x-3 dark:peer-checked:bg-primary-foreground"
                          />
                        </span>
                      </Field>
                    </FieldLabel>
                    <Button type="submit" size="sm" variant="outline" hidden={hydrated} disabled={!csrfToken}>
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
                  void editor.restore(version);
                }}
              >
                <input type="hidden" name="csrf_token" value={csrfToken ?? ''} />
                <input type="hidden" name="expectedVersion" value={version} />
                <input type="hidden" name="action" value="restore" />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={disabled || !!state.pending || state.phase === 'conflict'}
                >
                  {m.settings_notifications_restore()}
                </Button>
              </form>
            </div>
          </FieldGroup>
          <div aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
            {busy ? m.settings_saving() : state.phase === 'saved' ? m.settings_saved() : null}
          </div>
          {uncertain ? (
            <Alert data-response-status={state.failure?.status ?? ''} data-response-code={state.failure?.code ?? ''}>
              <AlertTitle>{m.settings_notifications_uncertain_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{m.settings_notifications_uncertain_text()}</p>
                <Button type="button" variant="outline" disabled={disabled} onClick={() => void editor.retry()}>
                  {m.settings_notifications_retry_original()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : needsReload ? (
            <Alert
              variant={state.phase === 'failed' ? 'destructive' : 'default'}
              data-response-status={state.failure?.status ?? ''}
              data-response-code={state.failure?.code ?? ''}
            >
              <AlertTitle>
                {state.phase === 'conflict'
                  ? m.settings_conflict_title()
                  : state.failure?.code === 'platform_closed'
                    ? m.settings_closed_title()
                    : state.failure?.status === 503
                      ? m.settings_preparing_title()
                      : m.settings_failed_title()}
              </AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {state.phase === 'conflict'
                    ? m.settings_conflict_text()
                    : state.failure?.code === 'platform_closed'
                      ? m.settings_closed_text()
                      : state.failure?.status === 503
                        ? m.settings_preparing_text()
                        : m.settings_failed_text()}
                </p>
                <Button type="button" variant="outline" disabled={busy} onClick={() => void editor.reload()}>
                  {m.settings_reload()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {state.phase === 'review' ? (
            <Alert>
              <AlertTitle>{m.settings_notifications_review_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{m.settings_notifications_review_text()}</p>
                <ul className="space-y-1">
                  {Object.entries(state.known.notifications).map(([kind, enabled]) => (
                    <li key={kind}>
                      {notificationName(kind)}:{' '}
                      {enabled ? m.settings_notifications_on() : m.settings_notifications_off()}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" disabled={disabled} onClick={() => void editor.submit(version)}>
                    {m.settings_notifications_save_draft()}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => editor.useCurrent()}>
                    {m.settings_notifications_use_current()}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {!state.pending && !needsReload ? (
            <Button type="button" variant="ghost" disabled={!hydrated || busy} onClick={() => void editor.reload()}>
              {m.settings_reload()}
            </Button>
          ) : null}
          <p className="text-sm text-muted-foreground">{m.settings_notifications_mandatory()}</p>
        </div>
      </CardContent>
    </Card>
  );
}
