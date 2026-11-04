import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rezics/ui/shadcn/card';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@rezics/ui/shadcn/field';
import { Switch } from '@rezics/ui/shadcn/switch';
import { m } from '../paraglide/messages.js';
import { WatchNotificationGuide } from './watch-notification-guide';
import { readSettingsPage, saveNotifications } from './actions';
import {
  NotificationEditor,
  notificationOriginalAllowed,
  notificationsNeedNavigationDecision,
  type NotificationEditorIO,
} from './notification-recovery';
import type { PreferencePage } from './preferences';
import { preferencePageAllows } from './preferences';
import { usePreferenceRetry } from './preference-failure-retry';
import { useSettingsNavigationDraft } from './reading-navigation';

import { useSettingsCurrent, useSettingsReadCurrent, useSettingsDisposal } from './settings-session-owner';

const preferenceActionClassName = 'h-auto min-h-11 min-w-11 max-w-full py-2 whitespace-normal wrap-anywhere';

export function notificationName(kind: string): string {
  if (kind === 'reply') return m.settings_notification_reply();
  if (kind === 'mention') return m.settings_notification_mention();
  if (kind === 'thread_watch') return m.settings_notification_thread_watch();
  if (kind === 'board_activity') return m.settings_notification_board_activity();
  if (kind === 'moderation_decision') return m.settings_notification_moderation_decision();
  return kind;
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
  initial: PreferencePage;
  version: number;
  csrfToken: string | null;
  action: string;
  initialFailed?: boolean;
  onVersionChange: (version: number) => void;
  io?: NotificationEditorIO;
}) {
  const ids = useId();
  const nativeInputs = useRef(new Map<string, HTMLInputElement>());
  const [hydrated, setHydrated] = useState(false);
  const sharedVersion = useRef(version);
  sharedVersion.current = Math.max(sharedVersion.current, version);
  const writeCurrent = useSettingsCurrent(csrfToken, !!io);
  const isCurrent = useSettingsReadCurrent(csrfToken, !!io);
  const [editor] = useState(
    () =>
      new NotificationEditor(
        initial,
        io ?? {
          save: (data) => saveNotifications({ data, headers: { 'X-CSRF-Token': csrfToken ?? '' } }),
          read: () => readSettingsPage(),
          confirmed: onVersionChange,
        },
        initialFailed,
        () => sharedVersion.current,
        isCurrent,
        () => !!csrfToken && writeCurrent(),
      ),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  useSettingsDisposal(editor.dispose);
  useSettingsNavigationDraft(
    'notifications',
    isCurrent() && notificationsNeedNavigationDecision(state),
    () => isCurrent() && notificationsNeedNavigationDecision(editor.snapshot()),
    editor,
  );
  const commandWaiting = usePreferenceRetry(state.commandFailure, state.commandRetryAt);
  const readWaiting = usePreferenceRetry(state.readFailure, state.readRetryAt);
  const waiting = commandWaiting || readWaiting;
  useLayoutEffect(() => {
    // A reader may have changed the native checkbox while the bundle was loading.
    // Capture those choices before replacing it with the controlled shared switch.
    for (const [kind, input] of nativeInputs.current) {
      if (input.checked !== editor.snapshot().draft[kind]) void editor.edit(kind, input.checked, version);
    }
    setHydrated(true);
  }, [editor]);
  const busy = state.phase === 'saving' || state.phase === 'reloading';
  const disabled = busy || !csrfToken || !writeCurrent();
  const uncertain = state.phase === 'uncertain' || (state.pending !== null && state.phase === 'reloading');
  const readFailed = state.readOrigin !== null && (state.phase === 'failed' || state.phase === 'uncertain');
  const needsReload = !readFailed && (state.phase === 'conflict' || state.phase === 'failed');
  const localEdit = !!state.pending || readFailed || ['conflict', 'review', 'reloading'].includes(state.phase);
  const canEdit = state.currentAdvice ? preferencePageAllows(state.currentAdvice, 'edit') : false;
  const canDraft = localEdit && preferencePageAllows(state.known.page, 'edit');
  const canRetryOriginal = notificationOriginalAllowed(state.pending?.input ?? null, state.currentAdvice);
  const rowDisabled = disabled || (commandWaiting && !localEdit) || (!canEdit && !canDraft);
  const restoreDisabled =
    commandWaiting ||
    disabled ||
    !!state.pending ||
    state.phase === 'conflict' ||
    readFailed ||
    !state.currentAdvice ||
    !preferencePageAllows(state.currentAdvice, 'reset');
  const catalogue = state.currentAdvice ?? state.known.page;
  const compulsory = catalogue.kinds.filter((entry) => !entry.optional);
  const waitDescription = waiting ? `${ids}-retry-wait` : undefined;

  return (
    <Card className="min-w-0 max-w-full">
      <CardHeader>
        <CardTitle>
          <h2 id="settings-notifications-heading">{m.settings_notifications_heading()}</h2>
        </CardTitle>
        <CardDescription>{m.settings_notifications_text()}</CardDescription>
        {state.currentAdvice && !canEdit ? (
          <CardDescription>{m.settings_notifications_read_only()}</CardDescription>
        ) : null}
        <CardDescription>
          {localEdit || state.intent !== undefined
            ? m.settings_notifications_draft_help()
            : m.settings_automatic_save_help()}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <div role="group" aria-label={m.settings_notifications_heading()} className="space-y-4">
          <WatchNotificationGuide />
          <FieldGroup>
            <div className="flex flex-col gap-3">
              {Object.entries(state.draft).map(([kind, checked]) => {
                const id = `${ids}-${encodeURIComponent(kind)}`;
                const formId = `${id}-form`;
                const name = notificationName(kind);
                const policy = catalogue.kinds.find((entry) => entry.kind === kind);
                return (
                  <form
                    key={kind}
                    id={formId}
                    method="post"
                    action={action}
                    className="m-0"
                    onSubmit={(event) => {
                      if (!hydrated) return;
                      event.preventDefault();
                      if (rowDisabled) return;
                      const fields = new FormData(event.currentTarget);
                      void editor.edit(kind, fields.has('enabled'), version);
                    }}
                  >
                    <input form={formId} type="hidden" name="csrf_token" value={csrfToken ?? ''} />
                    <input form={formId} type="hidden" name="expectedVersion" value={state.known.version} />
                    <input form={formId} type="hidden" name="notificationKind" value={kind} />
                    <FieldLabel htmlFor={id} className="min-h-11 cursor-pointer has-data-disabled:cursor-not-allowed">
                      <Field orientation="horizontal" className="min-h-11">
                        <FieldContent className="min-w-0">
                          <FieldTitle className="max-w-full wrap-anywhere">{name}</FieldTitle>
                          {policy ? (
                            <FieldDescription>
                              {policy.default
                                ? m.settings_notifications_default_on()
                                : m.settings_notifications_default_off()}
                            </FieldDescription>
                          ) : null}
                        </FieldContent>
                        {/* Only one control is mounted; the shared Switch owns its form input after hydration. */}
                        {hydrated ? (
                          <Switch
                            id={id}
                            form={formId}
                            name="enabled"
                            value="true"
                            checked={checked}
                            disabled={rowDisabled}
                            aria-describedby={waitDescription}
                            aria-label={name}
                            onCheckedChange={(next) => void editor.edit(kind, next, version)}
                          />
                        ) : (
                          <input
                            id={id}
                            form={formId}
                            ref={(input) => {
                              if (input) nativeInputs.current.set(kind, input);
                              else nativeInputs.current.delete(kind);
                            }}
                            type="checkbox"
                            role="switch"
                            name="enabled"
                            value="true"
                            defaultChecked={checked}
                            disabled={rowDisabled}
                            aria-describedby={waitDescription}
                            aria-label={name}
                            className="size-5 shrink-0 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                          />
                        )}
                      </Field>
                    </FieldLabel>
                    <Button
                      className={preferenceActionClassName}
                      type="submit"
                      form={formId}
                      size="sm"
                      variant="outline"
                      hidden={hydrated}
                      disabled={rowDisabled}
                    >
                      {m.settings_notification_save()}
                    </Button>
                    <input form={formId} type="hidden" name="action" value="save" />
                  </form>
                );
              })}
              <form
                id={`${ids}-restore-form`}
                hidden={state.phase === 'review' && state.intent === null}
                method="post"
                action={action}
                className="m-0"
                onSubmit={(event) => {
                  if (!hydrated) return;
                  event.preventDefault();
                  void editor.restore(version);
                }}
              >
                <input form={`${ids}-restore-form`} type="hidden" name="csrf_token" value={csrfToken ?? ''} />
                <input form={`${ids}-restore-form`} type="hidden" name="expectedVersion" value={state.known.version} />
                <input form={`${ids}-restore-form`} type="hidden" name="action" value="restore" />
                <Button
                  className={preferenceActionClassName}
                  type="submit"
                  form={`${ids}-restore-form`}
                  variant="outline"
                  disabled={restoreDisabled}
                  aria-describedby={waitDescription}
                >
                  {m.settings_notifications_restore()}
                </Button>
              </form>
            </div>
          </FieldGroup>
          <div role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">
            {state.phase === 'saving'
              ? m.settings_saving()
              : state.phase === 'reloading'
                ? m.settings_notifications_reading()
                : state.phase === 'saved'
                  ? m.settings_saved()
                  : null}
          </div>
          {state.readOrigin !== null ? (
            <p className="text-sm text-muted-foreground">{m.settings_notifications_retained()}</p>
          ) : null}
          {waiting ? (
            <p id={waitDescription} role="status" className="text-sm text-muted-foreground">
              {m.settings_retry_wait()}
            </p>
          ) : null}
          {readFailed ? (
            <Alert
              variant="destructive"
              data-response-status={state.readFailure?.status ?? ''}
              data-response-code={state.readFailure?.code ?? ''}
              data-retry-after={state.readFailure?.retryAfter}
            >
              <AlertTitle>{m.settings_notifications_read_failed()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {state.readReason === 'closed'
                    ? m.settings_notifications_read_closed()
                    : state.readReason === 'forbidden'
                      ? m.settings_notifications_read_denied()
                      : m.settings_notifications_read_unavailable()}
                </p>
                <Button
                  className={preferenceActionClassName}
                  type="button"
                  variant="outline"
                  disabled={readWaiting || busy || !hydrated}
                  aria-describedby={waitDescription}
                  onClick={() => void editor.reload()}
                >
                  {m.settings_reload()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {uncertain ? (
            <Alert
              data-response-status={state.commandFailure?.status ?? ''}
              data-response-code={state.commandFailure?.code ?? ''}
              data-retry-after={state.commandFailure?.retryAfter}
            >
              <AlertTitle>{m.settings_notifications_uncertain_title()}</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{m.settings_notifications_uncertain_text()}</p>
                {!readFailed && state.commandReason === 'closed' ? <p>{m.settings_closed_text()}</p> : null}
                {!readFailed && state.commandReason === 'preparing' ? <p>{m.settings_preparing_text()}</p> : null}
                {!readFailed && state.commandReason === 'unavailable' ? <p>{m.settings_unavailable_text()}</p> : null}
                <Button
                  className={preferenceActionClassName}
                  type="button"
                  variant="outline"
                  disabled={commandWaiting || disabled || !canRetryOriginal}
                  aria-describedby={waitDescription}
                  onClick={() => void editor.retry()}
                >
                  {m.settings_notifications_retry_original()}
                </Button>
                {!readFailed && !state.currentAdvice ? (
                  <Button
                    className={preferenceActionClassName}
                    type="button"
                    variant="outline"
                    disabled={readWaiting || busy || !hydrated}
                    aria-describedby={waitDescription}
                    onClick={() => void editor.reload()}
                  >
                    {m.settings_reload()}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : needsReload ? (
            <Alert
              variant={state.phase === 'failed' ? 'destructive' : 'default'}
              data-response-status={state.commandFailure?.status ?? ''}
              data-response-code={state.commandFailure?.code ?? ''}
              data-retry-after={state.commandFailure?.retryAfter}
            >
              <AlertTitle>
                {state.phase === 'conflict'
                  ? m.settings_conflict_title()
                  : state.commandFailure?.code === 'platform_closed'
                    ? m.settings_closed_title()
                    : state.commandReason === 'preparing'
                      ? m.settings_preparing_title()
                      : state.commandReason === 'unavailable'
                        ? m.settings_unavailable_title()
                        : m.settings_failed_title()}
              </AlertTitle>
              <AlertDescription className="space-y-3">
                <p>
                  {state.phase === 'conflict'
                    ? m.settings_conflict_text()
                    : state.commandFailure?.code === 'platform_closed'
                      ? m.settings_closed_text()
                      : state.commandReason === 'preparing'
                        ? m.settings_preparing_text()
                        : state.commandReason === 'unavailable'
                          ? m.settings_unavailable_text()
                          : m.settings_failed_text()}
                </p>
                <Button
                  className={preferenceActionClassName}
                  type="button"
                  variant="outline"
                  disabled={readWaiting || busy || !hydrated}
                  aria-describedby={waitDescription}
                  onClick={() => void editor.reload()}
                >
                  {m.settings_reload()}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {state.phase === 'review' && state.pending ? (
            <Alert data-response-status={state.commandFailure?.status ?? ''}>
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
                <p>{m.settings_notifications_uncertain_text()}</p>
                <ul aria-label={m.settings_notifications_retry_original()} className="space-y-1">
                  {state.pending.input.notifications === null ? (
                    <li>{m.settings_notifications_restore()}</li>
                  ) : (
                    Object.entries(state.pending.input.notifications).map(([kind, enabled]) => (
                      <li key={kind}>
                        {notificationName(kind)}:{' '}
                        {enabled ? m.settings_notifications_on() : m.settings_notifications_off()}
                      </li>
                    ))
                  )}
                </ul>
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Button
                    className={preferenceActionClassName}
                    type="button"
                    disabled={commandWaiting || disabled || !canRetryOriginal}
                    aria-describedby={waitDescription}
                    onClick={() => void editor.retry()}
                  >
                    {m.settings_notifications_retry_original()}
                  </Button>
                  {!canRetryOriginal ? (
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      variant="outline"
                      disabled={readWaiting || disabled || !hydrated}
                      aria-describedby={waitDescription}
                      onClick={() => void editor.reload()}
                    >
                      {m.settings_reload()}
                    </Button>
                  ) : null}
                </div>
              </AlertDescription>
            </Alert>
          ) : state.phase === 'review' ? (
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
                <div className="flex min-w-0 flex-wrap gap-2">
                  <Button
                    className={preferenceActionClassName}
                    type="button"
                    disabled={commandWaiting || disabled}
                    aria-describedby={waitDescription}
                    onClick={() => void editor.submit(version)}
                  >
                    {state.intent === null ? m.settings_notifications_restore() : m.settings_notifications_save_draft()}
                  </Button>
                  {!state.pending ? <Button
                    className={preferenceActionClassName}
                    type="button"
                    variant="outline"
                    onClick={() => editor.useCurrent()}
                  >
                    {m.settings_notifications_use_current()}
                  </Button> : null}
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {!state.pending && !needsReload && !readFailed ? (
            <Button
              className={preferenceActionClassName}
              type="button"
              variant="ghost"
              disabled={readWaiting || !hydrated || busy}
              aria-describedby={waitDescription}
              onClick={() => void editor.reload()}
            >
              {m.settings_reload()}
            </Button>
          ) : null}
          {compulsory.length > 0 ? (
            <aside
              className="space-y-2 text-sm text-muted-foreground"
              aria-label={m.settings_notifications_policy_heading()}
            >
              <h3 className="font-medium text-foreground">{m.settings_notifications_policy_heading()}</h3>
              <ul className="space-y-1">
                {compulsory.map((entry) => (
                  <li key={entry.kind}>{notificationName(entry.kind)}</li>
                ))}
              </ul>
              <p>{m.settings_notifications_mandatory()}</p>
            </aside>
          ) : (
            <p className="text-sm text-muted-foreground">{m.settings_notifications_mandatory()}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
