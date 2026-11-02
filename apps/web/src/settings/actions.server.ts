import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import {
  changeNotifications,
  loadSettingsPage,
  type NotificationChange,
  type NotificationPreferences,
} from './preferences';
import { m } from '../paraglide/messages.js';

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
  current?: NotificationPreferences,
  status = 200,
): Response {
  const fields: Record<string, string> = {
    csrf_token: token,
    expectedVersion: String(change.expectedVersion),
    action: change.notifications === null ? 'restore' : 'save',
    notificationRecovery: mode === 'confirmed' ? 'retry' : mode,
    idempotencyKey: change.idempotencyKey,
  };
  if (change.notifications !== null) {
    const [kind, enabled] = Object.entries(change.notifications)[0]!;
    fields.notificationKind = kind;
    if (enabled) fields.enabled = 'true';
  }
  const name = (kind: string) =>
    kind === 'reply'
      ? m.settings_notification_reply()
      : kind === 'mention'
        ? m.settings_notification_mention()
        : kind
            .split(/[_-]+/)
            .map((word) => word[0]!.toUpperCase() + word.slice(1))
            .join(' ');
  const values = (preferences: NotificationPreferences) =>
    `<ul>${Object.entries(preferences)
      .map(
        ([kind, enabled]) =>
          `<li>${escape(name(kind))}: ${escape(enabled ? m.settings_notifications_on() : m.settings_notifications_off())}</li>`,
      )
      .join('')}</ul>`;
  const intent =
    change.notifications === null
      ? `<p>${escape(m.settings_notifications_restore())}</p>`
      : values(change.notifications as NotificationPreferences);
  const title =
    mode === 'retry'
      ? m.settings_notifications_uncertain_title()
      : mode === 'confirmed'
        ? m.settings_notifications_review_title()
        : m.settings_failed_title();
  const help = mode === 'retry' ? m.settings_notifications_uncertain_text() : m.settings_notifications_retained();
  const button =
    mode === 'retry'
      ? m.settings_notifications_retry_original()
      : mode === 'review'
        ? m.settings_reload()
        : change.notifications === null
          ? m.settings_notifications_restore()
          : m.settings_notifications_save_draft();
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(m.settings_notifications_heading())}</title></head><body><main>
    <h1>${escape(m.settings_notifications_heading())}</h1><h2>${escape(title)}</h2><p>${escape(help)}</p>
    ${current ? values(current) : ''}${intent}<form method="post" action="${escape(new URL(request.url).pathname)}">
    ${Object.entries(fields)
      .map(([key, value]) => `<input type="hidden" name="${key}" value="${escape(value)}">`)
      .join('')}
    <button type="submit">${escape(button)}</button></form></main></body></html>`;
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store' },
  });
}

/** Handle the settings form's native POST before progressive enhancement is available. */
export async function submitNotificationForm(request: Request): Promise<Response> {
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
    (recovery.length && recovery[0] !== 'retry' && recovery[0] !== 'review') ||
    (keys.length &&
      (typeof keys[0] !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(keys[0])))
  )
    return redirect(true);

  let notifications: NotificationChange['notifications'];
  if (action[0] === 'restore' && kinds.length === 0 && enabled.length === 0) {
    notifications = null;
  } else if (
    action[0] === 'save' &&
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

  const change: NotificationChange = {
    expectedVersion: Number(expectedVersion[0]),
    notifications,
    idempotencyKey: typeof keys[0] === 'string' ? keys[0] : crypto.randomUUID(),
  };
  const token = form.get('csrf_token');
  if (typeof token !== 'string') return redirect(true);
  if (recovery[0] === 'review') {
    const page = await loadSettingsPage(kernelClient(), request, env as Partial<SessionEnv>);
    if (!page.signedIn) return recoveryPage(request, token, change, 'review', undefined, 403);
    if (!('preferences' in page) || !page.notifications || page.preferences.version < change.expectedVersion)
      return recoveryPage(request, token, change, 'review');
    return recoveryPage(
      request,
      token,
      {
        ...change,
        expectedVersion: page.preferences.version,
        idempotencyKey: crypto.randomUUID(),
      },
      'confirmed',
      page.notifications,
    );
  }
  const result = await changeNotifications(kernelClient(), request, env as Partial<SessionEnv>, change);
  if (!result.ok && result.reason === 'forbidden')
    return recoveryPage(request, token, change, recovery[0] === 'retry' ? 'retry' : 'review', undefined, 403);
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
  return redirect(false);
}
