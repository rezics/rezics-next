import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  changeNotifications,
  loadSettingsPage,
  optionalNotifications,
  parseNotificationChange,
  type NotificationChange,
  type NotificationPatch,
  type PreferencePage,
} from './preferences';
import { createServerSettingsAmbient } from './adapters/ambient';
import { notificationOriginalAllowed } from './notification-recovery';
import { m } from '../paraglide/messages.js';
import { settingsMediaFailure } from './adapters/content';

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );

/** A native failure retains the operation in the response body, never in a URL or browser storage. */
function recoveryPage(
  request: Request,
  token: string,
  change: NotificationChange,
  mode: 'retry' | 'review' | 'confirmed',
  context: { current?: PreferencePage; confirmedVersion?: number | undefined; status?: number } = {},
): Response {
  const fields: Record<string, string> = {
    csrf_token: token,
    expectedVersion: String(change.expectedVersion),
    action: change.notifications === null ? 'restore' : 'save',
    notificationRecovery: mode,
    idempotencyKey: change.idempotencyKey,
  };
  if (change.notifications !== null) {
    fields.notificationPatch = JSON.stringify(change.notifications);
  }
  if (context.confirmedVersion !== undefined) fields.confirmedVersion = String(context.confirmedVersion);
  const name = (kind: string) =>
    kind === 'reply'
      ? m.settings_notification_reply()
      : kind === 'mention'
        ? m.settings_notification_mention()
        : kind === 'thread_watch'
          ? m.settings_notification_thread_watch()
          : kind === 'board_activity'
            ? m.settings_notification_board_activity()
            : kind === 'moderation_decision'
              ? m.settings_notification_moderation_decision()
              : kind;
  const values = (preferences: Exclude<NotificationPatch, null>) =>
    `<ul>${Object.entries(preferences)
      .map(
        ([kind, enabled]) =>
          `<li>${escape(name(kind))}: ${escape(enabled === null ? m.settings_notifications_restore() : enabled ? m.settings_notifications_on() : m.settings_notifications_off())}</li>`,
      )
      .join('')}</ul>`;
  const intent =
    change.notifications === null
      ? `<p>${escape(m.settings_notifications_restore())}</p>`
      : values(change.notifications);
  const title =
    mode === 'retry'
      ? m.settings_notifications_uncertain_title()
      : mode === 'confirmed'
        ? m.settings_saved()
        : m.settings_failed_title();
  const help =
    mode === 'retry'
      ? m.settings_notifications_uncertain_text()
      : mode === 'confirmed'
        ? m.settings_notifications_read_failed()
        : m.settings_notifications_retained();
  const button =
    mode === 'retry'
      ? m.settings_notifications_retry_original()
      : change.notifications === null
        ? m.settings_notifications_restore()
        : m.settings_notifications_save_draft();
  const admitted = notificationOriginalAllowed(change, context.current ?? null);
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(m.settings_notifications_heading())}</title></head><body><main>
    <h1>${escape(m.settings_notifications_heading())}</h1><h2>${escape(title)}</h2><p>${escape(help)}</p>
    ${context.current ? values(optionalNotifications(context.current)) : ''}${mode === 'confirmed' ? '' : intent}
    ${mode !== 'confirmed' && !admitted ? `<p>${escape(m.settings_notifications_review_unavailable())}</p>` : ''}
    <form method="post" action="${escape(new URL(request.url).pathname)}">
    ${Object.entries(fields)
      .map(([key, value]) => `<input type="hidden" name="${key}" value="${escape(value)}">`)
      .join('')}
    <button type="submit" name="notificationStep" value="read">${escape(m.settings_reload())}</button>
    ${mode === 'confirmed' ? '' : `<button type="submit" name="notificationStep" value="send"${admitted ? '' : ' disabled'}>${escape(button)}</button>`}
    </form><a href="${escape(new URL(request.url).pathname)}#notifications">${escape(m.settings_notifications_heading())}</a></main></body></html>`;
  return new Response(body, {
    status: context.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

/** Handle the settings form's native POST before progressive enhancement is available. */
export async function submitNotificationForm(request: Request): Promise<Response> {
  const id = createServerSettingsAmbient().id;
  const redirect = (failed: boolean) => {
    const url = new URL(request.url);
    url.search = failed ? '?notificationError=1' : '';
    url.hash = '';
    return new Response(null, {
      status: 303,
      headers: { location: url.href, 'cache-control': 'private, no-store' },
    });
  };
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded')
    return new Response(null, { status: 400, headers: { 'cache-control': 'private, no-store' } });

  let form: FormData;
  try {
    form = await request.clone().formData();
  } catch {
    return redirect(true);
  }
  const action = form.getAll('action');
  const expectedVersion = form.getAll('expectedVersion');
  const kinds = form.getAll('notificationKind');
  const enabled = form.getAll('enabled');
  const recovery = form.getAll('notificationRecovery');
  const keys = form.getAll('idempotencyKey');
  const patches = form.getAll('notificationPatch');
  const steps = form.getAll('notificationStep');
  const receipts = form.getAll('confirmedVersion');
  if (
    action.length !== 1 ||
    expectedVersion.length !== 1 ||
    typeof expectedVersion[0] !== 'string' ||
    !/^\d+$/.test(expectedVersion[0]) ||
    !Number.isSafeInteger(Number(expectedVersion[0]))
  )
    return redirect(true);
  if (
    recovery.length > 1 ||
    keys.length > 1 ||
    Boolean(recovery.length) !== Boolean(keys.length) ||
    (recovery.length && recovery[0] !== 'retry' && recovery[0] !== 'review' && recovery[0] !== 'confirmed') ||
    patches.length > 1 ||
    steps.length > 1 ||
    receipts.length > 1 ||
    (steps.length && steps[0] !== 'read' && steps[0] !== 'send') ||
    (!recovery.length && (patches.length > 0 || steps.length > 0 || receipts.length > 0)) ||
    (recovery[0] === 'confirmed'
      ? receipts.length !== 1 ||
        typeof receipts[0] !== 'string' ||
        !/^\d+$/.test(receipts[0]) ||
        !Number.isSafeInteger(Number(receipts[0])) ||
        Number(receipts[0]) < Number(expectedVersion[0])
      : receipts.length > 0) ||
    (keys.length &&
      (typeof keys[0] !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(keys[0])))
  )
    return redirect(true);

  let notifications: NotificationChange['notifications'];
  if (action[0] === 'restore' && kinds.length === 0 && enabled.length === 0 && patches.length === 0) {
    notifications = null;
  } else if (
    action[0] === 'save' &&
    recovery.length === 1 &&
    patches.length === 1 &&
    typeof patches[0] === 'string' &&
    kinds.length === 0 &&
    enabled.length === 0
  ) {
    try {
      notifications = JSON.parse(patches[0]);
    } catch {
      return redirect(true);
    }
    if (notifications === null) return redirect(true);
  } else if (
    action[0] === 'save' &&
    patches.length === 0 &&
    kinds.length === 1 &&
    typeof kinds[0] === 'string' &&
    /^[a-z][a-z0-9_]*$/.test(kinds[0]) &&
    enabled.length <= 1 &&
    (enabled.length === 0 || enabled[0] === 'true')
  ) {
    notifications = { [kinds[0]]: enabled.length === 1 };
  } else {
    return redirect(true);
  }

  const change = parseNotificationChange({
    expectedVersion: Number(expectedVersion[0]),
    notifications,
    idempotencyKey: typeof keys[0] === 'string' ? keys[0] : id(),
  });
  if (!change) return redirect(true);
  const token = form.get('csrf_token');
  if (typeof token !== 'string') return redirect(true);
  if (recovery.length) {
    const mode = recovery[0] as 'retry' | 'review' | 'confirmed';
    const confirmedVersion = mode === 'confirmed' ? Number(receipts[0]) : undefined;
    const confirmed = confirmedVersion === undefined ? {} : { confirmedVersion };
    const page = await loadSettingsPage(kernelClient(), request, env as Partial<SessionEnv>, {
      mediaFailure: settingsMediaFailure,
    });
    if (!page.signedIn) return recoveryPage(request, token, change, mode, { ...confirmed, status: 403 });
    if (
      !('preferences' in page) ||
      !page.page ||
      !page.notifications ||
      page.preferences.version < (confirmedVersion ?? change.expectedVersion)
    )
      return recoveryPage(request, token, change, mode, confirmed);
    if (mode === 'confirmed') return redirect(false);
    const admitted = notificationOriginalAllowed(change, page.page);
    // An unresolved retry never borrows a new version or key from a current read.
    const reviewed =
      mode === 'review' && admitted
        ? { ...change, expectedVersion: page.preferences.version, idempotencyKey: id() }
        : change;
    if (steps[0] !== 'send' || !admitted || (mode === 'review' && change.expectedVersion !== reviewed.expectedVersion))
      return recoveryPage(request, token, reviewed, mode, { current: page.page });
  }
  const result = await changeNotifications(
    kernelClient(),
    request,
    env as Partial<SessionEnv>,
    change,
    settingsMediaFailure,
  );
  if (!result.ok && result.reason === 'forbidden')
    return recoveryPage(request, token, change, recovery[0] === 'retry' ? 'retry' : 'review', { status: 403 });
  if (!result.ok)
    return recoveryPage(
      request,
      token,
      change,
      result.reason === 'unavailable' ||
        result.reason === 'preparing' ||
        (recovery[0] === 'retry' && result.reason !== 'conflict')
        ? 'retry'
        : 'review',
    );
  if (recovery[0] === 'retry') {
    const page = await loadSettingsPage(kernelClient(), request, env as Partial<SessionEnv>, {
      mediaFailure: settingsMediaFailure,
    });
    if (!page.signedIn || !('preferences' in page) || !page.page || page.preferences.version < result.version)
      return recoveryPage(request, token, change, 'confirmed', { confirmedVersion: result.version });
  }
  return redirect(false);
}
