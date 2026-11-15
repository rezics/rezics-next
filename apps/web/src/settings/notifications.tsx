import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import {
  ContentSection,
  ContentSectionBody,
  ContentSectionDescription,
  ContentSectionHeader,
  ContentSectionTitle,
} from '@rezics/ui/content-section';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@rezics/ui/shadcn/field';
import { Switch } from '@rezics/ui/shadcn/switch';
import { m } from '../paraglide/messages.js';
import { WatchNotificationGuide } from './watch-notification-guide';
import { readSettingsPage, saveNotifications } from './actions';
import {
  NotificationEditor,
  notificationIntentAllowed,
  notificationOriginalAllowed,
  notificationsNeedNavigationDecision,
  unavailableNotificationIntent,
  type NotificationEditorState,
  type NotificationEditorIO,
} from './notification-recovery';
import { preferencePageAllows, usePreferenceRetry, type PreferencePage } from './preferences';
import { useSettingsNavigationDraft } from './reading-navigation';

import { useSettingsAmbient } from './adapters/ambient-view.tsx';
import { useSettingsCurrent, useSettingsReadCurrent, useSettingsDisposal } from './settings-session-owner';

const preferenceActionClassName = 'h-auto max-w-full whitespace-normal wrap-anywhere min-h-7';

type NotificationFocusAction = 'restore' | 'apply' | 'keep-current' | 'retry' | 'reload';
type NotificationFocusRequest = {
  action: NotificationFocusAction;
  source: HTMLElement;
  focusedAtActivation: boolean;
  complete: boolean;
};

function canReceiveFocus(element: Element | null): element is HTMLElement {
  if (
    !(element instanceof HTMLElement) ||
    !element.isConnected ||
    element.hidden ||
    element.matches(':disabled, [aria-disabled="true"]') ||
    element.closest('[hidden], [inert]')
  )
    return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function focusDestination(
  root: HTMLElement,
  action: NotificationFocusAction,
  state: NotificationEditorState,
): HTMLElement | null {
  const find = (selector: string) =>
    [...root.querySelectorAll(selector)].find((element) => canReceiveFocus(element)) ?? null;
  const switchControl = find('[role="switch"]');
  const restore = find('[data-notification-focus="restore"]');
  const apply = find('[data-notification-focus="apply"]');
  const keepCurrent = find('[data-notification-focus="keep-current"]');
  const retry = find('[data-notification-focus="retry"]');
  const reload = find('[data-notification-focus="reload"]');
  const statusCandidate = find('[data-notification-focus="status"]');
  const status = statusCandidate?.textContent?.trim() ? statusCandidate : null;
  const review = state.phase === 'review';
  const pending = state.pending !== null;
  const readFailed = state.readOrigin !== null && (state.phase === 'failed' || state.phase === 'uncertain');
  const needsCurrentRead = readFailed || state.phase === 'conflict' || state.phase === 'failed';

  if (action === 'keep-current') {
    return needsCurrentRead ? reload ?? switchControl ?? status : switchControl ?? reload ?? restore ?? status;
  }
  if (action === 'restore') {
    if (pending) return retry ?? reload ?? status ?? switchControl;
    if (needsCurrentRead) return reload ?? status ?? switchControl;
    if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
    return status ?? reload ?? switchControl ?? restore ?? keepCurrent;
  }
  if (action === 'apply') {
    if (pending) return retry ?? reload ?? status ?? switchControl;
    if (needsCurrentRead) return reload ?? status ?? switchControl;
    if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
    return status ?? switchControl ?? reload ?? restore;
  }
  if (action === 'retry') {
    if (pending) return retry ?? reload ?? status ?? switchControl;
    if (needsCurrentRead) return reload ?? status ?? switchControl;
    if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
    return status ?? switchControl ?? reload ?? restore;
  }
  if (pending) return retry ?? reload ?? status ?? switchControl;
  if (needsCurrentRead) return reload ?? status ?? switchControl;
  if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
  return switchControl ?? status ?? reload ?? restore;
}

type NotificationFocusActivation = FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement>;

type NotificationFocusAction = 'restore' | 'apply' | 'keep-current' | 'retry' | 'reload';
type NotificationFocusRequest = {
  action: NotificationFocusAction;
  source: HTMLElement;
  focusedAtActivation: boolean;
  complete: boolean;
};

function canReceiveFocus(element: Element | null): element is HTMLElement {
  if (
    !(element instanceof HTMLElement) ||
    !element.isConnected ||
    element.hidden ||
    element.matches(':disabled, [aria-disabled="true"]') ||
    element.closest('[hidden], [inert]')
  )
    return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function focusDestination(
  root: HTMLElement,
  action: NotificationFocusAction,
  state: NotificationEditorState,
): HTMLElement | null {
  const find = (selector: string) =>
    [...root.querySelectorAll(selector)].find((element) => canReceiveFocus(element)) ?? null;
  const switchControl = find('[role="switch"]');
  const restore = find('[data-notification-focus="restore"]');
  const apply = find('[data-notification-focus="apply"]');
  const keepCurrent = find('[data-notification-focus="keep-current"]');
  const retry = find('[data-notification-focus="retry"]');
  const reload = find('[data-notification-focus="reload"]');
  const statusCandidate = find('[data-notification-focus="status"]');
  const status = statusCandidate?.textContent?.trim() ? statusCandidate : null;
  const review = state.phase === 'review';
  const pending = state.pending !== null;
  const readFailed = state.readOrigin !== null && (state.phase === 'failed' || state.phase === 'uncertain');
  const needsCurrentRead = readFailed || state.phase === 'conflict' || state.phase === 'failed';

  if (action === 'keep-current') {
    return needsCurrentRead ? reload ?? switchControl ?? status : switchControl ?? reload ?? restore ?? status;
  }
  if (action === 'restore') {
    if (pending) return retry ?? reload ?? status ?? switchControl;
    if (needsCurrentRead) return reload ?? status ?? switchControl;
    if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
    return status ?? reload ?? switchControl ?? restore ?? keepCurrent;
  }
  if (action === 'apply') {
    if (pending) return retry ?? reload ?? status ?? switchControl;
    if (needsCurrentRead) return reload ?? status ?? switchControl;
    if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
    return status ?? switchControl ?? reload ?? restore;
  }
  if (action === 'retry') {
    if (pending) return retry ?? reload ?? status ?? switchControl;
    if (needsCurrentRead) return reload ?? status ?? switchControl;
    if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
    return status ?? switchControl ?? reload ?? restore;
  }
  if (pending) return retry ?? reload ?? status ?? switchControl;
  if (needsCurrentRead) return reload ?? status ?? switchControl;
  if (review) return apply ?? keepCurrent ?? reload ?? switchControl ?? status;
  return switchControl ?? status ?? reload ?? restore;
}

type NotificationFocusActivation = FormEvent<HTMLFormElement> | MouseEvent<HTMLButtonElement>;

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
  const focusRoot = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<NotificationFocusRequest | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  const sharedVersion = useRef(version);
  sharedVersion.current = Math.max(sharedVersion.current, version);
  const ambient = useSettingsAmbient();
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
        ambient,
        initialFailed,
        () => sharedVersion.current,
        isCurrent,
        () => !!csrfToken && writeCurrent(),
      ),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot, editor.snapshot);
  useSettingsDisposal(editor.dispose);
  useLayoutEffect(() => {
    if (!isCurrent()) editor.dispose();
  });
  useSettingsNavigationDraft(
    'notifications',
    isCurrent() && notificationsNeedNavigationDecision(state),
    () => isCurrent() && notificationsNeedNavigationDecision(editor.snapshot()),
    editor,
  );
  const runFocusAction = (
    action: NotificationFocusAction,
    event: NotificationFocusActivation,
    dispatch: () => void | Promise<void>,
  ) => {
    const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const submitter = (event.nativeEvent as Event & { submitter?: unknown }).submitter;
    const source =
      submitter instanceof HTMLElement
        ? submitter
        : current && event.currentTarget.contains(current)
          ? current
          : event.currentTarget;
    const request: NotificationFocusRequest = {
      action,
      source,
      focusedAtActivation: current === source,
      complete: false,
    };
    const before = editor.snapshot();
    focusRequest.current = request;
    let operation: void | Promise<void>;
    try {
      operation = dispatch();
    } catch (error) {
      if (focusRequest.current === request) focusRequest.current = null;
      throw error;
    }
    if (editor.snapshot() === before) {
      if (focusRequest.current === request) focusRequest.current = null;
      return;
    }
    const complete = () => {
      if (focusRequest.current !== request) return;
      request.complete = true;
      setFocusRevision((revision) => revision + 1);
    };
    if (operation && typeof operation.then === 'function') void operation.then(complete, complete);
    else complete();
  };
  useLayoutEffect(() => {
    const cancelAfterManualChoice = (event: Event) => {
      if (!focusRequest.current) return;
      if (event.type === 'focusin' && event.target === document.body) return;
      focusRequest.current = null;
    };
    document.addEventListener('focusin', cancelAfterManualChoice, true);
    document.addEventListener('pointerdown', cancelAfterManualChoice, true);
    document.addEventListener('keydown', cancelAfterManualChoice, true);
    return () => {
      document.removeEventListener('focusin', cancelAfterManualChoice, true);
      document.removeEventListener('pointerdown', cancelAfterManualChoice, true);
      document.removeEventListener('keydown', cancelAfterManualChoice, true);
      focusRequest.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request?.complete) return;
    focusRequest.current = null;
    if (!request.focusedAtActivation || !isCurrent()) return;
    const root = focusRoot.current;
    if (!root) return;
    if (document.activeElement === request.source && canReceiveFocus(request.source)) return;
    const destination = focusDestination(root, request.action, state);
    if (destination && destination !== document.activeElement) destination.focus({ preventScroll: true });
  }, [focusRevision, isCurrent, state]);
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
  const canDraft = localEdit && !state.currentAdvice && preferencePageAllows(state.known.page, 'edit');
  const canRetryOriginal = notificationOriginalAllowed(state.pending?.input ?? null, state.currentAdvice);
  const canSubmitReview =
    state.currentAdvice !== null &&
    state.intent !== undefined &&
    notificationIntentAllowed(state.intent, state.currentAdvice);
  const reviewActionAllowed =
    state.currentAdvice !== null &&
    state.intent !== undefined &&
    preferencePageAllows(state.currentAdvice, state.intent === null ? 'reset' : 'edit');
  const unavailable = state.currentAdvice ? unavailableNotificationIntent(state.intent, state.currentAdvice) : {};
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
    <ContentSection className="min-w-0 max-w-full">
      <ContentSectionHeader>
        <ContentSectionTitle>
          <h2 id="settings-notifications-heading">{m.settings_notifications_heading()}</h2>
        </ContentSectionTitle>
        <ContentSectionDescription>{m.settings_notifications_text()}</ContentSectionDescription>
        {state.currentAdvice && !canEdit ? (
          <ContentSectionDescription>{m.settings_notifications_read_only()}</ContentSectionDescription>
        ) : null}
        <ContentSectionDescription>
          {localEdit || state.intent !== undefined
            ? m.settings_notifications_draft_help()
            : m.settings_automatic_save_help()}
        </ContentSectionDescription>
      </ContentSectionHeader>
      <ContentSectionBody className="min-w-0 space-y-4">
        <div
          ref={focusRoot}
          role="group"
          aria-label={m.settings_notifications_heading()}
          className="space-y-4"
        >
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
                    <FieldLabel htmlFor={id} className="cursor-pointer has-data-disabled:cursor-not-allowed">
                      <Field orientation="horizontal">
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
                      className="h-auto min-h-6 max-w-full whitespace-normal wrap-anywhere"
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
                  runFocusAction('restore', event, () => editor.restore(version));
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
                  data-notification-focus="restore"
                >
                  {m.settings_notifications_restore()}
                </Button>
              </form>
            </div>
          </FieldGroup>
          {Object.keys(unavailable).length > 0 ? (
            <div className="space-y-3" role="group" aria-label={m.settings_notifications_retained()}>
              {Object.entries(unavailable).map(([kind, enabled]) => (
                <div key={kind} className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {m.settings_notifications_retained_unavailable({
                      name: notificationName(kind),
                      state:
                        enabled === null
                          ? m.settings_notifications_restore()
                          : enabled
                            ? m.settings_notifications_on()
                            : m.settings_notifications_off(),
                    })}
                  </p>
                  <Button
                    className={preferenceActionClassName}
                    type="button"
                    variant="outline"
                    disabled={busy || !hydrated}
                    onClick={() => editor.discardKind(kind)}
                  >
                    {m.settings_notifications_discard_choice()}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <div
            role="status"
            aria-live="polite"
            tabIndex={-1}
            data-notification-focus="status"
            className="min-h-5 text-sm text-muted-foreground"
          >
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
                {state.confirmedReceipt ? <p>{m.settings_notifications_confirmed_text()}</p> : null}
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
                  data-notification-focus="reload"
                  onClick={(event) => runFocusAction('reload', event, () => editor.reload())}
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
                  data-notification-focus="retry"
                  onClick={(event) => runFocusAction('retry', event, () => editor.retry())}
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
                    data-notification-focus="reload"
                    onClick={(event) => runFocusAction('reload', event, () => editor.reload())}
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
                  data-notification-focus="reload"
                  onClick={(event) => runFocusAction('reload', event, () => editor.reload())}
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
                    data-notification-focus="retry"
                    onClick={(event) => runFocusAction('retry', event, () => editor.retry())}
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
                      data-notification-focus="reload"
                      onClick={(event) => runFocusAction('reload', event, () => editor.reload())}
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
                {state.intent !== undefined && !reviewActionAllowed ? (
                  <p role="status">{m.settings_notifications_review_unavailable()}</p>
                ) : null}
                <div className="flex min-w-0 flex-wrap gap-2">
                  {state.intent !== undefined ? (
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      disabled={commandWaiting || disabled || !canSubmitReview}
                      aria-describedby={waitDescription}
                      data-notification-focus="apply"
                      onClick={(event) => runFocusAction('apply', event, () => editor.submit(version))}
                    >
                      {state.intent === null
                        ? m.settings_notifications_restore()
                        : m.settings_notifications_save_draft()}
                    </Button>
                  ) : null}
                  {!state.pending ? (
                    <Button
                      className={preferenceActionClassName}
                      type="button"
                      variant="outline"
                      data-notification-focus="keep-current"
                      onClick={(event) => runFocusAction('keep-current', event, () => editor.useCurrent())}
                    >
                      {m.settings_notifications_use_current()}
                    </Button>
                  ) : null}
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
              data-notification-focus="reload"
              onClick={(event) => runFocusAction('reload', event, () => editor.reload())}
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
      </ContentSectionBody>
    </ContentSection>
  );
}
